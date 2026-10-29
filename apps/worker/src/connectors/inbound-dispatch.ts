import { INBOUND_OP_JOB, INBOUND_OP_TIMEOUT_MINUTES, INBOUND_SWITCH_OF_OP, INBOUND_SYNC_JOB, type InboundOp, type InboundStage } from '@nova/api-contracts'
import { TenantObjectStore } from '@nova/storage'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import { Prisma, type FbaInboundPlan, type InboundOperation, type PrismaClient } from '@prisma/client'
import { syncInboundPlans, syncOnePlan, transportVoidDeadline } from '../importers/inbound/v2024-sync'
import { parseEligibility } from '../importers/inbound/v2024-parse'
import { recordSwitchOutcome } from '../platform/switch-outcome'
import { runWriteWorkflow } from '../runtime/workflows'
import type { SyncPayload } from '../types'
import type { AmazonSpApiClient } from './amazon-sp-api'
import type { ProductionDeps, ProductionRun } from './dispatch'
import { UpstreamHttpError } from './http-error'
import { InboundApi } from './inbound-api'
import { assertRemoteUrl } from './remote-url'

// 入仓计划任务分发（P2a-12）：同步（FBA_INBOUND_SYNC）与操作（FBA_INBOUND_OP）。
// 操作任务分三种走法：资格预检与标签是只读调用，直接执行；其余写操作先走流程状态机提交到亚马逊（得到异步操作编号），
// 然后任务返回“等待中”，由监听器每 30 秒回来一次（payload.poll），查到成功就回写并同步计划、失败就记下亚马逊给的原因。

export const INBOUND_JOB_TYPES: readonly string[] = [INBOUND_SYNC_JOB, INBOUND_OP_JOB]

const STAGE_AFTER: Partial<Record<InboundOp, InboundStage>> = {
  CREATE_PLAN: 'CREATED',
  CONFIRM_PACKING: 'PACKING_CONFIRMED',
  SUBMIT_PACKING_INFO: 'PACKING_INFO_SUBMITTED',
  CONFIRM_PLACEMENT: 'PLACEMENT_CONFIRMED',
  CONFIRM_TRANSPORT: 'TRANSPORT_CONFIRMED',
  CANCEL_PLAN: 'CANCELLED',
}
const LABEL_MAX_BYTES = 20 * 1024 * 1024
const TERMINAL = ['SUCCESS', 'FAILED', 'TIMEOUT']
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

type InboundRow = { id: string; type: string; tenantId: string; connection: { id: string } }
const clip = (value: string, max = 300) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** 联系人（姓名、电话、邮箱）只在调用亚马逊那一刻使用，操作结束（成功、失败、超时）后从操作记录里清除。 */
export function scrubContacts(params: unknown): Prisma.InputJsonValue {
  const source = record(params)
  const strip = (value: unknown) =>
    Array.isArray(value)
      ? value.map(item => {
          const { contact: _contact, ...rest } = record(item)
          return rest
        })
      : value
  return {
    ...source,
    ...(source.shipments !== undefined ? { shipments: strip(source.shipments) } : {}),
    ...(source.selections !== undefined ? { selections: strip(source.selections) } : {}),
  } as Prisma.InputJsonValue
}

async function loadOp(deps: ProductionDeps, payload: SyncPayload): Promise<{ op: InboundOperation; plan: FbaInboundPlan }> {
  const op = payload.inboundOpId ? await deps.prisma.inboundOperation.findFirst({ where: { id: payload.inboundOpId } }) : null
  const plan = op ? await deps.prisma.fbaInboundPlan.findFirst({ where: { id: op.planId } }) : null
  if (!op || !plan) throw new NonRetryableError('INB_OPERATION_NOT_FOUND', '入仓操作记录或计划不存在')
  return { op, plan }
}

