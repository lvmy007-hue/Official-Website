import { RETURN_ANALYSIS_ROW_CAP, RETURN_RANK_ROWS, rankMovers, returnRate, threePeriods, type ReturnRankRow, type ReturnRanks } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { asDate } from '../overview'
import type { AnalysisOpen } from './returns-analysis-context'

// 异常榜与改善榜（P6-13）：按 ASIN 比较本期、上期、上上期（等长）的退货件数，各取前 RETURN_RANK_ROWS 名。
// 每一期的分组汇总最多读 RETURN_ANALYSIS_ROW_CAP 个 ASIN，超出标 truncated；三期退货率的分母是各期的销售件数（经营日汇总），没有汇总时为 null。

const PERIOD_LABEL = { current: '本期', previous: '上期', beforePrevious: '上上期' } as const
type PeriodKey = keyof typeof PERIOD_LABEL
const KEYS: readonly PeriodKey[] = ['current', 'previous', 'beforePrevious']

export async function loadRanks(prisma: PrismaService, a: AnalysisOpen<unknown>): Promise<ReturnRanks> {
  const periods = threePeriods(a.from, a.to)
  const groups = await Promise.all(
    KEYS.map(key =>
      prisma.fbaReturnCase.groupBy({
        by: ['asin'],
        where: a.inRange(periods[key].from, periods[key].to),
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: RETURN_ANALYSIS_ROW_CAP,
      }),
    ),
  )
  const truncated = groups.some(rows => rows.length >= RETURN_ANALYSIS_ROW_CAP)
  const units = new Map<string, Record<PeriodKey, number>>()
  KEYS.forEach((key, index) => {
    for (const row of groups[index]!) {
      const entry = units.get(row.asin) ?? { current: 0, previous: 0, beforePrevious: 0 }
      entry[key] = row._sum.quantity ?? 0
      units.set(row.asin, entry)
    }
  })
  const { anomalies, improvements } = rankMovers(
    [...units.entries()].map(([asin, value]) => ({ asin, ...value })),
    RETURN_RANK_ROWS,
  )
  const shown = [...new Set([...anomalies, ...improvements].map(row => row.asin))]
  const header = KEYS.map(key => ({ key, label: PERIOD_LABEL[key], from: periods[key].from, to: periods[key].to }))
  if (shown.length === 0) return { periods: header, anomalies: [], improvements: [], truncated }

  const store = storeWhere(a.scope)
  const [sold, products] = await Promise.all([
    Promise.all(
      KEYS.map(key =>
        prisma.asinDailySummary.groupBy({
          by: ['asin'],
          where: { tenantId: a.tenantId, ...store, asin: { in: shown }, summaryDate: { gte: asDate(periods[key].from), lte: asDate(periods[key].to) } },
          _sum: { units: true },
        }),
      ),
    ),
    prisma.fbaProduct.findMany({ where: { tenantId: a.tenantId, ...store, asin: { in: shown } }, select: { id: true, asin: true, title: true }, orderBy: { updatedAt: 'desc' }, take: 500 }),
  ])
  const soldOf = KEYS.map((_key, index) => new Map(sold[index]!.map(row => [row.asin, row._sum.units ?? 0])))
  const productOf = new Map<string, { id: string; title: string }>()
  for (const product of products) if (!productOf.has(product.asin)) productOf.set(product.asin, product)
  const toRow = (row: (typeof anomalies)[number]): ReturnRankRow => ({
    ...row,
    rates: {
      current: returnRate(row.current, soldOf[0]!.get(row.asin) ?? null),
      previous: returnRate(row.previous, soldOf[1]!.get(row.asin) ?? null),
      beforePrevious: returnRate(row.beforePrevious, soldOf[2]!.get(row.asin) ?? null),
    },
    productId: productOf.get(row.asin)?.id ?? null,
    title: productOf.get(row.asin)?.title ?? null,
  })
  return { periods: header, anomalies: anomalies.map(toRow), improvements: improvements.map(toRow), truncated }
}
