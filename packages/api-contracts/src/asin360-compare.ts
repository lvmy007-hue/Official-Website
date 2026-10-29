import type { AlertListItem } from './alerts.js'

// ASIN 360 锚点长页新增的三个读接口的契约（P6-21，16 章 3.1；freeze/api.md `/products/:id/compare`、`/competitor-compare`、`/alerts`）。
// 只放类型与常量（没有 zod），前端首屏引用不会带上校验代码。

/** 同环比明细的通用结构（16 章 3.1）：{metric, value, prevValue, changeRate, changeValue}，再加显示用的名称、格式与状态。 */
export const ASIN360_COMPARE_METRICS = ['sales', 'units', 'unitPrice', 'sessions', 'conversion', 'adsSpend', 'adsSales', 'profit', 'margin'] as const
export type Asin360CompareMetric = (typeof ASIN360_COMPARE_METRICS)[number]

export interface Asin360CompareRow {
  metric: Asin360CompareMetric
  label: string
  format: 'money' | 'number' | 'percent'
  /** 本期取值；来源没有接入、没有权限或本期没有记录时为 null（不写 0）。 */
  value: number | null
  /** 对比期取值；没有选择对比期或对比期没有记录为 null。 */
  prevValue: number | null
  /** 变化比率（0.12 表示 +12%）；对比期为 0 或任一侧没有取值时为 null。百分比类指标也给比率，百分点差见 changeValue。 */
  changeRate: number | null
  /** 变化量：本期减对比期（百分比类指标是小数差，0.01 表示 1 个百分点）。 */
  changeValue: number | null
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED'
  note: string | null
}

export interface Asin360CompareResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  period: { from: string; to: string }
  /** 没有选对比期时为 null（行里的 prevValue 全为 null）。 */
  compare: { mode: 'previous' | 'yoy' | 'custom'; from: string; to: string } | null
  currency: string
  rows: Asin360CompareRow[]
}

/** 竞品对比最多并列的竞品个数（按关注时间先后取）。 */
export const ASIN360_COMPETITOR_COMPARE_LIMIT = 5
export const ASIN360_COMPETITOR_COMPARE_BASIS =
  '价格与销售排名来自商品目录与竞争摘要快照（只用官方接口，不抓取亚马逊前台页面），快照在属性变化或每 24 小时写一次，同一天取最后一条；评分与评分数只有我方商品有来源（文件导入），竞品没有官方来源，不显示。'

export interface Asin360CompareSeriesPoint {
  date: string
  price: number | null
  rank: number | null
  rating: number | null
  ratingCount: number | null
}

export interface Asin360CompareParty {
  asin: string
  isOwn: boolean
  title: string | null
  currency: string
  /** 销售排名所属的分类名称；同一分类下的名次才能并列比较。 */
  rankName: string | null
  /** 最近一个有记录的取值（各自独立取最近的，不要求同一天）。 */
  latest: { price: number | null; rank: number | null; rating: number | null; ratingCount: number | null; observedAt: string | null }
  points: Asin360CompareSeriesPoint[]
  /** 评分列为空的原因（竞品没有官方来源、没有评价权限、尚未导入）；有值时为 null。 */
  ratingNote: string | null
}

export interface Asin360CompetitorCompareResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  range: { from: string; to: string }
  /** 第一项永远是本品；没有关注竞品时只有本品。 */
  parties: Asin360CompareParty[]
  /** 绑定的竞品超过并列上限，只显示了前几个。 */
  truncated: boolean
  basis: string
}

/** 预警日志一次最多返回多少条（按最近触发时间新到旧）。 */
export const ASIN360_ALERT_LIMIT = 200

export interface Asin360AlertsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: AlertListItem[]
  truncated: boolean
}
