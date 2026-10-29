import {
  LISTING_BATCH_SWITCH,
  LISTING_UPDATE_SWITCH,
  PRICING_AUTO_SWITCH,
  PRICING_UPDATE_SWITCH,
  buildListingsFeed,
  listingAmazonPatches,
  priceAmazonPatches,
  type ListingBatchItem,
  type ListingPatchInput,
} from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, WORKFLOW_KINDS, type WorkflowDefinition, type WriteRunIntent } from '@nova/workflow'
import { Prisma, type ListingWriteRun } from '@prisma/client'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { FeedsApi, LISTINGS_FEED_TYPE } from '../connectors/feeds-api'
import { ListingsApi, isListingsRejected } from '../connectors/listings-api'
import { hasErrorIssue, parsePatchResponse } from '../importers/listings/write-parse'
import { isPriceKind, priceBodyOf, recordPriceSuccess } from './price-write'
import type { WriteWorkflowDeps } from './workflows'

// 刊登写入流程（P4-10，05 章 5.4）：修改刊登（patchListingsItem，正式提交）与批量刊登任务（Feeds API 提交输入文件）。
// 先记录意图 → 调用亚马逊 → 回写；崩溃或超时后：
//   - 修改刊登：亚马逊的局部修改是“把属性设成给定值”，重复提交结果相同，不需要对账；
//   - 批量任务：创建任务后立刻把亚马逊的任务编号写回记录（同一个步骤里），重放时看到编号就沿用，不会重复提交；
//     只有“亚马逊已建任务、编号还没写回”这一个极短的窗口内崩溃才可能重复提交，重复提交的是同样的“设置属性”消息，不会造成不同结果（CR-085 披露）。
// 校验预览与刊登限制查询不改亚马逊的数据，不走这个流程（见 connectors/listing-dispatch.ts）。
// 批量任务提交后的处理结果由任务运行时的轮询（返回 pending）取回，不在这个流程里等待。

type Intent = WriteRunIntent
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
export const LISTING_SWITCH_OF: Record<string, string> = { PATCH: LISTING_UPDATE_SWITCH, BATCH: LISTING_BATCH_SWITCH, PRICE_PATCH: PRICING_UPDATE_SWITCH }

/** 要发给亚马逊的修改内容：改价（PRICE_*）按价格生成，刊登修改按属性生成；内容不完整返回空数组。 */
export function amazonPatchesOf(kind: string, body: Record<string, unknown>) {
  if (!isPriceKind(kind)) return listingAmazonPatches(patchesOf(body))
  const price = priceBodyOf(body)
  return price ? priceAmazonPatches(price.price, price.currency) : []
}

/** 写入记录里的请求内容（接口服务写入时已校验，这里再兜底解析）。 */
export function patchesOf(body: Record<string, unknown>): ListingPatchInput[] {
  return (Array.isArray(body.patches) ? body.patches : []).map(item => {
    const patch = record(item)
    return {
      op: patch.op === 'delete' ? 'delete' : 'replace',
      attribute: String(patch.attribute ?? ''),
      values: Array.isArray(patch.values) ? patch.values.map(String) : undefined,
      languageTag: typeof patch.languageTag === 'string' ? patch.languageTag : undefined,
    }
  })
}
export function batchItemsOf(body: Record<string, unknown>): Array<ListingBatchItem & { productType: string }> {
  return (Array.isArray(body.items) ? body.items : []).map(item => {
    const row = record(item)
    return { sku: String(row.sku ?? ''), productType: String(row.productType ?? ''), patches: patchesOf(row) }
  })
}