async function runEligibility(deps: ProductionDeps, api: InboundApi, op: InboundOperation, plan: FbaInboundPlan) {
  const { prisma } = deps
  const items = await prisma.inboundPlanItem.findMany({ where: { planId: plan.id }, orderBy: { sku: 'asc' }, take: 500 })
  const checkedAt = new Date()
  const rows: Prisma.InboundEligibilityCheckCreateManyInput[] = []
  for (const item of items) {
    let eligible = false
    let reasons: string[]
    if (!item.asin) reasons = ['ASIN_UNKNOWN']
    else {
      try {
        const parsed = parseEligibility(await api.eligibility(item.asin, plan.marketplaceId))
        eligible = parsed.eligible === true
        reasons = parsed.eligible === null ? ['NO_ANSWER'] : parsed.reasons
      } catch (error) {
        // 缺角色或授权失效是整体问题，原样抛出；其余 4xx 记在这个 SKU 上，不当作同步失败（importers.md I-06：不合格不是失败）
        if (!(error instanceof UpstreamHttpError) || [401, 403, 429].includes(error.status) || error.status >= 500) throw error
        reasons = [`SP_API_${error.status}`]
      }
    }
    rows.push({ tenantId: plan.tenantId, planId: plan.id, sku: item.sku, program: 'INBOUND', eligible, reasonCodes: reasons, checkedAt })
  }
  const allEligible = rows.length > 0 && rows.every(row => row.eligible)
  await prisma.$transaction([
    prisma.inboundEligibilityCheck.createMany({ data: rows }),
    prisma.fbaInboundPlan.update({
      where: { id: plan.id },
      data: {
        pendingOp: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        version: { increment: 1 },
        ...(plan.stage === 'DRAFT' || plan.stage === 'ELIGIBILITY' ? { stage: allEligible ? 'ELIGIBILITY' : 'DRAFT' } : {}),
      },
    }),
    prisma.inboundOperation.update({ where: { id: op.id }, data: { status: 'SUCCESS', finishedAt: new Date() } }),
  ])
  return { done: true, checked: rows.length, ineligible: rows.filter(row => !row.eligible).length }
}

