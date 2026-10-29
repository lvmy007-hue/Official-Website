import { BA_PERIOD_LABEL, BA_ROW_LIMIT, type AdTermBrandShare, type BaPeriod } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'

// 词级分析页的“品牌分析份额”块（P4-04 接入，08 章 8.7 与 04 章 4.7 同屏）：
// 读品牌分析的搜索查询表现（R-35），取这个词最近一个有数据的周期；按“店铺”汇总我方 ASIN，再把各店铺相加。
// 词按“不分大小写、整串相等”匹配（与词级分析页其余部分一致）；没有这个词的记录整块不显示（返回 null），不显示成 0。

interface Row {
  sellerAccountId: string
  searchVolume: number | null
  clicksTotal: number | null
  clicksOwn: number | null
  purchasesTotal: number | null
  purchasesOwn: number | null
}

const share = (own: number, total: number): number | null => (total > 0 ? own / total : null)

/** 同一店铺里各个我方 ASIN 的“我方”数量相加、“市场总量”取同一个词的最大值（各行是同一个市场总量）；任一店铺缺值则该份额为空。 */
export function brandShareOf(rows: readonly Row[]): Pick<AdTermBrandShare, 'searchVolume' | 'clickShare' | 'purchaseShare'> {
  const byStore = new Map<string, Row[]>()
  for (const row of rows) byStore.set(row.sellerAccountId, [...(byStore.get(row.sellerAccountId) ?? []), row])
  let volume: number | null = null
  const click = { own: 0, total: 0, ok: true }
  const purchase = { own: 0, total: 0, ok: true }
  const fold = (acc: typeof click, stores: readonly Row[], own: 'clicksOwn' | 'purchasesOwn', total: 'clicksTotal' | 'purchasesTotal') => {
    const totals = stores.map(row => row[total]).filter((value): value is number => value !== null)
    const owns = stores.map(row => row[own]).filter((value): value is number => value !== null)
    if (totals.length === 0 || owns.length === 0) {
      acc.ok = false
      return
    }
    acc.total += Math.max(...totals)
    acc.own += owns.reduce((sum, value) => sum + value, 0)
  }
  for (const stores of byStore.values()) {
    const volumes = stores.map(row => row.searchVolume).filter((value): value is number => value !== null)
    if (volumes.length > 0) volume = (volume ?? 0) + Math.max(...volumes)
    fold(click, stores, 'clicksOwn', 'clicksTotal')
    fold(purchase, stores, 'purchasesOwn', 'purchasesTotal')
  }
  return {
    searchVolume: volume,
    clickShare: click.ok ? share(click.own, click.total) : null,
    purchaseShare: purchase.ok ? share(purchase.own, purchase.total) : null,
  }
}

export async function loadBrandShare(prisma: PrismaService, tenantId: string, scope: ResolvedScope, term: string): Promise<AdTermBrandShare | null> {
  const where = { tenantId, ...storeWhere(scope), searchQuery: { equals: term, mode: 'insensitive' as const } }
  const latest = await prisma.brandSearchQueryPerformance.findFirst({
    where,
    // 同一起始日有几种周期时取最短的（周的结束日最早），数据最新
    orderBy: [{ periodStart: 'desc' }, { periodEnd: 'asc' }],
    select: { reportPeriod: true, periodStart: true, periodEnd: true, sourceUpdatedAt: true },
  })
  if (!latest) return null
  const rows = await prisma.brandSearchQueryPerformance.findMany({
    where: { ...where, reportPeriod: latest.reportPeriod, periodStart: latest.periodStart },
    select: { sellerAccountId: true, searchVolume: true, clicksTotal: true, clicksOwn: true, purchasesTotal: true, purchasesOwn: true, sourceUpdatedAt: true },
    orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
    take: BA_ROW_LIMIT,
  })
  const kind = latest.reportPeriod as BaPeriod
  const updated = rows.reduce((max, row) => (row.sourceUpdatedAt > max ? row.sourceUpdatedAt : max), latest.sourceUpdatedAt)
  return {
    ...brandShareOf(rows),
    periodText: `${BA_PERIOD_LABEL[kind] ?? latest.reportPeriod}：${latest.periodStart.toISOString().slice(0, 10)} 至 ${latest.periodEnd.toISOString().slice(0, 10)}`,
    sourceUpdatedAt: updated.toISOString(),
  }
}
