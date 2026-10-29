import type { CursorPageInfo } from './query.js'

// 促销叠加（P6-17，16 章第 3.2 节）：根据已同步的促销清单，算同一 ASIN 在同一时段叠加了几个促销、叠加后的折扣深度。
// 纯计算，接口（促销页的叠加列表与快捷筛选卡）与 worker（促销叠加预警）共用同一份；不引 zod，没有模块级函数调用。
//
// 口径（写进页面的说明里）：
//   - 只算“进行中”和“即将开始”的促销（RUNNING、UPCOMING），而且只看从现在起的时段；已结束、失败、取消、处理中的不算；
//   - 重叠按时间轴严格判断：一个促销的结束时刻恰好等于另一个的开始时刻，不算叠加；结束时间为空表示长期有效；
//   - 只有“商品清单”类的促销能落到 ASIN 上；整个目录的促销（selectionType 为 CATALOG）没有商品清单，无法判断落在哪个 ASIN，不计入，页面如实说明；
//   - 折扣深度 = 优惠金额 ÷ 当前价：百分比折扣直接用百分比；立减金额和固定价要用该商品最近一次价格折算，没有价格的算不出，该促销不参与深度（计数仍算）；赠品算不出；
//   - 叠加深度 = 1 − Π(1 − 各促销深度)（逐层叠加，不是简单相加）；取“叠加数最多”的那个时段，数量相同取深度大的、再取更早的。

export const STACKING_ACTIVE_STATUSES: readonly string[] = ['RUNNING', 'UPCOMING']
export const STACKING_DEFAULTS = { minStack: 2, minDepthPct: 0.3 } as const
export const STACKING_LIMITS = { minStackMax: 10, itemRowsMax: 20_000, pageSizeMax: 200 } as const
export const STACKING_CATALOG_NOTE = '整个目录范围的促销没有商品清单，无法判断落在哪个 ASIN，不计入叠加。'
export const STACKING_BASIS =
  '只算进行中与即将开始的促销，从现在起看；结束时刻恰好等于另一个开始时刻不算叠加；折扣深度按最近一次价格折算（没有价格、赠品算不出的不参与深度，计数仍算），叠加深度逐层叠乘。数据来自已同步的促销清单，不抓前台。'

export interface StackInterval {
  id: string
  /** 开始、结束时刻（毫秒时间戳）；结束为空表示长期有效。 */
  start: number
  end: number | null
  /** 这个促销的折扣深度（0 到 1 的小数）；算不出为 null。 */
  depth: number | null
}

