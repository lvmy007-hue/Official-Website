import { adsShareOf } from './ads-campaigns-math'
import type { AdsAsinRow, AdsAsinSort, AdsAsinSummary } from './ads-products'
import { addNullable, type AdsTotals } from './ads-overview-math'

// 广告商品页的纯函数（P3-09）：行键、自然销售额、合计、排序、关键字匹配、汇总。API 与前端共用；全部可空：来源没给的值是 null，不当 0。

/** “店铺 × ASIN”的行键；广告账户没有绑定店铺时店铺位是 '-'。 */
export const adsAsinKey = (storeId: string | null, asin: string): string => `${storeId ?? '-'}|${asin}`

/** 两组合计相加：花费与销售额只要有一边给了就算已知（全部为空才是空），展示、点击、订单直接相加。 */
export function mergeTotals(a: AdsTotals, b: AdsTotals): AdsTotals {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    spend: addNullable([a.spend, b.spend]),
    sales: addNullable([a.sales, b.sales]),
    orders: a.orders + b.orders,
  }
}

/**
 * 自然销售额 = 全部销售额 − 广告销售额。任一项缺失不给；广告销售额大于全部销售额说明两个口径的统计时点不同
 * （广告按归因窗口计、订单按下单日计），差额为负没有意义，不给数并标出原因，不夹成 0。
 */
export function organicOf(totalSales: number | null, adsSales: number | null): { value: number | null; issue: AdsAsinRow['organicIssue'] } {
  if (totalSales === null || adsSales === null) return { value: null, issue: null }
  if (adsSales > totalSales) return { value: null, issue: 'ATTRIBUTION_EXCEEDS_TOTAL' }
  return { value: Math.round((totalSales - adsSales) * 1e6) / 1e6, issue: null }
}

/** 广告花费 ÷ 该 ASIN 的全部销售额。 */
export const asinAdsShare = (spend: number | null, totalSales: number | null): number | null => adsShareOf(spend, totalSales)

/** ASIN 或商品名称包含关键字（不分大小写）。 */
export function asinMatches(row: Pick<AdsAsinRow, 'asin' | 'title'>, q: string | undefined): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return row.asin.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle)
}

function sortValue(row: AdsAsinRow, sort: AdsAsinSort): number | string | null {
  switch (sort) {
    case 'spend':
      return row.totals.spend
    case 'sales':
      return row.totals.sales
    case 'orders':
      return row.totals.orders
    case 'adsShare':
      return row.adsShare
    case 'organicSales':
      return row.organicSales
    case 'totalSales':
      return row.totalSales
    case 'campaigns':
      return row.campaigns
    case 'asin':
      return row.asin
    default:
      return row.ratios[sort]
  }
}

/** 列表排序：空值永远排在最后（不论升降序），并列按 ASIN 再按行键，保证翻页顺序稳定。普通字符串比较，不用 localeCompare。 */
export function compareAsinRows(a: AdsAsinRow, b: AdsAsinRow, sort: AdsAsinSort, dir: 'asc' | 'desc'): number {
  const left = sortValue(a, sort)
  const right = sortValue(b, sort)
  if (left === null && right !== null) return 1
  if (left !== null && right === null) return -1
  if (left !== null && right !== null && left !== right) return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1)
  if (a.asin !== b.asin) return a.asin < b.asin ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** 过滤后全部行的汇总；断货只认库存已知且可售为 0 的商品。 */
export function summarizeAsins(rows: readonly AdsAsinRow[]): AdsAsinSummary {
  const stockedOut = rows.filter(row => row.stock === 'OUT_OF_STOCK')
  return {
    products: rows.length,
    spend: addNullable(rows.map(row => row.totals.spend)),
    sales: addNullable(rows.map(row => row.totals.sales)),
    outOfStock: { products: stockedOut.length, spend: addNullable(stockedOut.map(row => row.totals.spend)) },
  }
}
