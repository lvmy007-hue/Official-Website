import { LISTING_RESTRICTION_TTL_MS, LISTING_WRITE_JOB, LISTING_WRITE_LIMITS } from '@nova/api-contracts'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import type { Prisma, PrismaClient } from '@prisma/client'
import { LISTING_SWITCH_OF, amazonPatchesOf, batchItemsOf, markIssuesInProgress } from '../runtime/listing-write-workflow'
import { markPriceRunFailed } from '../runtime/price-write'
import { recordSwitchOutcome } from '../platform/switch-outcome'
import { runWriteWorkflow } from '../runtime/workflows'
import type { SyncPayload } from '../types'
import { hasErrorIssue, parseFeedResult, parsePatchResponse, parseRestrictions, type RestrictionRow } from '../importers/listings/write-parse'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { FeedsApi } from './feeds-api'
import { ListingsApi, isListingsRejected } from './listings-api'
import type { ProductionDeps, ProductionRun } from './dispatch'

// 刊登写入与查询任务分发（P4-10）：任务类型 LISTING_WRITE，一条任务对应一条 ListingWriteRun，按记录的 kind 分四种：
//   VALIDATE      校验预览（patchListingsItem 的 VALIDATION_PREVIEW 模式）：不改亚马逊的数据，不走写流程、不计开关的失败次数；结果写回记录，通过的预览 30 分钟内可用来提交；
//   RESTRICTIONS  刊登限制查询（逐个 ASIN）：只读；结果写回记录并带 1 小时的有效期；
//   PATCH         修改刊登：走写流程（runtime/listing-write-workflow.ts），开关 sw.listing.update；
//   BATCH         批量刊登任务：走写流程提交输入文件，开关 sw.feeds.batch；提交后返回 pending，由任务运行时每 30 秒回来查一次处理结果（payload.poll）。
// 任务与刊登同步同属 general 域、同店铺互斥（读写不并发）。永久失败的处置在 markListingRunFailed。

export const LISTING_JOB_TYPES: readonly string[] = [LISTING_WRITE_JOB]
const json = (value: unknown) => value as Prisma.InputJsonValue
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export async function processListingWrite(
  deps: ProductionDeps,
  client: AmazonSpApiClient,
  row: { tenantId: string; connection: { id: string } },
  sellerAccountId: string,
  payload: SyncPayload,
  run: ProductionRun,
) {
  const { prisma, reliability, writeWorkflows } = deps
  if (!payload.listingRunId) throw new NonRetryableError('LISTING_RUN_CONTEXT_MISSING', '任务缺少刊登写入记录编号')
  const record_ = await prisma.listingWriteRun.findFirst({ where: { id: payload.listingRunId, tenantId: row.tenantId } })
  if (!record_) throw new NonRetryableError('LISTING_RUN_NOT_FOUND', '刊登写入记录不存在')
  const seller = await prisma.sellerAccount.findFirst({ where: { id: sellerAccountId, tenantId: row.tenantId }, select: { sellerId: true } })
  if (!seller?.sellerId) throw new NonRetryableError('SELLER_ID_MISSING', '店铺没有亚马逊卖家编号，无法调用刊登接口')
  const api = new ListingsApi(client, seller.sellerId)
  if (record_.kind === 'VALIDATE' || record_.kind === 'PRICE_VALIDATE') return validate(prisma, api, record_)
  if (record_.kind === 'RESTRICTIONS') return restrictions(prisma, api, record_)
  if (payload.poll && record_.kind === 'BATCH') return pollFeed(deps, new FeedsApi(client), record_)
  const result = await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.listingWrite, {
    tenantId: row.tenantId,
    dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.LISTING_WRITE, record_.id, run.jobId),
    syncJobId: payload.syncJobId,
    priority: run.priority,
    lease: run.lease,
    isLastAttempt: run.isLastAttempt,
    owner: `${reliability.ownerId}:${run.jobId}`,
    intent: { tenantId: row.tenantId, connectionId: row.connection.id, listingRunId: record_.id },
  })
  const switchKey = LISTING_SWITCH_OF[record_.kind]
  if (switchKey) await recordSwitchOutcome(prisma, row.tenantId, switchKey, { success: true }).catch(() => undefined) // 登记失败不影响写入结果
  return record_.kind === 'BATCH' ? { pending: true, feedId: record(result).feedId ?? null } : result
}

