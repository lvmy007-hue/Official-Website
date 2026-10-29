import { AWD_LABELS_JOB, AWD_SWITCH_KEY, AWD_SYNC_JOB, AWD_WRITE_JOB } from '@nova/api-contracts'
import { TenantObjectStore } from '@nova/storage'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { syncAwd } from '../importers/awd/sync'
import { recordSwitchOutcome } from '../platform/switch-outcome'
import { runWriteWorkflow } from '../runtime/workflows'
import type { SyncPayload } from '../types'
import { AwdApi } from './awd-api'
import type { AmazonSpApiClient } from './amazon-sp-api'
import type { ProductionDeps, ProductionRun } from './dispatch'
import { UpstreamHttpError } from './http-error'
import { assertRemoteUrl } from './remote-url'

// 上游仓储（AWD）任务分发（P2a-08）：同步（AWD_SYNC）、订单写入（AWD_ORDER_WRITE）、货件标签（AWD_LABELS）。
// 三类任务都进 awd 队列，同店铺互斥（读写不并发）。写入走流程状态机（runtime/awd-workflow.ts）；失败的处置在 markAwdWriteFailed。

export const AWD_JOB_TYPES: readonly string[] = [AWD_SYNC_JOB, AWD_WRITE_JOB, AWD_LABELS_JOB]

const LABEL_POLL_LIMIT_MS = 10 * 60 * 1000
const LABEL_MAX_BYTES = 20 * 1024 * 1024

type AwdRow = { id: string; type: string; tenantId: string; connection: { id: string } }

async function fetchLabels(deps: ProductionDeps, api: AwdApi, scope: { tenantId: string; sellerAccountId: string }, payload: SyncPayload) {
  const { prisma } = deps
  if (!deps.storage) throw new NonRetryableError('STORAGE_NOT_CONFIGURED', '没有配置对象存储，无法保存货件标签')
  const shipmentId = payload.awdShipmentId
  const shipment = shipmentId ? await prisma.awdInboundShipment.findFirst({ where: { ...scope, shipmentId } }) : null
  if (!shipment || !shipmentId) throw new NonRetryableError('AWD_SHIPMENT_NOT_FOUND', '入库货件不存在')
  const labels = await api.getLabels(shipmentId)
  if (labels.labelStatus === 'GENERATED' && labels.url) {
    const url = new URL(labels.url)
    if (url.protocol !== 'https:') throw new NonRetryableError('AWD_LABEL_URL_INVALID', '亚马逊返回的标签链接不是加密地址，已拒绝下载')
    const response = await fetch(assertRemoteUrl(url, '标签下载地址'), { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new UpstreamHttpError(`AWD_LABEL_DOWNLOAD_${response.status}`, response.status, response.headers, 'download')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > LABEL_MAX_BYTES) throw new NonRetryableError('AWD_LABEL_SIZE_INVALID', '标签文件为空或超过大小上限')
    const store = new TenantObjectStore(deps.storage, scope.tenantId)
    const stored = await store.put({ domain: 'awd-labels', name: `${shipmentId}.pdf` }, bytes, { contentType: 'application/pdf' })
    const previous = shipment.labelObjectKey
    await prisma.awdInboundShipment.update({ where: { id: shipment.id }, data: { labelStatus: 'GENERATED', labelObjectKey: stored.key, labelFetchedAt: new Date() } })
    if (previous && previous !== stored.key) await store.remove(previous).catch(() => undefined) // 旧文件清理失败不影响本次结果
    return { ready: true, shipmentId, sizeBytes: stored.sizeBytes }
  }
  const status = labels.labelStatus === 'GENERATION_FAILED' ? 'GENERATION_FAILED' : labels.labelStatus === 'GENERATING' ? 'GENERATING' : 'NOT_READY'
  await prisma.awdInboundShipment.update({ where: { id: shipment.id }, data: { labelStatus: status } })
  if (status === 'GENERATION_FAILED') throw new NonRetryableError('AWD_LABEL_GENERATION_FAILED', '亚马逊生成标签失败')
  const job = await prisma.syncJob.findUnique({ where: { id: payload.syncJobId }, select: { createdAt: true } })
  if (job && Date.now() - job.createdAt.getTime() > LABEL_POLL_LIMIT_MS) throw new NonRetryableError('AWD_LABEL_TIMEOUT', '亚马逊 10 分钟内没有生成标签')
  return { pending: true, labelStatus: status } // 监听器会按 30 秒间隔再来取
}

export async function processAwd(deps: ProductionDeps, client: AmazonSpApiClient, row: AwdRow, sellerAccountId: string, payload: SyncPayload, run: ProductionRun, today: Date) {
  const { prisma, reliability, writeWorkflows } = deps
  const api = new AwdApi(client)
  const scope = { tenantId: row.tenantId, sellerAccountId }
  if (row.type === AWD_SYNC_JOB) return syncAwd(deps, api, scope, { today })
  if (row.type === AWD_LABELS_JOB) return fetchLabels(deps, api, scope, payload)
  if (!payload.awdOrderId || !payload.awdAction) throw new NonRetryableError('AWD_WRITE_CONTEXT_MISSING', '写入任务缺少订单编号或动作')
  const result = await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.awdOrderWrite, {
    tenantId: row.tenantId,
    dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.AWD_ORDER_WRITE, payload.awdOrderId, run.jobId),
    syncJobId: payload.syncJobId,
    priority: run.priority,
    lease: run.lease,
    isLastAttempt: run.isLastAttempt,
    owner: `${reliability.ownerId}:${run.jobId}`,
    intent: { tenantId: row.tenantId, connectionId: row.connection.id, awdOrderId: payload.awdOrderId, awdAction: payload.awdAction },
  })
  await recordSwitchOutcome(prisma, row.tenantId, AWD_SWITCH_KEY, { success: true }).catch(() => undefined) // 登记失败不影响写入结果
  return result
}