export interface StackPeak {
  /** 同一时段内最多同时有几个促销。 */
  count: number
  /** 这个时段的起止（毫秒时间戳）；结束为空表示一直持续。 */
  from: number
  to: number | null
  promotionIds: string[]
  /** 叠加后的折扣深度；没有一个促销算得出深度时为 null。 */
  depth: number | null
  /** 同时段里算不出深度的促销个数（叠加深度只含算得出的）。 */
  unknownDepth: number
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

/** 逐层叠加：1 − Π(1 − d)；一个都没有返回 null；每层限制在 0 到 1 之间。 */
export function combineDepth(depths: readonly number[]): number | null {
  if (depths.length === 0) return null
  let keep = 1
  for (const depth of depths) keep *= 1 - Math.min(1, Math.max(0, depth))
  return round6(1 - keep)
}

/** 一个商品条目的折扣深度：百分比直接用（percentOff 是 0 到 100 的百分数）；立减金额与固定价要有当前价；赠品或缺数据返回 null。 */
export function itemDepthOf(
  row: { benefitType: string | null; discountType: string | null; percentOff: number | null; amountOff: number | null; fixedPrice: number | null },
  price: number | null,
): number | null {
  if (row.benefitType === 'FIXED_PRICE') {
    if (row.fixedPrice === null || price === null || price <= 0) return null
    return round6(Math.min(1, Math.max(0, (price - row.fixedPrice) / price)))
  }
  if (row.discountType === 'PERCENTAGE_OFF') return row.percentOff === null ? null : round6(Math.min(1, Math.max(0, row.percentOff / 100)))
  if (row.discountType === 'AMOUNT_OFF') return row.amountOff === null || price === null || price <= 0 ? null : round6(Math.min(1, Math.max(0, row.amountOff / price)))
  return null
}

/** 找“叠加数最多”的时段（只看 now 之后）；没有任何有效区间返回 null。 */
export function peakStacking(intervals: readonly StackInterval[], now: number): StackPeak | null {
  // 先把区间收到 now 之后；剩余长度为 0 的（已结束或恰好此刻结束）丢掉
  const live = intervals.map(item => ({ ...item, start: Math.max(item.start, now) })).filter(item => item.end === null || item.end > item.start)
  if (live.length === 0) return null
  const bounds = [...new Set(live.map(item => item.start))].sort((a, b) => a - b)
  let best: StackPeak | null = null
  for (let index = 0; index < bounds.length; index += 1) {
    const at = bounds[index]!
    // 半开区间 [start, end)：结束时刻恰好是 at 的不算在内，所以首尾相接不叠加
    const active = live.filter(item => item.start <= at && (item.end === null || item.end > at))
    if (active.length === 0) continue
    const ends = active.map(item => item.end).filter((end): end is number => end !== null)
    const nextStart = bounds[index + 1] ?? null
    const stop = [...ends, ...(nextStart === null ? [] : [nextStart])]
    const to = stop.length === 0 ? null : Math.min(...stop)
    const known = active.map(item => item.depth).filter((depth): depth is number => depth !== null)
    const peak: StackPeak = { count: active.length, from: at, to, promotionIds: active.map(item => item.id).sort(), depth: combineDepth(known), unknownDepth: active.length - known.length }
    const better = !best || peak.count > best.count || (peak.count === best.count && (peak.depth ?? -1) > (best.depth ?? -1))
    if (better) best = peak
  }
  return best
}

export interface StackPromotionInput {
  rowId: string
  promotionId: string
  title: string
  type: string
  status: string
  startAt: Date
  endAt: Date | null
  sellerAccountId: string
}
export interface StackItemInput {
  promotionRowId: string
  sellerAccountId: string
  asin: string
  sku: string
  benefitType: string | null
  discountType: string | null
  percentOff: number | null
  amountOff: number | null
  fixedPrice: number | null
}

export interface StackPromotionView {
  id: string
  promotionId: string
  title: string
  type: string
  status: string
  startAt: string
  endAt: string | null
  depth: number | null
}
export interface StackRow {
  /** 店铺 × ASIN。 */
  id: string
  storeId: string
  asin: string
  /** 进行中与即将开始的促销里，这个 ASIN 一共出现在几个促销里（不要求同时段）。 */
  promotionCount: number
  peakCount: number
  peakFrom: string
  peakTo: string | null
  /** 叠加后的折扣深度（0 到 1）；算不出为 null。 */
  depth: number | null
  unknownDepth: number
  promotions: StackPromotionView[]
}

/**
 * 把促销与商品清单折成“每个店铺 × ASIN 的叠加情况”。priceOf 给出某店铺某 ASIN 最近一次价格（没有为 null）；
 * 同一个促销里同一个 ASIN 出现多行（不同 SKU）只算一次，取深度最大的那行。结果按叠加数、深度从大到小排。
 */
export function stackRowsOf(promotions: readonly StackPromotionInput[], items: readonly StackItemInput[], priceOf: (storeId: string, asin: string) => number | null, now: number): StackRow[] {
  const byPromotion = new Map(promotions.filter(promotion => STACKING_ACTIVE_STATUSES.includes(promotion.status)).map(promotion => [promotion.rowId, promotion]))
  // 店铺|ASIN → 促销行编号 → 深度（同一促销里多行取最大）
  const groups = new Map<string, { storeId: string; asin: string; depths: Map<string, number | null> }>()
  for (const item of items) {
    const promotion = byPromotion.get(item.promotionRowId)
    if (!promotion || item.asin === '') continue
    const key = `${item.sellerAccountId}|${item.asin}`
    const group = groups.get(key) ?? { storeId: item.sellerAccountId, asin: item.asin, depths: new Map<string, number | null>() }
    const depth = itemDepthOf(item, priceOf(item.sellerAccountId, item.asin))
    const before = group.depths.get(promotion.rowId)
    group.depths.set(promotion.rowId, before === undefined ? depth : before === null ? depth : depth === null ? before : Math.max(before, depth))
    groups.set(key, group)
  }
  const rows: StackRow[] = []
  for (const [key, group] of groups) {
    const intervals: StackInterval[] = []
    const views: StackPromotionView[] = []
    for (const [rowId, depth] of group.depths) {
      const promotion = byPromotion.get(rowId)!
      intervals.push({ id: rowId, start: promotion.startAt.getTime(), end: promotion.endAt ? promotion.endAt.getTime() : null, depth })
      views.push({
        id: rowId,
        promotionId: promotion.promotionId,
        title: promotion.title,
        type: promotion.type,
        status: promotion.status,
        startAt: promotion.startAt.toISOString(),
        endAt: promotion.endAt?.toISOString() ?? null,
        depth,
      })
    }
    const peak = peakStacking(intervals, now)
    if (!peak) continue
    rows.push({
      id: key,
      storeId: group.storeId,
      asin: group.asin,
      promotionCount: views.length,
      peakCount: peak.count,
      peakFrom: new Date(peak.from).toISOString(),
      peakTo: peak.to === null ? null : new Date(peak.to).toISOString(),
      depth: peak.depth,
      unknownDepth: peak.unknownDepth,
      promotions: views.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id)),
    })
  }
  return rows.sort((a, b) => b.peakCount - a.peakCount || (b.depth ?? -1) - (a.depth ?? -1) || (a.id < b.id ? -1 : 1))
}

export const isStacked = (row: Pick<StackRow, 'peakCount'>, minStack: number): boolean => row.peakCount >= minStack
export const isDeep = (row: Pick<StackRow, 'depth'>, minDepthPct: number): boolean => row.depth !== null && row.depth >= minDepthPct - 1e-9

export type StackingFlag = 'stacked' | 'deep' | 'any'

export interface StackingRowView extends StackRow {
  storeName: string
  title: string | null
  stacked: boolean
  deep: boolean
}

export interface StackingSummary {
  /** 进行中与即将开始的商品清单类促销里出现的 ASIN 总数。 */
  asins: number
  stacked: number
  deep: number
  /** 叠加或折扣过深（两者之一，同一商品只算一次）。 */
  any: number
  minStack: number
  minDepthPct: number
}

export interface StackingResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: StackingRowView[]
  pageInfo: CursorPageInfo
  summary: StackingSummary
  truncated: boolean
  basis: string
  catalogNote: string
}
