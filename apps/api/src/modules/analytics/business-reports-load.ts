import {
  BR_ASIN_GROUP_LIMIT,
  BR_NO_BRAND_NOTE,
  BR_ROW_LIMIT,
  BR_STORE_STATE_LABEL,
  SALES_TRAFFIC_DATE_FRESHNESS_KEY,
  SALES_TRAFFIC_NO_BRAND,
  freshnessErrorMessage,
  type BrGranularity,
  type BrLevel,
  type BrStoreState,
  type BrStoreStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate, dateText } from '../overview'
import type { BrRow } from './business-reports-math'

// 业务报告的取数（P4-02）：只读 P4-01 同步的销售与流量表，一律带企业与数据范围条件，只取美元行。
// 官方没给的列是空（不是 0），这里原样带回 null。读取上限 19,999 行 / 分组，多读一行判断是否被截断。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const CURRENCY = 'USD'

/** 店铺日粒度（或周、月粒度）的行；两个来源的行都读回来，由 preferredRows 取舍。 */
export async function loadDailyRows(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  granularity: BrGranularity,
  from: string,
  to: string,
): Promise<{ rows: BrRow[]; truncated: boolean }> {
  const found = await prisma.salesTrafficDaily.findMany({
    where: { tenantId, ...storeWhere(scope), granularity, currency: CURRENCY, date: { gte: asDate(from), lte: asDate(to) } },
    select: {
      sellerAccountId: true,
      date: true,
      source: true,
      orderedSales: true,
      unitsOrdered: true,
      ordersCount: true,
      sessions: true,
      pageViews: true,
      buyBoxPct: true,
      unitSessionPct: true,
      unitsRefunded: true,
    },
    orderBy: [{ date: 'asc' }, { sellerAccountId: 'asc' }, { source: 'asc' }],
    take: BR_ROW_LIMIT + 1,
  })
  const rows = found.slice(0, BR_ROW_LIMIT).map<BrRow>(row => ({
    sellerAccountId: row.sellerAccountId,
    date: dateText(row.date),
    source: row.source,
    orderedSales: num(row.orderedSales),
    unitsOrdered: row.unitsOrdered,
    ordersCount: row.ordersCount,
    sessions: row.sessions,
    pageViews: row.pageViews,
    buyBoxPct: num(row.buyBoxPct),
    unitSessionPct: num(row.unitSessionPct),
    unitsRefunded: row.unitsRefunded,
  }))
  return { rows, truncated: found.length > BR_ROW_LIMIT }
}

/** 范围内的广告销售额（店铺日汇总里已绑定店铺的美元广告销售额）；一行有值的都没有就是 null。 */
export async function loadAdsSales(prisma: PrismaService, tenantId: string, scope: ResolvedScope, from: string, to: string): Promise<number | null> {
  const total = await prisma.storeDailySummary.aggregate({
    where: { tenantId, ...storeWhere(scope), currency: CURRENCY, adsSales: { not: null }, summaryDate: { gte: asDate(from), lte: asDate(to) } },
    _sum: { adsSales: true },
    _count: { adsSales: true },
  })
  return total._count.adsSales === 0 ? null : num(total._sum.adsSales)
}