async function validate(prisma: PrismaClient, api: ListingsApi, run: { id: string; tenantId: string; kind: string; sellerSku: string | null; productType: string | null; requestJson: unknown }) {
  const patches = amazonPatchesOf(run.kind, record(run.requestJson))
  if (!run.sellerSku || !run.productType || patches.length === 0) throw new NonRetryableError('LISTING_REQUEST_INVALID', '校验内容不完整')
  await prisma.listingWriteRun.updateMany({ where: { id: run.id, tenantId: run.tenantId }, data: { status: 'RUNNING', failureCode: null } })
  let response
  try {
    response = parsePatchResponse(await api.patch(run.sellerSku, { productType: run.productType, patches }, true))
  } catch (error) {
    if (isListingsRejected(error)) throw new NonRetryableError('LISTING_REQUEST_REJECTED', '亚马逊拒绝了这次校验请求')
    throw error
  }
  if (response.status === null) throw new NonRetryableError('LISTING_RESPONSE_UNRECOGNIZED', '亚马逊的校验响应无法识别')
  const valid = response.status === 'VALID' && !hasErrorIssue(response.issues)
  const now = new Date()
  await prisma.listingWriteRun.updateMany({
    where: { id: run.id, tenantId: run.tenantId },
    data: {
      status: 'SUCCEEDED',
      validation: valid ? 'VALID' : 'INVALID',
      issuesJson: json(response.issues),
      finishedAt: now,
      expiresAt: valid ? new Date(now.getTime() + LISTING_WRITE_LIMITS.previewTtlMs) : null,
    },
  })
  return { validation: valid ? 'VALID' : 'INVALID', issues: response.issues.length }
}

async function restrictions(prisma: PrismaClient, api: ListingsApi, run: { id: string; tenantId: string; requestJson: unknown }) {
  const asins = (Array.isArray(record(run.requestJson).asins) ? (record(run.requestJson).asins as unknown[]) : []).map(String).slice(0, LISTING_WRITE_LIMITS.restrictionsAsinsMax)
  if (asins.length === 0) throw new NonRetryableError('LISTING_REQUEST_INVALID', '没有要查询的 ASIN')
  const condition = String(record(run.requestJson).conditionType ?? 'new_new')
  await prisma.listingWriteRun.updateMany({ where: { id: run.id, tenantId: run.tenantId }, data: { status: 'RUNNING', failureCode: null } })
  const rows: RestrictionRow[] = []
  for (const asin of asins) {
    try {
      rows.push(parseRestrictions(asin, await api.restrictions(asin, condition)))
    } catch (error) {
      if (!isListingsRejected(error)) throw error // 403、429、5xx 交给任务运行时分类；ASIN 不存在等请求被拒的只记这一行
      rows.push({ asin, restricted: false, reasons: [], error: 'ASIN_NOT_FOUND' })
    }
  }
  const now = new Date()
  await prisma.listingWriteRun.updateMany({
    where: { id: run.id, tenantId: run.tenantId },
    data: { status: 'SUCCEEDED', resultJson: json({ rows, checkedAt: now.toISOString() }), itemCount: rows.length, finishedAt: now, expiresAt: new Date(now.getTime() + LISTING_RESTRICTION_TTL_MS) },
  })
  return { checked: rows.length, restricted: rows.filter(item => item.restricted).length }
}