/** 提交成功后：这个商品里属性被修改的未解决问题（以及搜索抑制类）标为“处理中”，同步器发现问题消失后再写“已解决”。 */
export async function markIssuesInProgress(tx: Prisma.TransactionClient, run: Pick<ListingWriteRun, 'id' | 'tenantId' | 'sellerAccountId'>, sku: string, attributes: readonly string[]): Promise<void> {
  await tx.listingIssue.updateMany({
    where: {
      tenantId: run.tenantId,
      sellerAccountId: run.sellerAccountId,
      sellerSku: sku,
      resolvedAt: null,
      OR: [{ attributeName: { in: [...attributes] } }, { issueKind: 'SEARCH_SUPPRESSED' }],
    },
    data: { handlingStatus: 'IN_PROGRESS', handlingRunId: run.id, version: { increment: 1 } },
  })
}

export function createListingWriteWorkflow(deps: WriteWorkflowDeps): WorkflowDefinition<Intent> {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)

  const loadRun = async (tenantId: string, id: string | undefined) => {
    const row = id ? await inTenant(tenantId, () => deps.prisma.listingWriteRun.findFirst({ where: { id, tenantId } })) : null
    if (!row) throw new NonRetryableError('LISTING_RUN_NOT_FOUND', '刊登写入记录不存在')
    return row
  }

  /** 调用亚马逊前再确认一次开关（受理之后开关可能已被关闭或自动关闭）。 */
  const switchOn = (tenantId: string, key: string) =>
    inTenant(tenantId, () => deps.prisma.integrationSwitch.findFirst({ where: { tenantId, switchKey: key, sellerAccountId: null, enabled: true }, select: { id: true } }))
  const assertSwitchOn = async (tenantId: string, run: ListingWriteRun) => {
    const key = LISTING_SWITCH_OF[run.kind]
    if (!key || !(await switchOn(tenantId, key))) throw new NonRetryableError('SWITCH_DISABLED', '刊登写入开关已关闭，未向亚马逊发出请求')
    // 规则自动改价还要求“规则自动执行”开关处于打开状态（受理之后它可能已被关闭或因熔断自动关闭）
    if (isPriceKind(run.kind) && priceBodyOf(run.requestJson)?.source === 'RULE_AUTO' && !(await switchOn(tenantId, PRICING_AUTO_SWITCH)))
      throw new NonRetryableError('SWITCH_DISABLED', '定价规则自动执行开关已关闭，未向亚马逊发出请求')
  }

  const clientOf = (intent: Intent, run: ListingWriteRun) =>
    inTenant(intent.tenantId, async () => {
      const [connection, seller] = await Promise.all([
        deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } }),
        deps.prisma.sellerAccount.findFirst({ where: { id: run.sellerAccountId, tenantId: intent.tenantId }, select: { sellerId: true } }),
      ])
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '店铺授权不存在，无法调用亚马逊')
      if (!seller?.sellerId) throw new NonRetryableError('SELLER_ID_MISSING', '店铺没有亚马逊卖家编号，无法调用刊登接口')
      return { client: new AmazonSpApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId)), sellerId: seller.sellerId }
    })

  async function callAmazon(intent: Intent, run: ListingWriteRun): Promise<Record<string, unknown>> {
    if (run.status === 'SUCCEEDED' || (run.kind === 'BATCH' && run.feedId)) return { done: true, feedId: run.feedId } // 已经提交过：不再调用
    await assertSwitchOn(intent.tenantId, run)
    const { client, sellerId } = await clientOf(intent, run)
    await inTenant(intent.tenantId, () =>
      deps.prisma.listingWriteRun.updateMany({
        where: { id: run.id, tenantId: run.tenantId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'RUNNING', failureCode: null, finishedAt: null },
      }),
    )
    const body = record(run.requestJson)
    try {
      if (run.kind === 'PATCH' || run.kind === 'PRICE_PATCH') {
        const patches = amazonPatchesOf(run.kind, body)
        if (!run.sellerSku || !run.productType || patches.length === 0) throw new NonRetryableError('LISTING_REQUEST_INVALID', '修改内容不完整')
        const response = parsePatchResponse(await new ListingsApi(client, sellerId).patch(run.sellerSku, { productType: run.productType, patches }, false))
        if (response.status === null) throw new NonRetryableError('LISTING_RESPONSE_UNRECOGNIZED', '亚马逊的响应无法识别，请在亚马逊后台核对这次修改是否生效')
        if (response.status === 'INVALID' || hasErrorIssue(response.issues)) {
          await inTenant(intent.tenantId, () =>
            deps.prisma.listingWriteRun.updateMany({ where: { id: run.id, tenantId: run.tenantId }, data: { issuesJson: response.issues as unknown as Prisma.InputJsonValue } }),
          )
          throw new NonRetryableError('LISTING_REQUEST_REJECTED', '亚马逊拒绝了这次修改')
        }
        return { submissionId: response.submissionId, issues: response.issues }
      }
      const items = batchItemsOf(body)
      if (items.length === 0 || items.some(item => !item.sku || !item.productType || item.patches.length === 0)) throw new NonRetryableError('LISTING_REQUEST_INVALID', '批量任务的内容不完整')
      const submitted = await new FeedsApi(client).submit(LISTINGS_FEED_TYPE, JSON.stringify(buildListingsFeed({ sellerId, items })))
      // 同一步骤里立刻写回任务编号：重放时看到编号就沿用，不会重复提交
      await inTenant(intent.tenantId, () =>
        deps.prisma.listingWriteRun.updateMany({ where: { id: run.id, tenantId: run.tenantId }, data: { feedId: submitted.feedId, feedDocumentId: submitted.feedDocumentId, status: 'SUBMITTED' } }),
      )
      return { feedId: submitted.feedId }
    } catch (error) {
      if (isListingsRejected(error)) throw new NonRetryableError('LISTING_REQUEST_REJECTED', '亚马逊拒绝了这次请求')
      throw error
    }
  }

  async function recordSuccess(run: ListingWriteRun, issues: unknown, now: Date): Promise<void> {
    if (run.kind === 'PRICE_PATCH') return recordPriceSuccess(deps.prisma, run, now)
    if (run.kind !== 'PATCH') return // 批量任务提交后的结果由轮询回写
    const attributes = patchesOf(record(run.requestJson)).map(patch => patch.attribute)
    await deps.prisma.$transaction(async tx => {
      const claimed = await tx.listingWriteRun.updateMany({
        where: { id: run.id, tenantId: run.tenantId, status: { not: 'SUCCEEDED' } },
        data: { status: 'SUCCEEDED', failureCode: null, finishedAt: now, issuesJson: (Array.isArray(issues) ? issues : []) as Prisma.InputJsonValue },
      })
      if (claimed.count === 0 || !run.sellerSku) return // 已经回写过（流程重放）
      await markIssuesInProgress(tx, run, run.sellerSku, attributes)
    })
  }

  return {
    kind: WORKFLOW_KINDS.LISTING_WRITE,
    steps: [
      {
        name: '向亚马逊提交刊登修改',
        buildRequest: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.listingRunId)
          return { listingRunId: run.id, kind: run.kind, requestedAt: new Date().toISOString() }
        },
        run: async ctx => callAmazon(ctx.intent, await loadRun(ctx.tenantId, ctx.intent.listingRunId)),
        reconcile: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.listingRunId)
          if (run.status === 'SUCCEEDED') return { found: true, response: { done: true } }
          if (run.kind === 'BATCH' && run.feedId) return { found: true, response: { done: true, feedId: run.feedId } }
          return { found: false } // 修改刊登可以直接重新提交（结果相同）；批量任务没有编号说明没建成（或落在披露的极短窗口里）
        },
      },
      {
        name: '回写刊登写入结果',
        run: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.listingRunId)
          const response = record(ctx.responseOf(0))
          await inTenant(ctx.tenantId, () => recordSuccess(run, response.issues, new Date()))
          return { listingRunId: run.id }
        },
      },
    ],
  }
}
