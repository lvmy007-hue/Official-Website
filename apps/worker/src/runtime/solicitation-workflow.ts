import { REVIEWS_LIMITS, SOLICITATION_SWITCH_KEY, solicitationWindowOf, type SolicitationStatus } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, WORKFLOW_KINDS, type WorkflowDefinition, type WriteRunIntent } from '@nova/workflow'
import type { SolicitationRequest } from '@prisma/client'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { SolicitationsApi, hasReviewAction, isAlreadySolicited, isSolicitationRejected } from '../connectors/solicitations-api'
import type { WriteWorkflowDeps } from './workflows'

// 请求评价的写操作流程（P4-13，importers.md I-16）：一批订单一个流程，单步骤“向亚马逊逐单请求评价”。
// 每一单：先查亚马逊当前允许的动作；没有“请求产品评价与卖家反馈”动作就不发请求（超出送达后第 5 至 30 天窗口记“已过请求期限”，其余记“亚马逊不允许请求”）；有动作才发请求。
// 每单处理完立刻更新那一行（不等整批结束）：429、5xx 与网络错误向上抛让流程重试，已处理的订单状态已经落库，重试只处理仍为 QUEUED 的行，所以不会重复请求。
// 亚马逊对 4xx 的说明：报“已经请求过”的算已发送（REQUESTED，failureCode 留 SOL_ALREADY_SENT）；401 / 403 是授权问题，这一单记失败后整批立即停止（不再逐单撞同一个错误）；其余 4xx 只记这一单失败。
// 已知缺口：崩溃发生在“亚马逊已受理、还没把这一单更新为已请求”之间时，重试查询动作会发现该动作已不可用，这一单记为“亚马逊不允许请求”而不是“已请求”（亚马逊没有按订单查历史请求的操作，无法对账）。
// 意图只记批次编号与订单数，不含订单明细；失败原因只留“来源 + 状态码”，亚马逊返回的原文不入库。

export const SOLICITATION_SEND = WORKFLOW_KINDS.SOLICITATION_SEND
type Intent = WriteRunIntent
type Row = SolicitationRequest
type Settled = Exclude<SolicitationStatus, 'QUEUED'>
interface Outcome {
  status: Settled
  failureCode: string | null
}

