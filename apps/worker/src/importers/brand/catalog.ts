import { get } from '../../datakiosk/json'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { asinOf, dateOnly, firstCurrency, fraction, price, qty, readPeriod, type BrandReportOptions } from './parse'

// 品牌分析·目录表现（importers.md R-36，GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT，JSON）→ BrandSearchCatalogPerformance（P4-04）。
// 报告形状：{ reportSpecification, dataByAsin: [{ startDate, endDate, asin, impressionData, clickData, cartAddData, purchaseData }] }：
// 每行是“一个 ASIN × 一个周期”的搜索漏斗（展示、点击、加购、购买），带官方点击率、转化率、搜索流量销售额与各阶段价格中位数。
// **字段名对照官方样例整理，没有对真实店铺核对**；官方没给的值是 null（不补 0）。

export function readCatalogRow(row: Row, options: BrandReportOptions) {
  const period = readPeriod(row, options)
  const asin = asinOf(row.asin)
  if (!period || !asin) return null
  const impression = get(row, 'impressionData')
  const click = get(row, 'clickData')
  const cart = get(row, 'cartAddData')
  const purchase = get(row, 'purchaseData')
  const prices = [price(get(impression, 'impressionMedianPrice')), price(get(click, 'clickedMedianPrice')), price(get(cart, 'cartAddedMedianPrice')), price(get(purchase, 'purchasedMedianPrice'))]
  const sales = price(get(purchase, 'searchTrafficSales'))
  const values = {
    impressions: qty(get(impression, 'impressionCount')),
    clicks: qty(get(click, 'clickCount')),
    cartAdds: qty(get(cart, 'cartAddCount')),
    purchases: qty(get(purchase, 'purchaseCount')),
    clickRate: fraction(get(click, 'clickRate')),
    conversionRate: fraction(get(purchase, 'conversionRate')),
    searchTrafficSales: sales?.amount ?? null,
    impressionMedianPrice: prices[0]?.amount ?? null,
    clickMedianPrice: prices[1]?.amount ?? null,
    cartAddMedianPrice: prices[2]?.amount ?? null,
    purchaseMedianPrice: prices[3]?.amount ?? null,
    currency: firstCurrency(sales, ...prices),
  }
  return { period, asin, values }
}

export function syncCatalogPerformanceReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: BrandReportOptions = {}): Promise<ImportResult> {
  const now = options.now ?? new Date()
  const scope = { tenantId, sellerAccountId }
  return importRows(
    ctx,
    rows,
    async (inner, row) => {
      const parsed = readCatalogRow(row, options)
      if (!parsed) return 'skipped'
      const { period, asin, values } = parsed
      const periodStart = dateOnly(period.start)
      const data = { ...values, periodEnd: dateOnly(period.end), sourceReportJobId: options.reportJobId ?? null, sourceUpdatedAt: now, syncedAt: now }
      await inner.prisma.brandSearchCatalogPerformance.upsert({
        where: { tenantId_sellerAccountId_reportPeriod_periodStart_asin: { ...scope, reportPeriod: period.kind, periodStart, asin } },
        create: { ...scope, reportPeriod: period.kind, periodStart, asin, ...data },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'brand catalog performance rows without a usable period or asin were skipped', logFields: scope },
  )
}