/** 批量任务的处理结果：未处理完返回 pending（运行时 30 秒后再来）；处理完写逐个商品的结果；致命、取消或超过轮询上限以不可重试错误结束。 */
async function pollFeed(
  deps: ProductionDeps,
  feeds: FeedsApi,
  run: { id: string; tenantId: string; sellerAccountId: string; feedId: string | null; pollCount: number; requestJson: unknown; status: string },
) {
  const { prisma } = deps
  if (['SUCCEEDED', 'PARTIAL', 'FAILED'].includes(run.status)) return { done: true }
  if (!run.feedId) throw new NonRetryableError('FEED_ID_MISSING', '批量任务没有亚马逊任务编号')
  const status = await feeds.status(run.feedId)
  if (status.processingStatus === 'CANCELLED' || status.processingStatus === 'FATAL')
    throw new NonRetryableError('FEED_FATAL', `批量任务处理${status.processingStatus === 'FATAL' ? '失败' : '被取消'}`)
  if (status.processingStatus !== 'DONE') {
    if (run.pollCount + 1 >= LISTING_WRITE_LIMITS.feedPollMax) throw new NonRetryableError('FEED_TIMEOUT', '批量任务长时间没有处理完成')
    await prisma.listingWriteRun.updateMany({ where: { id: run.id, tenantId: run.tenantId }, data: { status: 'PROCESSING', pollCount: { increment: 1 } } })
    return { pending: true, feedId: run.feedId }
  }
  const items = batchItemsOf(record(run.requestJson))
  let rows
  if (status.resultFeedDocumentId)
    rows = parseFeedResult(
      await feeds.result(status.resultFeedDocumentId),
      items.map(item => item.sku),
    )
  else throw new NonRetryableError('FEED_RESULT_MISSING', '批量任务已处理完成，但没有返回结果文件')
  const ok = rows.filter(item => item.ok).length
  const now = new Date()
  const finalStatus = ok === rows.length ? 'SUCCEEDED' : ok === 0 ? 'FAILED' : 'PARTIAL'
  await prisma.$transaction(async tx => {
    const claimed = await tx.listingWriteRun.updateMany({
      where: { id: run.id, tenantId: run.tenantId, status: { notIn: ['SUCCEEDED', 'PARTIAL', 'FAILED'] } },
      data: {
        status: finalStatus,
        resultJson: json({ rows: rows.slice(0, LISTING_WRITE_LIMITS.runRowsMax), accepted: ok, invalid: rows.length - ok }),
        finishedAt: now,
        failureCode: finalStatus === 'FAILED' ? 'LISTING_REQUEST_REJECTED' : null,
      },
    })
    if (claimed.count === 0) return
    for (const [index, item] of rows.entries()) {
      if (item.ok) await markIssuesInProgress(tx, { id: run.id, tenantId: run.tenantId, sellerAccountId: run.sellerAccountId }, item.sku, items[index]?.patches.map(patch => patch.attribute) ?? [])
    }
  })
  return { done: true, accepted: ok, invalid: rows.length - ok }
}

const CALL_FAILURE = /^SP_API_/
const AUTH_FAILURE = /^SP_API_(401|403)_/

/** 失败码只留“来源 + 状态码”（SP_API_400）：亚马逊返回的原文不进写入记录。 */
export function shortListingCode(code: string): string {
  return /^SP_API_\d{3}/.exec(code)?.[0] ?? code.slice(0, 60)
}

/**
 * 永久失败后的处置（由监听器在任务进入死信时调用）：写入记录标为失败并记下原因，页面不再显示“排队中”“处理中”；已经有结论的记录不改。
 * 只有真正调用了亚马逊写接口（修改、批量）的失败才计入开关的连续失败次数；校验预览与限制查询不计。
 */
export async function markListingRunFailed(db: PrismaClient, tenantId: string, payload: SyncPayload, failureCode: string): Promise<void> {
  if (!payload.listingRunId) return
  const run = await db.listingWriteRun.findFirst({ where: { id: payload.listingRunId, tenantId }, select: { id: true, kind: true } })
  if (!run) return
  const code = shortListingCode(failureCode)
  await db.listingWriteRun.updateMany({ where: { id: run.id, tenantId, status: { notIn: ['SUCCEEDED', 'PARTIAL', 'FAILED'] } }, data: { status: 'FAILED', failureCode: code, finishedAt: new Date() } })
  if (run.kind === 'PRICE_PATCH') await markPriceRunFailed(db, tenantId, run.id, code)
  const switchKey = LISTING_SWITCH_OF[run.kind]
  if (switchKey && CALL_FAILURE.test(failureCode)) {
    await recordSwitchOutcome(db, tenantId, switchKey, { success: false, errorCode: failureCode.slice(0, 40), authInvalid: AUTH_FAILURE.test(failureCode) }).catch(() => undefined)
  }
}