export function createSolicitationWorkflow(deps: WriteWorkflowDeps): WorkflowDefinition<Intent> {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const needBatch = (intent: Intent): string => {
    if (!intent.solicitationBatchId) throw new NonRetryableError('SOLICITATION_BATCH_MISSING', '请求评价任务缺少批次编号')
    return intent.solicitationBatchId
  }
  /** 调用亚马逊前再确认一次写入开关（接口受理之后开关可能已被关闭或自动关闭）。 */
  const assertSwitchOn = async (tenantId: string) => {
    const on = await inTenant(tenantId, () =>
      deps.prisma.integrationSwitch.findFirst({ where: { tenantId, switchKey: SOLICITATION_SWITCH_KEY, sellerAccountId: null, enabled: true }, select: { id: true } }),
    )
    if (!on) throw new NonRetryableError('SWITCH_DISABLED', '请求评价的写入开关已关闭，未向亚马逊发出请求')
  }
  const connectionOf = (intent: Intent) =>
    inTenant(intent.tenantId, async () => {
      const connection = await deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } })
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '店铺授权不存在，无法调用亚马逊')
      return connection
    })
  /** 订单最晚一个包裹的送达时间；取不到为 null。 */
  const deliveredAtOf = async (row: Row): Promise<Date | null> => {
    const found = await inTenant(row.tenantId, () =>
      deps.prisma.orderPackage.findFirst({
        where: { tenantId: row.tenantId, sellerAccountId: row.sellerAccountId, deliveredAt: { not: null }, order: { amazonOrderId: row.amazonOrderId } },
        orderBy: { deliveredAt: 'desc' },
        select: { deliveredAt: true },
      }),
    )
    return found?.deliveredAt ?? null
  }

  /** 决定一单的结果。限速、5xx 与网络错误直接抛出；授权失败（401 / 403）在记下这一单之后由调用方终止整批。 */
  async function decide(api: SolicitationsApi, row: Row, now: Date): Promise<Outcome & { authFailure?: number }> {
    const rejected = (error: unknown): Outcome & { authFailure?: number } => {
      if (!isSolicitationRejected(error)) throw error
      return { status: 'FAILED', failureCode: `SP_API_${error.status}`, ...(error.status === 401 || error.status === 403 ? { authFailure: error.status } : {}) }
    }
    let allowed: boolean
    try {
      allowed = hasReviewAction(await api.getActions(row.amazonOrderId))
    } catch (error) {
      return rejected(error)
    }
    if (!allowed) {
      const deliveredAt = await deliveredAtOf(row)
      const closed = deliveredAt !== null && solicitationWindowOf(deliveredAt, now).state === 'CLOSED'
      return { status: closed ? 'WINDOW_CLOSED' : 'UNAVAILABLE', failureCode: null }
    }
    try {
      await api.requestReview(row.amazonOrderId)
      return { status: 'REQUESTED', failureCode: null }
    } catch (error) {
      return isAlreadySolicited(error) ? { status: 'REQUESTED', failureCode: 'SOL_ALREADY_SENT' } : rejected(error)
    }
  }

  async function sendBatch(intent: Intent, runId: string | undefined): Promise<Record<string, unknown>> {
    const batchId = needBatch(intent)
    await assertSwitchOn(intent.tenantId)
    const connection = await connectionOf(intent)
    const api = new SolicitationsApi(new AmazonSpApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId)))
    const rows = await inTenant(intent.tenantId, () =>
      deps.prisma.solicitationRequest.findMany({
        where: { tenantId: intent.tenantId, batchId, status: 'QUEUED', ...(connection.sellerAccountId ? { sellerAccountId: connection.sellerAccountId } : {}) },
        orderBy: { amazonOrderId: 'asc' },
        take: REVIEWS_LIMITS.batchMax,
      }),
    )
    const counts: Record<Settled, number> = { REQUESTED: 0, UNAVAILABLE: 0, WINDOW_CLOSED: 0, FAILED: 0 }
    for (const row of rows) {
      const now = new Date()
      const outcome = await decide(api, row, now)
      await inTenant(intent.tenantId, () =>
        deps.prisma.solicitationRequest.updateMany({
          where: { id: row.id, tenantId: intent.tenantId, status: 'QUEUED' },
          data: { status: outcome.status, failureCode: outcome.failureCode, ...(outcome.status === 'REQUESTED' ? { sentAt: now, writeRunId: runId ?? null } : {}) },
        }),
      )
      counts[outcome.status] += 1
      if (outcome.authFailure) throw new NonRetryableError(`SP_API_${outcome.authFailure}`, '亚马逊拒绝了请求评价的授权，已停止本批剩余订单')
    }
    return { done: true, processed: rows.length, requested: counts.REQUESTED, unavailable: counts.UNAVAILABLE, windowClosed: counts.WINDOW_CLOSED, failed: counts.FAILED }
  }

  const remaining = (intent: Intent) => inTenant(intent.tenantId, () => deps.prisma.solicitationRequest.count({ where: { tenantId: intent.tenantId, batchId: needBatch(intent), status: 'QUEUED' } }))

  return {
    kind: SOLICITATION_SEND,
    steps: [
      {
        name: '向亚马逊逐单请求评价',
        // 意图只记批次编号与订单数，不含订单明细
        buildRequest: async ctx => ({ solicitationBatchId: needBatch(ctx.intent), orders: await remaining(ctx.intent), requestedAt: new Date().toISOString() }),
        run: async ctx => sendBatch(ctx.intent, ctx.runId),
        reconcile: async ctx => ((await remaining(ctx.intent)) === 0 ? { found: true, response: { done: true } } : { found: false }),
      },
    ],
  }
}
