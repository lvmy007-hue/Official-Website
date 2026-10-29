import { SALES_TRAFFIC_SOURCE_DIFF, salesTrafficDiffs, type SalesTrafficFigures } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'

// 销售与流量的来源核对（P4-01，importers.md R-34 的 ST_SOURCE_DIFF）：报告补充来源与数据中心同键数据差异超过阈值时记一行 SalesTrafficDiff，只记录，不覆盖任何一边。
// 两边都有的键才比较（只有一边有数据不算差异）；某个键再次核对时差异消失，之前记的行删除。必须在租户上下文（runWithTenant）里调用。

export interface DiffScope {
  tenantId: string
  sellerAccountId: string
}

const ROW_LIMIT = 50_000
const num = (value: { toNumber(): number } | null | undefined) => (value === null || value === undefined ? null : value.toNumber())
const dayKey = (date: Date) => date.toISOString().slice(0, 10)

interface Candidate {
  level: string
  date: Date
  asin: string
  sku: string
  kiosk: SalesTrafficFigures
  report: SalesTrafficFigures
}

type Db = Pick<PrismaClient, 'salesTrafficDaily' | 'salesTrafficAsinDaily' | 'salesTrafficDiff'>

async function dailyCandidates(db: Db, scope: DiffScope, dates: Date[]): Promise<Candidate[]> {
  const rows = await db.salesTrafficDaily.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, granularity: 'DAY', date: { in: dates } },
    select: { date: true, source: true, orderedSales: true, unitsOrdered: true, sessions: true, pageViews: true },
    take: ROW_LIMIT,
  })
  const figures = (row: (typeof rows)[number]): SalesTrafficFigures => ({ orderedSales: num(row.orderedSales), unitsOrdered: row.unitsOrdered, sessions: row.sessions, pageViews: row.pageViews })
  return dates.flatMap(date => {
    const kiosk = rows.find(row => row.source === 'DATA_KIOSK' && dayKey(row.date) === dayKey(date))
    const report = rows.find(row => row.source === 'REPORT' && dayKey(row.date) === dayKey(date))
    return kiosk && report ? [{ level: 'DAY', date, asin: '', sku: '', kiosk: figures(kiosk), report: figures(report) }] : []
  })
}

async function asinCandidates(db: Db, scope: DiffScope, dates: Date[], logger: Logger): Promise<Candidate[]> {
  const rows = await db.salesTrafficAsinDaily.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, date: { in: dates } },
    select: { date: true, asin: true, asinGranularity: true, sku: true, source: true, orderedSales: true, units: true, sessions: true, pageViews: true },
    take: ROW_LIMIT,
  })
  if (rows.length >= ROW_LIMIT) logger.warn({ ...scope, limit: ROW_LIMIT }, 'sales traffic asin diff check truncated')
  const figures = (row: (typeof rows)[number]): SalesTrafficFigures => ({ orderedSales: num(row.orderedSales), unitsOrdered: row.units, sessions: row.sessions, pageViews: row.pageViews })
  const keyOf = (row: (typeof rows)[number]) => [row.asinGranularity, row.asin, row.sku, dayKey(row.date)].join('|')
  const kiosk = new Map(rows.filter(row => row.source === 'DATA_KIOSK').map(row => [keyOf(row), row]))
  return rows
    .filter(row => row.source === 'REPORT' && kiosk.has(keyOf(row)))
    .map(row => ({ level: row.asinGranularity, date: row.date, asin: row.asin, sku: row.sku, kiosk: figures(kiosk.get(keyOf(row))!), report: figures(row) }))
}

/** 对给定日期（美国站日历日）核对两个来源，返回记录的差异条数。 */
export async function recordSourceDiffs(db: Db, scope: DiffScope, dates: Date[], logger: Logger, now: Date = new Date()): Promise<number> {
  if (dates.length === 0) return 0
  const unique = [...new Map(dates.map(date => [dayKey(date), date])).values()]
  const candidates = [...(await dailyCandidates(db, scope, unique)), ...(await asinCandidates(db, scope, unique, logger))]
  const keep = new Set<string>()
  let recorded = 0
  for (const candidate of candidates) {
    for (const diff of salesTrafficDiffs(candidate.kiosk, candidate.report)) {
      const key = [candidate.level, dayKey(candidate.date), candidate.asin, candidate.sku, diff.metric].join('|')
      keep.add(key)
      const data = { kioskValue: diff.kioskValue, reportValue: diff.reportValue, delta: diff.delta, relativeDiff: diff.relative, detectedAt: now }
      await db.salesTrafficDiff.upsert({
        where: {
          tenantId_sellerAccountId_level_date_asin_sku_metric: {
            tenantId: scope.tenantId,
            sellerAccountId: scope.sellerAccountId,
            level: candidate.level,
            date: candidate.date,
            asin: candidate.asin,
            sku: candidate.sku,
            metric: diff.metric,
          },
        },
        create: {
          tenantId: scope.tenantId,
          sellerAccountId: scope.sellerAccountId,
          level: candidate.level,
          date: candidate.date,
          asin: candidate.asin,
          sku: candidate.sku,
          metric: diff.metric,
          ...data,
        },
        update: data,
      })
      recorded += 1
    }
  }
  // 这些日期里不再有差异的键：删除旧记录
  const existing = await db.salesTrafficDiff.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, date: { in: unique } },
    select: { id: true, level: true, date: true, asin: true, sku: true, metric: true },
  })
  const stale = existing.filter(row => !keep.has([row.level, dayKey(row.date), row.asin, row.sku, row.metric].join('|'))).map(row => row.id)
  if (stale.length > 0) await db.salesTrafficDiff.deleteMany({ where: { tenantId: scope.tenantId, id: { in: stale } } })
  if (recorded > 0) logger.warn({ ...scope, code: SALES_TRAFFIC_SOURCE_DIFF, recorded }, 'sales traffic report differs from data kiosk beyond tolerance')
  return recorded
}
