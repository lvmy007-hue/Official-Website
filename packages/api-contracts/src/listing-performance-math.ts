import { LISTING_CONVERSION_DROP_RATIO, LISTING_MIN_SESSIONS, LISTING_PERF_SORTS, type ListingPerfRow, type ListingPerfSort } from './listing-performance.js'

// 刊登表现的纯函数（P4-09）：转化率、异常判断、对比表、排序取值。不碰数据库，前后端共用，保证页面与接口算的是同一件事。

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

/** 转化率 = 件数 ÷ 会话；缺任何一边或会话为 0 返回 null。 */
export function listingConversion(units: number | null, sessions: number | null): number | null {
  if (units === null || sessions === null || sessions <= 0) return null
  return round(units / sessions, 6)
}

/** 转化率骤降：两期会话都达到样本下限、转化率都算得出，且相对下降不少于阈值。样本不足或缺数据一律不报（不猜）。 */
export function isConversionDrop(current: { sessions: number | null; conversion: number | null }, previous: { sessions: number | null; conversion: number | null }): boolean {
  if (current.sessions === null || previous.sessions === null || current.conversion === null || previous.conversion === null) return false
  if (current.sessions < LISTING_MIN_SESSIONS || previous.sessions < LISTING_MIN_SESSIONS || previous.conversion <= 0) return false
  return (previous.conversion - current.conversion) / previous.conversion >= LISTING_CONVERSION_DROP_RATIO - 1e-9
}

/** 可售天数：可售数量 ÷ 日均订购件数；日均不为正或缺数据为 null。保留 1 位小数。 */
export function listingDaysOfSupply(sellable: number | null, recentUnits: number | null, days: number): number | null {
  if (sellable === null || recentUnits === null || recentUnits <= 0 || days <= 0) return null
  return round(sellable / (recentUnits / days), 1)
}

/** 退货率 = 退货件数 ÷ 订购件数；订购件数缺失或为 0 返回 null。 */
export function listingReturnRate(returned: number | null, units: number | null): number | null {
  if (returned === null || units === null || units <= 0) return null
  return round(returned / units, 6)
}

export const isListingSort = (value: string): value is ListingPerfSort => (LISTING_PERF_SORTS as readonly string[]).includes(value)

const NUMERIC: Partial<Record<ListingPerfSort, (row: ListingPerfRow) => number | null>> = {
  sales: row => row.sales,
  units: row => row.units,
  sessions: row => row.sessions,
  pageViews: row => row.pageViews,
  conversion: row => row.conversion,
  buyBox: row => row.buyBox,
  price: row => row.price,
  adsSales: row => row.adsSales,
  returnRate: row => row.returnRate,
  daysOfSupply: row => row.daysOfSupply,
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 排序：数值列没有值的永远在最后（不管升降序）；并列按编号稳定。别用 localeCompare，下划线与字母的先后随区域设置变。 */
export function compareListingRows(a: ListingPerfRow, b: ListingPerfRow, field: ListingPerfSort, dir: 'asc' | 'desc'): number {
  const sign = dir === 'asc' ? 1 : -1
  const pick = NUMERIC[field]
  if (pick) {
    const left = pick(a)
    const right = pick(b)
    if (left === null || right === null) return left === right ? compareText(a.id, b.id) : left === null ? 1 : -1
    return left === right ? compareText(a.id, b.id) : (left - right) * sign
  }
  const order = compareText(field === 'asin' ? a.asin : a.sku, field === 'asin' ? b.asin : b.sku)
  return order === 0 ? compareText(a.id, b.id) : order * sign
}

// ---- 对比模式 ----

export interface ListingCompareLine {
  key: string
  label: string
  kind: 'money' | 'number' | 'percent' | 'days'
  /** 逐个对象的值，顺序与选中的行一致；没有记录为 null。 */
  values: Array<number | null>
  /** 最大值所在的位置（至少两个对象有值才标）；全部相等或不足两个值为 null。 */
  bestIndex: number | null
}

const LINES: ReadonlyArray<{ key: string; label: string; kind: ListingCompareLine['kind']; pick: (row: ListingPerfRow) => number | null; lowerIsBetter?: boolean }> = [
  { key: 'sessions', label: '会话', kind: 'number', pick: row => row.sessions },
  { key: 'pageViews', label: '浏览量', kind: 'number', pick: row => row.pageViews },
  { key: 'conversion', label: '转化率', kind: 'percent', pick: row => row.conversion },
  { key: 'units', label: '销量', kind: 'number', pick: row => row.units },
  { key: 'sales', label: '销售额', kind: 'money', pick: row => row.sales },
  { key: 'buyBox', label: '购物车获得率', kind: 'percent', pick: row => row.buyBox },
  { key: 'price', label: '价格', kind: 'money', pick: row => row.price },
  { key: 'adsSales', label: '广告销售', kind: 'money', pick: row => row.adsSales },
  { key: 'returnRate', label: '退货率', kind: 'percent', pick: row => row.returnRate, lowerIsBetter: true },
  { key: 'daysOfSupply', label: '可售天数', kind: 'days', pick: row => row.daysOfSupply },
]

/** 把选中的几行并排成对比表；“较优”只在至少两个对象都有值且不全相等时标出（退货率越低越好，其余越高越好；可售天数与价格不判优劣）。 */
export function compareLines(rows: readonly ListingPerfRow[]): ListingCompareLine[] {
  return LINES.map(line => {
    const values = rows.map(line.pick)
    const given = values.filter((value): value is number => value !== null)
    let bestIndex: number | null = null
    if (given.length >= 2 && new Set(given).size > 1 && line.key !== 'price' && line.key !== 'daysOfSupply') {
      const target = line.lowerIsBetter ? Math.min(...given) : Math.max(...given)
      bestIndex = values.indexOf(target)
    }
    return { key: line.key, label: line.label, kind: line.kind, values, bestIndex }
  })
}
