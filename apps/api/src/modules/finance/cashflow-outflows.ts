import { CASHFLOW_ADS_DAYS, addDaysText, roundCash, type CashSource, type Dated } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, type ResolvedScope } from '../auth'
import { zonedDayStart } from '../overview'

// 现金流的流出来源（P2b-08）：采购付款计划、头程付款、广告扣款。
// 采购单与头程运单没有店铺归属，所以只有“全部店铺”范围的成员才计入（限定店铺的成员看到的是“不适用”，不是 0）；各来源还要有对应的查看权限。
// 币种与所选币种不同的不换算，单独计数列出；没有日期的单独计数，不排进任何一周。

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : Number(value.toString()))
/** 已确认要执行的采购单状态：草稿与待审批的付款计划还不确定，已取消、已关闭、已退货的不会再付。 */
const COMMITTED_PO_STATUSES = ['ORDERED', 'IN_PRODUCTION', 'PARTIALLY_RECEIVED', 'RECEIVED']

export interface OutflowRead<T> {
  source: CashSource<T>
  excluded: { count: number; currencies: string[] }
  undated: number
}
type Access = { permissions: readonly string[]; scope: ResolvedScope }

const blocked = (access: Access, permission: string, label: string): { state: 'RESTRICTED' | 'OUT_OF_SCOPE'; reason: string } | null => {
  if (!access.scope.unrestricted) return { state: 'OUT_OF_SCOPE', reason: `${label}没有店铺归属，只有选择“全部店铺”范围时才计入；当前范围不适用` }
  if (!hasPermission(access.permissions, permission)) return { state: 'RESTRICTED', reason: `${label}需要对应的查看权限` }
  return null
}

/** 计划中的采购付款（付款计划里还没付的），按计划付款日；计划日已过的算逾期，归入第一周。 */
export async function loadPurchaseOutflow(prisma: PrismaService, tenantId: string, access: Access, currency: string): Promise<OutflowRead<readonly Dated[]>> {
  const stop = blocked(access, 'purchase.read', '采购付款')
  if (stop) return { source: stop, excluded: { count: 0, currencies: [] }, undated: 0 }
  const rows = await prisma.purchasePayment.findMany({
    where: { tenantId, status: 'PLANNED', purchaseOrder: { status: { in: COMMITTED_PO_STATUSES } } },
    select: { amount: true, currency: true, plannedAt: true },
    orderBy: { plannedAt: 'asc' },
    take: 5000,
  })
  const items: Dated[] = []
  const others = new Set<string>()
  let excluded = 0
  let undated = 0
  for (const row of rows) {
    if (row.currency !== currency) {
      excluded += 1
      others.add(row.currency)
    } else if (!row.plannedAt) undated += 1
    else items.push({ date: row.plannedAt.toISOString().slice(0, 10), amount: roundCash(num(row.amount)) })
  }
  return { source: { state: 'OK', value: items }, excluded: { count: excluded, currencies: [...others].sort() }, undated }
}

/**
 * 头程付款：还没有登记任何实际费用、也没有送达的运单，用预估费用按预计到港日（没有则预计送达日、发货日）估计。
 * 已登记实际费用的运单视为费用已发生，不再预测；官方没有头程付款计划，所以付款日就是上面这个估计，不是合同约定。
 */
export async function loadFirstMileOutflow(prisma: PrismaService, tenantId: string, access: Access, currency: string): Promise<OutflowRead<readonly Dated[]>> {
  const stop = blocked(access, 'firstmile.read', '头程付款')
  if (stop) return { source: stop, excluded: { count: 0, currencies: [] }, undated: 0 }
  const rows = await prisma.firstMileShipment.findMany({
    where: { tenantId, ataDelivery: null, estimatedCost: { not: null }, costs: { none: {} } },
    select: { estimatedCost: true, currency: true, etaPort: true, etaDelivery: true, shipDate: true },
    take: 2000,
  })
  const items: Dated[] = []
  const others = new Set<string>()
  let excluded = 0
  let undated = 0
  for (const row of rows) {
    const date = row.etaPort ?? row.etaDelivery ?? row.shipDate
    if (row.currency !== currency) {
      excluded += 1
      others.add(row.currency)
    } else if (!date) undated += 1
    else items.push({ date: date.toISOString().slice(0, 10), amount: roundCash(num(row.estimatedCost)) })
  }
  return { source: { state: 'OK', value: items }, excluded: { count: excluded, currencies: [...others].sort() }, undated }
}

/**
 * 广告扣款：最近 14 天广告花费的日均（该币种）。广告账户绑定了店铺的按店铺范围过滤，没绑定的只有“全部店铺”范围看得到。
 * 没有任何花费记录时是“尚未接入”（广告同步属于阶段 3），不当 0。
 */
export async function loadAdsOutflow(prisma: PrismaService, tenantId: string, access: Access, currency: string, today: string, zone: string): Promise<CashSource<number>> {
  if (!hasPermission(access.permissions, 'ads.read')) return { state: 'RESTRICTED', reason: '广告扣款需要“广告查看”权限' }
  const since = zonedDayStart(addDaysText(today, -CASHFLOW_ADS_DAYS), zone)
  const aggregate = await prisma.adsMetric.aggregate({
    where: {
      tenantId,
      currency,
      // 只取活动行：广告组与投放对象行是同一笔花费的更细拆分（P5-12A 起同步器写入），一起加会重复
      entityType: 'CAMPAIGN',
      cost: { not: null },
      reportDate: { gte: since },
      ...adsRelationWhere(access.scope),
    },
    _sum: { cost: true },
    _count: { _all: true },
  })
  if (aggregate._count._all === 0) return { state: 'NOT_CONNECTED', reason: `最近 ${CASHFLOW_ADS_DAYS} 天没有广告花费记录（尚无记录：广告账户未授权、档案未绑定店铺在范围内，或报表还没有同步到）` }
  return { state: 'OK', value: roundCash(num(aggregate._sum.cost) / CASHFLOW_ADS_DAYS) }
}
