import {
  INBOUND_READ,
  INBOUND_STAGE_LABEL,
  INBOUND_SWITCH_KEYS,
  INBOUND_WRITE,
  aggregateFreshness,
  freshnessSourceOfJobType,
  isInboundStage,
  type InboundOp,
  type InboundPlanListResponse,
  type InboundPlanRow,
  type InboundStage,
  type InboundWriteStatus,
} from '@nova/api-contracts'
import type { FbaInboundPlan } from '@prisma/client'
import { appError, type ApiContext } from '../../platform/http'
import type { PrismaService } from '../../platform/prisma.service'
import type { ActionGuardService } from '../../platform/write'
import { storeWhere, type ResolvedScope } from '../auth'

export { INBOUND_READ, INBOUND_WRITE }
export const INBOUND_FRESHNESS_KEY = 'inbound.plan'
export const LABEL_LINK_TTL_SECONDS = 300

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
export const num = (value: { toNumber(): number } | number | null | undefined): number | null => (value === null || value === undefined ? null : typeof value === 'number' ? value : value.toNumber())
export const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

export async function loadPlan(prisma: PrismaService, tenantId: string, scope: ResolvedScope, id: string): Promise<FbaInboundPlan> {
  const plan = await prisma.fbaInboundPlan.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
  if (!plan) throw appError('RESOURCE_NOT_FOUND', '入仓计划不存在')
  return plan
}

export async function storeNames(prisma: PrismaService, tenantId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>()
  const stores = await prisma.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true }, take: 500 })
  return new Map(stores.map(store => [store.id, store.displayName]))
}

/** 范围内店铺的入仓同步新鲜度（最差的店铺为准）；范围内没有店铺时为 null。 */
export async function inboundFreshness(prisma: PrismaService, tenantId: string, scope: ResolvedScope, now = new Date()): Promise<InboundPlanListResponse['freshness']> {
  const spec = freshnessSourceOfJobType('FBA_INBOUND_SYNC')
  if (!spec) return null
  const [stores, rows] = await Promise.all([
    prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true }, take: 500 }),
    prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: INBOUND_FRESHNESS_KEY, ...storeWhere(scope) },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 5000,
    }),
  ])
  if (stores.length === 0) return null
  const view = aggregateFreshness(
    rows,
    stores.map(store => store.id),
    now,
    [spec],
  ).sources[0]
  return { status: view.status, statusLabel: view.statusLabel, lastSuccessAt: iso(view.lastSuccessAt), errorMessage: view.errorMessage }
}

/** 页面按钮状态：权限 → 连接 → 写入开关，服务端执行前用同一套规则再判断一次。switchKey 为空表示不受开关控制（生成方案、资格预检、标签）。 */
export async function writeStatus(guard: ActionGuardService, context: ApiContext, switchKey: string | null, sellerAccountId?: string): Promise<InboundWriteStatus> {
  const decision = await guard.evaluate(context, {
    permission: INBOUND_WRITE,
    connection: { provider: 'AMAZON_SP_API', ...(sellerAccountId ? { sellerAccountId } : {}) },
    ...(switchKey ? { switchKey } : {}),
  })
  if (decision.allowed || !decision.blockedBy) return { allowed: true, step: null, reason: null, remedyPath: null }
  const block = decision.blockedBy
  const step = block.step === 'PERMISSION' || block.step === 'CONNECTION' || block.step === 'SWITCH' ? block.step : null
  return { allowed: false, step, reason: block.message, remedyPath: block.remedy?.path ?? null }
}
/** 每个写入开关各一个状态，外加 NONE（不受开关控制的动作）。 */
export async function writeStatuses(guard: ActionGuardService, context: ApiContext, sellerAccountId?: string): Promise<Record<string, InboundWriteStatus>> {
  const entries = await Promise.all(
    [...INBOUND_SWITCH_KEYS.map(key => [key, key] as const), ['NONE', null] as const].map(async ([name, key]) => [name, await writeStatus(guard, context, key, sellerAccountId)] as const),
  )
  return Object.fromEntries(entries)
}