const CALL_FAILURE = /^(SP_API_|LWA_TOKEN_FAILED_)/
const AUTH_FAILURE = /^(SP_API_(401|403)_|LWA_TOKEN_FAILED_(400|401))/

/**
 * 写入任务永久失败后的处置（由监听器在任务进入死信时调用）：订单不再显示“处理中”，记下失败原因；
 * 还没有到亚马逊创建成功的订单标为“提交失败”，可以修改后重新提交。只有真正调用了亚马逊的失败才计入开关的连续失败次数。
 */
export async function markAwdWriteFailed(db: PrismaClient, tenantId: string, payload: SyncPayload, failureCode: string): Promise<void> {
  if (!payload.awdOrderId) return
  const row = await db.awdInboundOrder.findFirst({ where: { id: payload.awdOrderId } })
  if (!row) return
  await db.awdInboundOrder.update({
    where: { id: row.id },
    data: { pendingAction: null, lastErrorCode: shortCode(failureCode), lastErrorMessage: failureMessage(failureCode), ...(row.orderId ? {} : { status: 'CREATE_FAILED' }), version: { increment: 1 } },
  })
  if (CALL_FAILURE.test(failureCode))
    await recordSwitchOutcome(db, tenantId, AWD_SWITCH_KEY, { success: false, errorCode: failureCode.slice(0, 40), authInvalid: AUTH_FAILURE.test(failureCode) }).catch(() => undefined)
}

/** 失败码只留“来源 + 状态码”（SP_API_400）：亚马逊返回的原文不进订单记录。 */
function shortCode(code: string): string {
  return /^SP_API_\d{3}/.exec(code)?.[0] ?? code.slice(0, 60)
}

function failureMessage(code: string): string {
  if (code === 'SWITCH_DISABLED') return '写入开关已关闭，未向亚马逊发出请求'
  if (code === 'AWD_ORDER_NOT_DRAFT') return '订单已不是草稿状态，不能再修改'
  if (code === 'AWD_ORDER_INCOMPLETE' || code === 'AWD_PACKAGE_DIMENSIONS_MISSING') return '订单信息不完整，请补全后重新提交'
  if (/^SP_API_4\d\d_/.test(code)) return '亚马逊拒绝了这次请求，请核对订单内容与授权后重试'
  return '提交失败，请稍后重试；多次失败请联系管理员'
}
