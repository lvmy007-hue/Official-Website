import {
  ADS_CONNECTED_PRODUCTS,
  ADS_OTHER_PRODUCT_LABEL,
  ADS_PRODUCTS,
  ADS_PRODUCT_LABEL,
  addNullable,
  addTotals,
  bucketValues,
  type AdsBudgetDay,
  type AdsFunnel,
  type AdsMixPoint,
  type AdsProductRow,
  type AdsTotals,
  type AdsTrendPoint,
  type DashGranularity,
} from '@nova/api-contracts'
import type { DailyAds, StoreDay } from './ads-overview-load'

// 广告控制台的序列装配（纯函数，不碰数据库）：趋势桶、总销售拆分、广告产品结构、漏斗、逐日预算消耗。

/** 把逐日行折成按日的合计（所有广告产品相加）。 */
export function dailyTotals(rows: readonly DailyAds[]): Map<string, AdsTotals> {
  const byDate = new Map<string, AdsTotals[]>()
  for (const row of rows) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row.totals])
  return new Map([...byDate.entries()].map(([date, items]) => [date, addTotals(items)]))
}

/** 销售与花费趋势：没有行的日子不补 0，整个桶都没有行则这个桶的值为空。 */
export function trendPoints(days: readonly string[], byDate: ReadonlyMap<string, AdsTotals>, granularity: DashGranularity): AdsTrendPoint[] {
  const spend = bucketValues(
    days.map(date => ({ date, value: byDate.get(date)?.spend ?? null })),
    granularity,
  )
  const sales = bucketValues(
    days.map(date => ({ date, value: byDate.get(date)?.sales ?? null })),
    granularity,
  )
  return spend.map((bucket, index) => ({ key: bucket.key, spend: bucket.value, sales: sales[index]?.value ?? null }))
}

/**
 * 总销售额、广告销售额、自然销售额与广告占总销售比（店铺经营日汇总口径）。
 * 自然销售额 = 总销售额 − 广告销售额；广告归因销售额大于总销售额时（归因窗口与下单日口径不同）不推算，留空。
 */
export function mixPoints(days: readonly string[], byDate: ReadonlyMap<string, StoreDay>, granularity: DashGranularity): AdsMixPoint[] {
  const series = (pick: (day: StoreDay) => number | null) =>
    bucketValues(
      days.map(date => {
        const day = byDate.get(date)
        return { date, value: day ? pick(day) : null }
      }),
      granularity,
    )
  const total = series(day => day.sales)
  const adSales = series(day => day.adsSales)
  const adSpend = series(day => day.adsSpend)
  return total.map((bucket, index) => {
    const totalSales = bucket.value
    const ad = adSales[index]?.value ?? null
    const spend = adSpend[index]?.value ?? null
    return {
      key: bucket.key,
      totalSales,
      adSales: ad,
      organicSales: totalSales !== null && ad !== null && totalSales >= ad ? totalSales - ad : null,
      adSpend: spend,
      adsShare: totalSales !== null && totalSales > 0 && spend !== null ? spend / totalSales : null,
    }
  })
}

const isKnownProduct = (value: string): value is (typeof ADS_PRODUCTS)[number] => (ADS_PRODUCTS as readonly string[]).includes(value)

/** 广告产品结构：四种已知类型一行一个（没有行：已接入的写“尚无记录”、未接入的写“未接入”），其余类型并入“其他”。 */
export function productRows(rows: readonly DailyAds[]): AdsProductRow[] {
  const groups = new Map<string, AdsTotals[]>()
  for (const row of rows) {
    const key = isKnownProduct(row.adProduct) ? row.adProduct : 'OTHER'
    groups.set(key, [...(groups.get(key) ?? []), row.totals])
  }
  const spendTotal = addNullable([...groups.values()].flat().map(item => item.spend))
  const make = (adProduct: string, label: string, items: AdsTotals[] | undefined): AdsProductRow => {
    if (!items) {
      const connected = (ADS_CONNECTED_PRODUCTS as readonly string[]).includes(adProduct)
      return {
        adProduct,
        label,
        state: connected ? 'NO_DATA' : 'NOT_CONNECTED',
        note: connected ? '所选范围内没有记录' : '该广告产品的同步器尚未接入',
        spend: null,
        sales: null,
        orders: 0,
        spendShare: null,
      }
    }
    const totals = addTotals(items)
    return {
      adProduct,
      label,
      state: 'OK',
      note: null,
      spend: totals.spend,
      sales: totals.sales,
      orders: totals.orders,
      spendShare: spendTotal !== null && spendTotal > 0 && totals.spend !== null ? totals.spend / spendTotal : null,
    }
  }
  const result = ADS_PRODUCTS.map(product => make(product, ADS_PRODUCT_LABEL[product], groups.get(product)))
  if (groups.has('OTHER')) result.push(make('OTHER', ADS_OTHER_PRODUCT_LABEL, groups.get('OTHER')))
  return result
}

export function funnelOf(totals: AdsTotals): AdsFunnel {
  return {
    impressions: totals.impressions,
    clicks: totals.clicks,
    orders: totals.orders,
    clickRate: totals.impressions > 0 ? totals.clicks / totals.impressions : null,
    conversionRate: totals.clicks > 0 ? totals.orders / totals.clicks : null,
  }
}

/** 逐日花费（范围内的每一天一个点，没有行的日子为空）。 */
export function budgetDays(days: readonly string[], byDate: ReadonlyMap<string, AdsTotals>): AdsBudgetDay[] {
  return days.map(date => ({ date, spend: byDate.get(date)?.spend ?? null }))
}