type Deadline = NonNullable<InboundPlanRow['nextDeadline']>
/** 每个计划最近的截止时间：装箱方案过期（已创建、还没确认）、分仓方案过期（箱内物品已提交、还没确认）、作废窗口（运输方案已确认、货未发出）。 */
export async function nextDeadlines(prisma: PrismaService, tenantId: string, plans: Array<Pick<FbaInboundPlan, 'id' | 'stage' | 'voidDeadlineAt'>>, now: Date): Promise<Map<string, Deadline>> {
  const result = new Map<string, Deadline>()
  const ids = plans.map(plan => plan.id)
  if (ids.length === 0) return result
  const [packing, placement] = await Promise.all([
    prisma.packingOption.groupBy({ by: ['planId'], where: { tenantId, planId: { in: ids }, status: 'OFFERED', expiresAt: { gt: now } }, _min: { expiresAt: true } }),
    prisma.placementOption.groupBy({ by: ['planId'], where: { tenantId, planId: { in: ids }, status: 'OFFERED', expiresAt: { gt: now } }, _min: { expiresAt: true } }),
  ])
  const consider = (planId: string, kind: Deadline['kind'], at: Date | null | undefined) => {
    if (!at) return
    const current = result.get(planId)
    if (!current || new Date(current.at).getTime() > at.getTime()) result.set(planId, { kind, at: at.toISOString() })
  }
  for (const plan of plans) {
    if (plan.stage === 'CREATED') consider(plan.id, 'PACKING_EXPIRES', packing.find(row => row.planId === plan.id)?._min.expiresAt)
    if (plan.stage === 'PACKING_INFO_SUBMITTED') consider(plan.id, 'PLACEMENT_EXPIRES', placement.find(row => row.planId === plan.id)?._min.expiresAt)
    if ((plan.stage === 'TRANSPORT_CONFIRMED' || plan.stage === 'LABELS_PRINTED') && plan.voidDeadlineAt && plan.voidDeadlineAt.getTime() > now.getTime())
      consider(plan.id, 'VOID_WINDOW', plan.voidDeadlineAt)
  }
  return result
}

export function planRowOf(plan: FbaInboundPlan, extra: { storeName: string; skuCount: number; deadline: Deadline | null }): InboundPlanRow {
  const stage: InboundStage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
  return {
    id: plan.id,
    name: plan.name,
    sellerAccountId: plan.sellerAccountId,
    storeName: extra.storeName,
    externalPlanId: plan.externalPlanId,
    stage,
    stageLabel: INBOUND_STAGE_LABEL[stage],
    pendingOp: (plan.pendingOp as InboundOp | null) ?? null,
    totalUnits: plan.totalUnits,
    skuCount: extra.skuCount || (Array.isArray(plan.items) ? plan.items.length : 0),
    shipmentCount: plan.shipmentCount,
    sourceType: plan.sourceType,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    version: plan.version,
    lastErrorMessage: plan.lastErrorMessage,
    nextDeadline: extra.deadline,
  }
}

/** 单个计划的行（写接口返回用）。 */
export async function singlePlanRow(prisma: PrismaService, plan: FbaInboundPlan, now = new Date()): Promise<InboundPlanRow> {
  const [names, count, deadlines] = await Promise.all([
    storeNames(prisma, plan.tenantId, [plan.sellerAccountId]),
    prisma.inboundPlanItem.count({ where: { tenantId: plan.tenantId, planId: plan.id } }),
    nextDeadlines(prisma, plan.tenantId, [plan], now),
  ])
  return planRowOf(plan, { storeName: names.get(plan.sellerAccountId) ?? '', skuCount: count, deadline: deadlines.get(plan.id) ?? null })
}
