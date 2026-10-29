import { OPPORTUNITY_STATUSES, type ClaimListState, type OpportunityStatus, type ReceivingExtra } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 货件接收页共用：赔付状态归类（纯函数）与列表补充列的批量装配。

export const NONCOMPLIANCE_FRESHNESS_KEY = 'rpt.inbound-noncompliance'
export const INBOUND_RULE = 'INBOUND_DISCREPANCY'
const DAY_MS = 86_400_000

/** 多条机会并存时列表上显示哪一个：待处理最优先，其次已生成案件、已过期、已忽略、差异已消除。 */
const STATUS_PRIORITY: readonly OpportunityStatus[] = ['PENDING', 'CASE_CREATED', 'EXPIRED', 'IGNORED', 'RESOLVED']

export interface ClaimInput {
  closed: boolean
  /** 有没有未消除的少收。 */
  openShort: boolean
  opportunityStatuses: readonly string[]
}

/** 纯函数：货件没有关闭不判断；有机会按优先级取状态；没有机会时，少收还在等待期内是 WAITING，否则无需赔付。 */
export function claimStateOf(input: ClaimInput): ClaimListState {
  if (!input.closed) return 'NOT_JUDGED'
  const known = input.opportunityStatuses.filter((status): status is OpportunityStatus => (OPPORTUNITY_STATUSES as readonly string[]).includes(status))
  for (const status of STATUS_PRIORITY) if (known.includes(status)) return status
  return input.openShort ? 'WAITING' : 'NONE'
}

export interface ReceivingShipmentRef {
  id: string
  shipmentId: string
  shipmentConfirmationId: string | null
  status: string
  transportStatus: string | null
  sellerAccountId: string
}

/** 不合规报告同步成功过的店铺（范围内）；没有同步过的店铺，不合规问题数显示“尚未接入”。 */
export async function noncomplianceConnected(prisma: PrismaService, tenantId: string, scope: ResolvedScope, sellerAccountIds: string[]): Promise<Set<string>> {
  if (sellerAccountIds.length === 0) return new Set()
  const rows = await prisma.dataFreshness.findMany({
    where: { tenantId, sourceKey: NONCOMPLIANCE_FRESHNESS_KEY, lastSuccessAt: { not: null }, sellerAccountId: { in: [...new Set(sellerAccountIds)] }, ...storeWhere(scope) },
    select: { sellerAccountId: true },
    take: 500,
  })
  return new Set(rows.flatMap(row => (row.sellerAccountId ? [row.sellerAccountId] : [])))
}

/** 一页货件的补充列：运输状态、差异天数、赔付状态、不合规问题数。 */
export async function loadReceivingExtras(prisma: PrismaService, tenantId: string, scope: ResolvedScope, shipments: ReceivingShipmentRef[], now: Date): Promise<Map<string, ReceivingExtra>> {
  const result = new Map<string, ReceivingExtra>()
  if (shipments.length === 0) return result
  const refs = [...new Set(shipments.flatMap(item => [item.shipmentId, item.shipmentConfirmationId].filter((value): value is string => !!value)))]
  const [rows, opportunities, connected] = await Promise.all([
    prisma.receivingDiscrepancy.findMany({ where: { tenantId, shipmentRef: { in: refs } }, select: { shipmentRef: true, kind: true, firstSeenAt: true, resolvedAt: true }, take: 20000 }),
    prisma.reimbursementOpportunity.findMany({
      where: { tenantId, ruleCode: INBOUND_RULE, OR: shipments.map(item => ({ dedupKey: { startsWith: `${item.shipmentId}:` } })) },
      select: { dedupKey: true, status: true },
      take: 20000,
    }),
    noncomplianceConnected(
      prisma,
      tenantId,
      scope,
      shipments.map(item => item.sellerAccountId),
    ),
  ])
  for (const shipment of shipments) {
    const own = rows.filter(row => row.shipmentRef === shipment.shipmentId || (shipment.shipmentConfirmationId !== null && row.shipmentRef === shipment.shipmentConfirmationId))
    const open = own.filter(row => (row.kind === 'SHORT' || row.kind === 'OVER') && !row.resolvedAt)
    const first = open.reduce<Date | null>((min, row) => (!min || row.firstSeenAt < min ? row.firstSeenAt : min), null)
    const noncompliance = own.filter(row => row.kind === 'NONCOMPLIANCE')
    result.set(shipment.id, {
      transportStatus: shipment.transportStatus,
      discrepancyDays: first ? Math.max(0, Math.floor((now.getTime() - first.getTime()) / DAY_MS)) : null,
      claimState: claimStateOf({
        closed: shipment.status === 'CLOSED',
        openShort: open.some(row => row.kind === 'SHORT'),
        opportunityStatuses: opportunities.filter(row => row.dedupKey.startsWith(`${shipment.shipmentId}:`)).map(row => row.status),
      }),
      noncomplianceCount: connected.has(shipment.sellerAccountId) || noncompliance.length > 0 ? noncompliance.length : null,
    })
  }
  return result
}
