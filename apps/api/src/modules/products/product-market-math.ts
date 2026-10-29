import type { Asin360CompetitorSlot, Asin360CompetitorTerm, Asin360PricingDay } from '@nova/api-contracts'
import type { HotTermRow } from './product-traffic-load'
import type { TrafficRow } from './product-traffic-math'

// 定价与竞品页签的纯计算（P4-08）：没有记录的日子与指标是 null，不补 0。

export interface SalesDay {
  units: number
  sales: number
}

const round = (value: number) => Math.round(value * 100) / 100

/** 范围内每天一个点：成交均价 = 销售额 ÷ 件数（当天没有件数为空）；推荐报价（购物车）获得率来自流量数据。 */
export function pricingPoints(days: readonly string[], sales: ReadonlyMap<string, SalesDay>, traffic: ReadonlyMap<string, TrafficRow>): Asin360PricingDay[] {
  return days.map(date => {
    const day = sales.get(date)
    return {
      date,
      units: day ? day.units : null,
      sales: day ? day.sales : null,
      avgPrice: day && day.units > 0 ? round(day.sales / day.units) : null,
      buyBoxPct: traffic.get(date)?.buyBoxPct ?? null,
    }
  })
}

/** 范围内的成交均价：销售额合计 ÷ 件数合计（只含有件数的日子）；一件都没卖出为 null。 */
export function averagePrice(points: readonly Asin360PricingDay[]): number | null {
  const sold = points.filter(point => point.units !== null && point.units > 0 && point.sales !== null)
  const units = sold.reduce((sum, point) => sum + point.units!, 0)
  return units > 0 ? round(sold.reduce((sum, point) => sum + point.sales!, 0) / units) : null
}

/** 核心搜索词在热门搜索词报告里的点击份额前三：标出哪个是这个 ASIN、哪些是企业里的其他商品。 */
export function competitorRows(terms: readonly string[], hot: readonly HotTermRow[], selfAsin: string, own: ReadonlySet<string>): Asin360CompetitorTerm[] {
  const self = selfAsin.toUpperCase()
  const rows: Asin360CompetitorTerm[] = []
  for (const term of terms) {
    const found = hot.find(row => row.searchTerm.toLowerCase() === term.toLowerCase())
    if (!found) continue
    const slots: Asin360CompetitorSlot[] = []
    found.slots.forEach((slot, index) => {
      if (!slot.asin && !slot.title && slot.clickShare === null && slot.conversionShare === null) return
      const asin = slot.asin?.toUpperCase() ?? null
      slots.push({
        rank: (index + 1) as 1 | 2 | 3,
        asin,
        title: slot.title,
        clickShare: slot.clickShare,
        conversionShare: slot.conversionShare,
        isSelf: asin === self,
        isOwn: asin !== null && asin !== self && own.has(asin),
      })
    })
    rows.push({ searchTerm: found.searchTerm, frequencyRank: found.frequencyRank, slots, selfRank: slots.find(slot => slot.isSelf)?.rank ?? null })
  }
  return rows
}
