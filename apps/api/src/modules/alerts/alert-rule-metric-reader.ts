import type { InventoryDayRow, RuleMetricReader, StoreDayRow, TrafficDayRow } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'

// 试算用的指标取数（P6-16）：从日汇总表读出取数层（api-contracts 的 rule-metric-source）需要的行。
// worker 的 custom-metric-evaluator.ts 里有一份同样的读取（评估用），改口径时两处一起改；窗口换算与聚合只有契约里这一份。

const READ_LIMIT = 20_000
const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const day = (date: Date) => date.toISOString().slice(0, 10)
const dateOf = (value: string) => new Date(`${value}T00:00:00Z`)

type ReaderDb = Pick<PrismaService, 'storeDailySummary' | 'salesTrafficDaily' | 'inventoryDailySnapshot'>

export function prismaRuleMetricReader(db: ReaderDb): RuleMetricReader {
  return {
    async storeDays(tenantId, storeIds, from, to) {
      const rows = await db.storeDailySummary.findMany({
        where: { tenantId, sellerAccountId: { in: [...storeIds] }, summaryDate: { gte: dateOf(from), lte: dateOf(to) } },
        select: { sellerAccountId: true, summaryDate: true, orders: true, units: true, salesAmount: true, adsSpend: true, adsSales: true, profit: true, sessions: true },
        take: READ_LIMIT,
      })
      return rows.map<StoreDayRow & { storeId: string }>(row => ({
        storeId: row.sellerAccountId,
        date: day(row.summaryDate),
        orders: row.orders,
        units: row.units,
        sales: num(row.salesAmount) ?? 0,
        adsSpend: num(row.adsSpend),
        adsSales: num(row.adsSales),
        profit: num(row.profit),
        sessions: row.sessions,
      }))
    },
    async trafficDays(tenantId, storeIds, from, to) {
      const rows = await db.salesTrafficDaily.findMany({
        where: { tenantId, sellerAccountId: { in: [...storeIds] }, granularity: 'DAY', date: { gte: dateOf(from), lte: dateOf(to) } },
        select: { sellerAccountId: true, date: true, unitsOrdered: true, unitsRefunded: true },
        orderBy: { syncedAt: 'asc' },
        take: READ_LIMIT,
      })
      return rows.map<TrafficDayRow & { storeId: string }>(row => ({ storeId: row.sellerAccountId, date: day(row.date), unitsOrdered: row.unitsOrdered, unitsRefunded: row.unitsRefunded }))
    },
    async inventoryDays(tenantId, storeIds, from, to) {
      const rows = await db.inventoryDailySnapshot.groupBy({
        by: ['sellerAccountId', 'snapshotDate', 'source'],
        where: { tenantId, sellerAccountId: { in: [...storeIds] }, snapshotDate: { gte: dateOf(from), lte: dateOf(to) }, sellable: { not: null } },
        _sum: { sellable: true },
        orderBy: [{ sellerAccountId: 'asc' }, { snapshotDate: 'asc' }, { source: 'asc' }],
        take: READ_LIMIT,
      })
      const best = new Map<string, InventoryDayRow & { storeId: string }>()
      for (const row of rows) {
        const sellable = num(row._sum.sellable)
        if (sellable === null) continue
        const key = `${row.sellerAccountId}|${day(row.snapshotDate)}`
        const current = best.get(key)
        if (!current || sellable > current.sellable) best.set(key, { storeId: row.sellerAccountId, date: day(row.snapshotDate), sellable })
      }
      return [...best.values()]
    },
  }
}