async function runLabels(deps: ProductionDeps, api: InboundApi, op: InboundOperation, plan: FbaInboundPlan) {
  const { prisma } = deps
  if (!deps.storage) throw new NonRetryableError('STORAGE_NOT_CONFIGURED', '没有配置对象存储，无法保存标签')
  const store = new TenantObjectStore(deps.storage, plan.tenantId)
  const jobIds = Array.isArray(record(op.paramsJson).jobIds) ? (record(op.paramsJson).jobIds as string[]) : []
  const jobs = await prisma.labelPrintJob.findMany({ where: { planId: plan.id, id: { in: jobIds } }, take: 200 })
  let failed = 0
  for (const job of jobs) {
    try {
      await prisma.labelPrintJob.update({ where: { id: job.id }, data: { status: 'GENERATING' } })
      const shipment = job.shipmentId ? await prisma.fbaInboundShipment.findUnique({ where: { planId_shipmentId: { planId: plan.id, shipmentId: job.shipmentId } } }) : null
      if (!shipment) throw new NonRetryableError('INB_SHIPMENT_NOT_FOUND', '货件不存在')
      let key: string
      if (job.kind === 'BOX') {
        const boxIds = record(shipment.trackingJson).boxIds
        const boxCount = shipment.boxCount ?? (Array.isArray(boxIds) ? boxIds.length : 0)
        if (!shipment.shipmentConfirmationId || boxCount < 1) throw new NonRetryableError('INB_LABEL_NOT_READY', '货件还没有确认号或箱数，运输方案确认后再试')
        const body = await api.boxLabels(shipment.shipmentConfirmationId, { pageType: job.pageType ?? 'PackageLabel_Letter_6', boxCount })
        const url = new URL(String(record(body.payload ?? body).DownloadURL ?? ''))
        if (url.protocol !== 'https:') throw new NonRetryableError('INB_LABEL_URL_INVALID', '亚马逊返回的标签链接不是加密地址，已拒绝下载')
        const response = await fetch(assertRemoteUrl(url, '标签下载地址'), { signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new UpstreamHttpError(`INB_LABEL_DOWNLOAD_${response.status}`, response.status, response.headers, 'download')
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0 || bytes.length > LABEL_MAX_BYTES) throw new NonRetryableError('INB_LABEL_SIZE_INVALID', '标签文件为空或超过大小上限')
        key = (await store.put({ domain: 'inbound-labels', name: `${plan.id}-${shipment.shipmentId}-box.pdf` }, bytes, { contentType: 'application/pdf' })).key
      } else {
        // 商品标签（FNSKU）已改为在本地生成 PDF（导出中心），不再走亚马逊标签任务；旧版本留下的任务不再处理，标记失败并写明去向
        throw new NonRetryableError('INB_LABEL_KIND_RETIRED', '商品标签已改为在入仓计划“标签”页签里生成商品标签（PDF），文件在导出中心下载；这条旧任务不再处理')
      }
      await prisma.labelPrintJob.update({ where: { id: job.id }, data: { status: 'READY', objectKey: key, errorMessage: null } })
    } catch (error) {
      failed += 1
      const message = error instanceof NonRetryableError ? error.message : error instanceof Error ? error.message : '获取标签失败'
      await prisma.labelPrintJob.update({ where: { id: job.id }, data: { status: 'FAILED', errorMessage: clip(message) } })
    }
  }
  const ready = await prisma.labelPrintJob.findMany({ where: { planId: plan.id, kind: 'BOX', status: 'READY' }, select: { shipmentId: true }, take: 500 })
  const shipments = await prisma.fbaInboundShipment.findMany({ where: { planId: plan.id }, select: { shipmentId: true }, take: 500 })
  const allBoxLabels = shipments.length > 0 && shipments.every(shipment => ready.some(job => job.shipmentId === shipment.shipmentId))
  await prisma.$transaction([
    prisma.fbaInboundPlan.update({
      where: { id: plan.id },
      data: {
        pendingOp: null,
        lastErrorCode: failed ? 'INB_LABELS_FAILED' : null,
        lastErrorMessage: failed ? '有标签没有获取成功，请看标签页签里的原因' : null,
        version: { increment: 1 },
        ...(allBoxLabels && plan.stage === 'TRANSPORT_CONFIRMED' ? { stage: 'LABELS_PRINTED' } : {}),
      },
    }),
    prisma.inboundOperation.update({ where: { id: op.id }, data: { status: failed ? 'FAILED' : 'SUCCESS', errorCode: failed ? 'INB_LABELS_FAILED' : null, finishedAt: new Date() } }),
  ])
  return { done: true, jobs: jobs.length, failed }
}

/** 轮询亚马逊的异步操作：成功就同步计划并推进状态，失败或超时就记下原因并让任务永久失败（页面显示，不重试）。 */
async function pollOperation(deps: ProductionDeps, api: InboundApi, op: InboundOperation, plan: FbaInboundPlan) {
  const { prisma } = deps
  if (TERMINAL.includes(op.status)) return { done: true, status: op.status }
  const now = new Date()
  if (op.operationId) {
    const status = await api.operationStatus(op.operationId)
    if (status.status === 'IN_PROGRESS') {
      if (now.getTime() - op.startedAt.getTime() > INBOUND_OP_TIMEOUT_MINUTES * 60_000) {
        await closeOperation(prisma, op, plan, { status: 'TIMEOUT', code: 'INB_OP_TIMEOUT', message: `亚马逊 ${INBOUND_OP_TIMEOUT_MINUTES} 分钟内没有返回结果，请到亚马逊后台核对后重试` })
        throw new NonRetryableError('INB_OP_TIMEOUT', '等待亚马逊超时')
      }
      return { pending: true, operationId: op.operationId }
    }
    if (status.status === 'FAILED') {
      const message = status.problems.map(problem => problem.message).join('；') || '亚马逊没有给出原因'
      await closeOperation(prisma, op, plan, { status: 'FAILED', code: 'INB_OP_FAILED', message: `亚马逊拒绝了这次操作：${clip(message)}`, problems: status.problems })
      throw new NonRetryableError('INB_OP_FAILED', clip(message))
    }
  }
  const synced = await syncOnePlan(deps, api, plan, now)
  const operation = op.operation as InboundOp
  const stage = STAGE_AFTER[operation]
  const data: Prisma.FbaInboundPlanUncheckedUpdateInput = { pendingOp: null, lastErrorCode: null, lastErrorMessage: null, version: { increment: 1 }, ...(stage ? { stage } : {}) }
  if (operation === 'CONFIRM_TRANSPORT') {
    const window = await transportVoidDeadline(deps, plan.id, now)
    Object.assign(data, { transportConfirmedAt: now, voidDeadlineAt: window.deadline, shippingMode: window.shippingMode })
  }
  await prisma.$transaction([
    prisma.fbaInboundPlan.update({ where: { id: plan.id }, data }),
    prisma.inboundOperation.update({ where: { id: op.id }, data: { status: 'SUCCESS', finishedAt: now, paramsJson: scrubContacts(op.paramsJson) } }),
  ])
  return { done: true, imported: synced }
}

async function closeOperation(db: PrismaClient, op: InboundOperation, plan: FbaInboundPlan, result: { status: 'FAILED' | 'TIMEOUT'; code: string; message: string; problems?: unknown }) {
  await db.$transaction([
    db.inboundOperation.update({
      where: { id: op.id },
      data: {
        status: result.status,
        errorCode: result.code,
        finishedAt: new Date(),
        paramsJson: scrubContacts(op.paramsJson),
        ...(result.problems ? { problemsJson: result.problems as Prisma.InputJsonValue } : {}),
      },
    }),
    db.fbaInboundPlan.update({
      where: { id: plan.id },
      // 创建计划失败：亚马逊那边的计划编号作废，回到“资格预检通过”可以重新提交
      data: { pendingOp: null, lastErrorCode: result.code, lastErrorMessage: result.message, version: { increment: 1 }, ...(op.operation === 'CREATE_PLAN' ? { externalPlanId: null } : {}) },
    }),
  ])
}

export async function processInbound(deps: ProductionDeps, client: AmazonSpApiClient, row: InboundRow, sellerAccountId: string, payload: SyncPayload, run: ProductionRun) {
  const { reliability, writeWorkflows } = deps
  const api = new InboundApi(client)
  if (row.type === INBOUND_SYNC_JOB) return syncInboundPlans(deps, api, { tenantId: row.tenantId, sellerAccountId }, { planId: payload.fbaPlanId })
  const { op, plan } = await loadOp(deps, payload)
  const operation = op.operation as InboundOp
  if (operation === 'ELIGIBILITY') return runEligibility(deps, api, op, plan)
  if (operation === 'LABELS') return runLabels(deps, api, op, plan)
  if (payload.poll) return pollOperation(deps, api, op, plan)
  if (op.status !== 'QUEUED') return pollOperation(deps, api, op, plan) // 流程已经提交过（任务重投递）：直接进入等待结果
  await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.inboundPlanOp, {
    tenantId: row.tenantId,
    dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.INBOUND_PLAN_OP, op.id, run.jobId),
    syncJobId: payload.syncJobId,
    priority: run.priority,
    lease: run.lease,
    isLastAttempt: run.isLastAttempt,
    owner: `${reliability.ownerId}:${run.jobId}`,
    intent: { tenantId: row.tenantId, connectionId: row.connection.id, inboundOpId: op.id },
  })
  const switchKey = INBOUND_SWITCH_OF_OP[operation]
  if (switchKey) await recordSwitchOutcome(deps.prisma, row.tenantId, switchKey, { success: true }).catch(() => undefined) // 登记失败不影响写入结果
  return { pending: true, operation }
}

