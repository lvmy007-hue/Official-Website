import { get } from '../../datakiosk/json'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { asinOf, dateOnly, fraction, rank, readPeriod, type BrandReportOptions } from './parse'

// 品牌分析·购物篮分析（importers.md R-38，GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT，JSON）→ BrandMarketBasket（P4-04）。
// 报告形状：{ reportSpecification, dataByAsin: [{ startDate, endDate, asin, purchasedAsin, combinationPct, purchasedRank }] }：
// 每行是“买了 ASIN 的订单里，同时买了另一个 ASIN 的比例”。**字段名对照官方样例整理，没有对真实店铺核对**（兼容 pairedAsin、purchaseRank 两种写法）。
// 自己和自己配对的行没有意义，跳过。

export function readBasketRow(row: Row, options: BrandReportOptions) {
  const period = readPeriod(row, options)
  const asin = asinOf(row.asin)
  const pairedAsin = asinOf(get(row, 'purchasedAsin') ?? get(row, 'pairedAsin'))
  if (!period || !asin || !pairedAsin || asin === pairedAsin) return null
  const percent = get(row, 'combinationPct') ?? get(row, 'combinationPercentage')
  return { period, asin, pairedAsin, combinationPct: fraction(percent), purchaseRank: rank(get(row, 'purchasedRank') ?? get(row, 'purchaseRank')) }
}

export function syncMarketBasketReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: BrandReportOptions = {}): Promise<ImportResult> {
  const now = options.now ?? new Date()
  const scope = { tenantId, sellerAccountId }
  return importRows(
    ctx,
    rows,
    async (inner, row) => {
      const parsed = readBasketRow(row, options)
      if (!parsed) return 'skipped'
      const { period, asin, pairedAsin } = parsed
      const periodStart = dateOnly(period.start)
      const data = {
        combinationPct: parsed.combinationPct,
        purchaseRank: parsed.purchaseRank,
        periodEnd: dateOnly(period.end),
        sourceReportJobId: options.reportJobId ?? null,
        sourceUpdatedAt: now,
        syncedAt: now,
      }
      await inner.prisma.brandMarketBasket.upsert({
        where: { tenantId_sellerAccountId_reportPeriod_periodStart_asin_pairedAsin: { ...scope, reportPeriod: period.kind, periodStart, asin, pairedAsin } },
        create: { ...scope, reportPeriod: period.kind, periodStart, asin, pairedAsin, ...data },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'brand market basket rows without a usable period or asin pair were skipped', logFields: scope },
  )
}