/** 每家店的同步情况：数据中心（按日期）最近一次的结果；缺品牌分析角色单独说明，没有记录就是“尚无记录”。 */
export async function loadStoreStatuses(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<BrStoreStatus[]> {
  const [stores, rows] = await Promise.all([
    prisma.sellerAccount.findMany({
      where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
      take: 500,
    }),
    prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: SALES_TRAFFIC_DATE_FRESHNESS_KEY, ...storeWhere(scope) },
      select: { sellerAccountId: true, status: true, lastErrorCode: true, lastSuccessAt: true },
      take: 1000,
    }),
  ])
  const byStore = new Map(rows.flatMap(row => (row.sellerAccountId ? [[row.sellerAccountId, row] as const] : [])))
  return stores.map<BrStoreStatus>(store => {
    const row = byStore.get(store.id)
    let state: BrStoreState = 'NO_RECORD'
    if (row) state = row.status === 'NORMAL' ? 'AVAILABLE' : row.lastErrorCode === SALES_TRAFFIC_NO_BRAND ? 'NO_BRAND' : 'FAILED'
    const note =
      state === 'AVAILABLE'
        ? '数据中心的销售与流量每天同步一次'
        : state === 'NO_BRAND'
          ? `未授权：${BR_NO_BRAND_NOTE}`
          : state === 'FAILED'
            ? (freshnessErrorMessage(row?.lastErrorCode) ?? '同步失败，请稍后重试或查看同步中心')
            : '这家店还没有同步过销售与流量，授权后每天同步一次'
    return { sellerAccountId: store.id, storeName: store.displayName, state, stateLabel: BR_STORE_STATE_LABEL[state], note, lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null }
  })
}

export interface AsinGroup {
  sellerAccountId: string
  asin: string
  sku: string
  source: string
  orderedSales: number | null
  units: number | null
  ordersCount: number | null
  sessions: number | null
  pageViews: number | null
  buyBoxPct: number | null
}

/** 按 店铺 × ASIN × SKU × 来源 汇总范围内的 ASIN 日表（数据库汇总，不读逐日行）。 */
export async function loadAsinGroups(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  level: BrLevel,
  from: string,
  to: string,
  keyword: string | undefined,
): Promise<{ groups: AsinGroup[]; truncated: boolean }> {
  const where: Prisma.SalesTrafficAsinDailyWhereInput = {
    tenantId,
    ...storeWhere(scope),
    asinGranularity: level,
    currency: CURRENCY,
    date: { gte: asDate(from), lte: asDate(to) },
    ...(keyword ? { OR: [{ asin: { contains: keyword, mode: 'insensitive' } }, { sku: { contains: keyword, mode: 'insensitive' } }] } : {}),
  }
  const found = await prisma.salesTrafficAsinDaily.groupBy({
    by: ['sellerAccountId', 'asin', 'sku', 'source'],
    where,
    _sum: { orderedSales: true, units: true, ordersCount: true, sessions: true, pageViews: true },
    _avg: { buyBoxPct: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { sku: 'asc' }, { source: 'asc' }],
    take: BR_ASIN_GROUP_LIMIT + 1,
  })
  const groups = found.slice(0, BR_ASIN_GROUP_LIMIT).map<AsinGroup>(group => ({
    sellerAccountId: group.sellerAccountId,
    asin: group.asin,
    sku: group.sku,
    source: group.source,
    orderedSales: num(group._sum.orderedSales),
    units: group._sum.units,
    ordersCount: group._sum.ordersCount,
    sessions: group._sum.sessions,
    pageViews: group._sum.pageViews,
    buyBoxPct: num(group._avg.buyBoxPct),
  }))
  return { groups, truncated: found.length > BR_ASIN_GROUP_LIMIT }
}

/** 同键两个来源只留数据中心的（没有才用报告补充）。 */
export function preferGroups(groups: readonly AsinGroup[]): AsinGroup[] {
  const best = new Map<string, AsinGroup>()
  for (const group of groups) {
    const key = `${group.sellerAccountId}|${group.asin}|${group.sku}`
    const current = best.get(key)
    if (!current || (group.source === 'DATA_KIOSK' && current.source !== 'DATA_KIOSK')) best.set(key, group)
  }
  return [...best.values()]
}