const CALL_FAILURE = /^(SP_API_|LWA_TOKEN_FAILED_)/
const AUTH_FAILURE = /^(SP_API_(401|403)_|LWA_TOKEN_FAILED_(400|401))/
const shortCode = (code: string) => /^SP_API_\d{3}/.exec(code)?.[0] ?? code.slice(0, 60)

function failureMessage(code: string): string {
  if (code === 'SWITCH_DISABLED') return '写入开关已关闭，未向亚马逊发出请求'
  if (code === 'INB_OP_FAILED' || code === 'INB_OP_TIMEOUT') return '亚马逊没有完成这次操作，请看时间线里的原因'
  if (code === 'INB_BOX_GROUP_MISSING' || code === 'INB_BOXES_EMPTY' || code === 'INB_PLAN_EMPTY' || code === 'INB_ADDRESS_INVALID') return '计划信息不完整，请补全后重新提交'
  if (/^SP_API_4\d\d/.test(code)) return '亚马逊拒绝了这次请求，请核对内容与授权后重试'
  return '操作失败，请稍后重试；多次失败请联系管理员'
}

/**
 * 操作任务永久失败后的处置（监听器在任务进入死信时调用）：计划不再显示“处理中”，操作记录标为失败并写原因；
 * 只有真正调用了亚马逊的失败才计入开关的连续失败次数（亚马逊异步操作失败、资格不合格不计）。
 */
export async function markInboundOpFailed(db: PrismaClient, tenantId: string, payload: SyncPayload, failureCode: string): Promise<void> {
  if (!payload.inboundOpId) return
  const op = await db.inboundOperation.findFirst({ where: { id: payload.inboundOpId } })
  if (!op) return
  const plan = await db.fbaInboundPlan.findFirst({ where: { id: op.planId } })
  if (plan && !TERMINAL.includes(op.status)) await closeOperation(db, op, plan, { status: 'FAILED', code: shortCode(failureCode), message: failureMessage(failureCode) })
  else if (plan?.pendingOp) await db.fbaInboundPlan.update({ where: { id: plan.id }, data: { pendingOp: null } })
  const switchKey = INBOUND_SWITCH_OF_OP[op.operation as InboundOp]
  if (switchKey && CALL_FAILURE.test(failureCode))
    await recordSwitchOutcome(db, tenantId, switchKey, { success: false, errorCode: failureCode.slice(0, 40), authInvalid: AUTH_FAILURE.test(failureCode) }).catch(() => undefined)
}
