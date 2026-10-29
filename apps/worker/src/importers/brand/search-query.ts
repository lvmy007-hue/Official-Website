import { get } from '../../datakiosk/json'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { asinOf, dateOnly, firstCurrency, fraction, price, qty, readPeriod, textOf, type BrandReportOptions } from './parse'

// 品牌分析·搜索查询表现（importers.md R-35，GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT，JSON）→ BrandSearchQueryPerformance（P4-04）。
// 报告形状：{ reportSpecification, dataByAsin: [{ startDate, endDate, asin, searchQueryData, impressionData, clickData, cartAddData, purchaseData }] }，
// 由流式读取器逐个数组元素交出。每行是“一个 ASIN × 一个搜索词 × 一个周期”：总量（全市场）与我方两套次数，加官方份额；
// 价格中位数（点击、加购、购买 × 总量、我方）；购买阶段的配送速度（当日达、次日达、两日达 × 总量、我方）。
// **字段名对照官方样例整理，没有对真实店铺核对**；官方没给的值是 null（不补 0）。

export interface SqpRow {
  period: NonNullable<ReturnType<typeof readPeriod>>
  asin: string
  searchQuery: string
  values: Record<string, number | string | null>
}

const money = (block: unknown, key: string) => price(get(block, key))

/** 一行报告 → 周期、ASIN、搜索词与全部指标；缺周期、ASIN、搜索词时返回 null。 */
export function readSqpRow(row: Row, options: BrandReportOptions): SqpRow | null {
  const period = readPeriod(row, options)
  const asin = asinOf(row.asin)
  const searchQuery = textOf(get(row, 'searchQueryData', 'searchQuery'))?.toLowerCase() ?? null
  if (!period || !asin || !searchQuery) return null
  const impression = get(row, 'impressionData')
  const click = get(row, 'clickData')
  const cart = get(row, 'cartAddData')
  const purchase = get(row, 'purchaseData')
  const clickPrice = { total: money(click, 'totalMedianClickPrice'), own: money(click, 'asinMedianClickPrice') }
  const cartPrice = { total: money(cart, 'totalMedianCartAddPrice'), own: money(cart, 'asinMedianCartAddPrice') }
  const purchasePrice = { total: money(purchase, 'totalMedianPurchasePrice'), own: money(purchase, 'asinMedianPurchasePrice') }
  const values = {
    searchQueryScore: qty(get(row, 'searchQueryData', 'searchQueryScore')),
    searchVolume: qty(get(row, 'searchQueryData', 'searchQueryVolume')),
    impressionsTotal: qty(get(impression, 'totalQueryImpressionCount')),
    impressionsOwn: qty(get(impression, 'asinImpressionCount')),
    impressionShare: fraction(get(impression, 'asinImpressionShare')),
    clicksTotal: qty(get(click, 'totalClickCount')),
    clicksOwn: qty(get(click, 'asinClickCount')),
    clickShare: fraction(get(click, 'asinClickShare')),
    cartAddsTotal: qty(get(cart, 'totalCartAddCount')),
    cartAddsOwn: qty(get(cart, 'asinCartAddCount')),
    cartAddShare: fraction(get(cart, 'asinCartAddShare')),
    purchasesTotal: qty(get(purchase, 'totalPurchaseCount')),
    purchasesOwn: qty(get(purchase, 'asinPurchaseCount')),
    purchaseShare: fraction(get(purchase, 'asinPurchaseShare')),
    clickPriceTotal: clickPrice.total?.amount ?? null,
    clickPriceOwn: clickPrice.own?.amount ?? null,
    cartAddPriceTotal: cartPrice.total?.amount ?? null,
    cartAddPriceOwn: cartPrice.own?.amount ?? null,
    purchasePriceTotal: purchasePrice.total?.amount ?? null,
    purchasePriceOwn: purchasePrice.own?.amount ?? null,
    currency: firstCurrency(purchasePrice.own, purchasePrice.total, clickPrice.own, clickPrice.total, cartPrice.own, cartPrice.total),
    purchasesSameDayTotal: qty(get(purchase, 'totalSameDayShippingPurchaseCount')),
    purchasesSameDayOwn: qty(get(purchase, 'asinSameDayShippingPurchaseCount')),
    purchasesOneDayTotal: qty(get(purchase, 'totalOneDayShippingPurchaseCount')),
    purchasesOneDayOwn: qty(get(purchase, 'asinOneDayShippingPurchaseCount')),
    purchasesTwoDayTotal: qty(get(purchase, 'totalTwoDayShippingPurchaseCount')),
    purchasesTwoDayOwn: qty(get(purchase, 'asinTwoDayShippingPurchaseCount')),
  }
  return { period, asin, searchQuery, values }
}

export function syncSearchQueryReport(ctx: ImportContext, rows: AsyncIterable<Row>, tenantId: string, sellerAccountId: string, options: BrandReportOptions = {}): Promise<ImportResult> {
  const now = options.now ?? new Date()
  const scope = { tenantId, sellerAccountId }
  return importRows(
    ctx,
    rows,
    async (inner, row) => {
      const parsed = readSqpRow(row, options)
      if (!parsed) return 'skipped'
      const { period, asin, searchQuery, values } = parsed
      const periodStart = dateOnly(period.start)
      const data = { ...values, periodEnd: dateOnly(period.end), sourceReportJobId: options.reportJobId ?? null, sourceUpdatedAt: now, syncedAt: now }
      await inner.prisma.brandSearchQueryPerformance.upsert({
        where: { tenantId_sellerAccountId_reportPeriod_periodStart_asin_searchQuery: { ...scope, reportPeriod: period.kind, periodStart, asin, searchQuery } },
        create: { ...scope, reportPeriod: period.kind, periodStart, asin, searchQuery, ...data },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'brand search query rows without a usable period, asin or search query were skipped', logFields: scope },
  )
}