/** 一组 ASIN（子体粒度）的逐日行（P4-03：父体与对比模式用），列名对齐成店铺日行的形状；同一 ASIN 的来源取舍由调用方按 ASIN 分别做。 */
export async function loadFamilyDaily(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  asins: readonly string[],
  from: string,
  to: string,
): Promise<{ rows: Array<BrRow & { asin: string }>; truncated: boolean }> {
  if (asins.length === 0) return { rows: [], truncated: false }
  const found = await prisma.salesTrafficAsinDaily.findMany({
    where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, asinGranularity: 'CHILD', currency: CURRENCY, date: { gte: asDate(from), lte: asDate(to) } },
    select: { asin: true, sellerAccountId: true, date: true, source: true, orderedSales: true, units: true, ordersCount: true, sessions: true, pageViews: true, buyBoxPct: true, unitSessionPct: true },
    orderBy: [{ date: 'asc' }, { asin: 'asc' }, { sellerAccountId: 'asc' }, { source: 'asc' }],
    take: BR_ROW_LIMIT + 1,
  })
  const rows = found.slice(0, BR_ROW_LIMIT).map(row => ({
    asin: row.asin,
    sellerAccountId: row.sellerAccountId,
    date: dateText(row.date),
    source: row.source,
    orderedSales: num(row.orderedSales),
    unitsOrdered: row.units,
    ordersCount: row.ordersCount,
    sessions: row.sessions,
    pageViews: row.pageViews,
    buyBoxPct: num(row.buyBoxPct),
    unitSessionPct: num(row.unitSessionPct),
    unitsRefunded: null,
  }))
  return { rows, truncated: found.length > BR_ROW_LIMIT }
}

/** 一个 ASIN（子体粒度）的逐日行，店铺范围内所有店铺；列名对齐成店铺日行的形状（退款件数官方不在 ASIN 粒度提供，为空）。 */
export async function loadAsinDaily(prisma: PrismaService, tenantId: string, scope: ResolvedScope, asin: string, from: string, to: string): Promise<{ rows: BrRow[]; truncated: boolean }> {
  const found = await prisma.salesTrafficAsinDaily.findMany({
    where: { tenantId, ...storeWhere(scope), asin, asinGranularity: 'CHILD', currency: CURRENCY, date: { gte: asDate(from), lte: asDate(to) } },
    select: { sellerAccountId: true, date: true, source: true, orderedSales: true, units: true, ordersCount: true, sessions: true, pageViews: true, buyBoxPct: true, unitSessionPct: true },
    orderBy: [{ date: 'asc' }, { sellerAccountId: 'asc' }, { source: 'asc' }],
    take: BR_ROW_LIMIT + 1,
  })
  const rows = found.slice(0, BR_ROW_LIMIT).map<BrRow>(row => ({
    sellerAccountId: row.sellerAccountId,
    date: dateText(row.date),
    source: row.source,
    orderedSales: num(row.orderedSales),
    unitsOrdered: row.units,
    ordersCount: row.ordersCount,
    sessions: row.sessions,
    pageViews: row.pageViews,
    buyBoxPct: num(row.buyBoxPct),
    unitSessionPct: num(row.unitSessionPct),
    unitsRefunded: null,
  }))
  return { rows, truncated: found.length > BR_ROW_LIMIT }
}

export interface ProductRef {
  id: string
  sellerAccountId: string
  sellerSku: string
  asin: string
  title: string
  parentAsin: string | null
}

/** 范围内与这些 ASIN 或 SKU 对应的商品目录记录（取标题、父体与 ASIN 360 编号）；最多读 19,999 行。 */
export async function loadProductRefs(prisma: PrismaService, tenantId: string, scope: ResolvedScope, filter: { asins: readonly string[]; skus: readonly string[] }): Promise<ProductRef[]> {
  const or: Prisma.FbaProductWhereInput[] = []
  if (filter.asins.length) or.push({ asin: { in: [...filter.asins] } })
  if (filter.skus.length) or.push({ sellerSku: { in: [...filter.skus] } })
  if (or.length === 0) return []
  return prisma.fbaProduct.findMany({
    where: { tenantId, ...storeWhere(scope), OR: or },
    select: { id: true, sellerAccountId: true, sellerSku: true, asin: true, title: true, parentAsin: true },
    orderBy: { id: 'asc' },
    take: BR_ROW_LIMIT,
  })
}
