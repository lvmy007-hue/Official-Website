// 销售与流量同步（P4-01，importers.md D-01、D-02、D-03、R-34；models.md SalesTrafficDaily、SalesTrafficAsinDaily）的常量与纯函数。
// 纯类型、常量与纯函数，不含 zod：api 与 worker 共用。
// 数据来源：亚马逊数据中心 analytics_salesAndTraffic_2024_04_24 的 salesAndTrafficByDate、salesAndTrafficByAsin、salesAndTrafficTrends（主来源，
// 需要“品牌分析”角色），补充来源是报告 GET_SALES_AND_TRAFFIC_REPORT（JSON）。
// 口径（落库约定）：
//   - 比率（购物车获得率、单位会话转化率、退款率）一律存 0 到 1 的小数，官方给的是百分数（95.5 表示 95.5%），导入时除以 100；
//   - 官方没给的值存 null（页面写“官方未提供”或“尚无记录”），不是 0；
//   - 金额只认美元：币种不是美元的行保留币种原样存储，下游汇总（经营日汇总）只读美元；
//   - 日期是亚马逊美国站的日历日（美国太平洋时区），周与月粒度的 date 是该周（周日起）或该月的第一天。

/** 数据中心数据集标识（任务上下文 context.dataset）。 */
export const SALES_TRAFFIC_DATASET_DATE = 'dk.sales-traffic-by-date'
export const SALES_TRAFFIC_DATASET_ASIN = 'dk.sales-traffic-by-asin'
export const SALES_TRAFFIC_DATASET_TRENDS = 'dk.sales-traffic-trends'
export const SALES_TRAFFIC_DATASETS = [SALES_TRAFFIC_DATASET_DATE, SALES_TRAFFIC_DATASET_ASIN, SALES_TRAFFIC_DATASET_TRENDS] as const

/** 补充来源：报告类型（JSON 格式，不能整份进内存的超大文件会被拒绝，见 CR-076）。 */
export const SALES_TRAFFIC_REPORT_TYPE = 'GET_SALES_AND_TRAFFIC_REPORT'

/** 新鲜度来源键（importers.md D-01、D-02、D-03、R-34）。 */
export const SALES_TRAFFIC_DATE_FRESHNESS_KEY = 'dk.sales-traffic.date'
export const SALES_TRAFFIC_ASIN_FRESHNESS_KEY = 'dk.sales-traffic.asin'
export const SALES_TRAFFIC_TRENDS_FRESHNESS_KEY = 'dk.sales-traffic.trends'
export const SALES_TRAFFIC_REPORT_FRESHNESS_KEY = 'rpt.sales-traffic'

/** 专属失败码。DK_NO_BRAND：数据中心销售与流量需要品牌分析角色（卖家要有品牌备案），403 时用它代替通用的 ROLE_MISSING，让页面能写清前提。 */
export const SALES_TRAFFIC_NO_BRAND = 'DK_NO_BRAND'
/** 报告与数据中心的同键数据差异超过阈值：只记录，不覆盖（importers.md R-34）。 */
export const SALES_TRAFFIC_SOURCE_DIFF = 'ST_SOURCE_DIFF'

export const SALES_TRAFFIC_GRANULARITIES = ['DAY', 'WEEK', 'MONTH'] as const
export type SalesTrafficGranularity = (typeof SALES_TRAFFIC_GRANULARITIES)[number]
export const SALES_TRAFFIC_ASIN_GRANULARITIES = ['PARENT', 'CHILD', 'SKU'] as const
export type SalesTrafficAsinGranularity = (typeof SALES_TRAFFIC_ASIN_GRANULARITIES)[number]
export const SALES_TRAFFIC_SOURCES = ['DATA_KIOSK', 'REPORT'] as const
export type SalesTrafficSource = (typeof SALES_TRAFFIC_SOURCES)[number]
export const SALES_TRAFFIC_SOURCE_LABEL: Record<SalesTrafficSource, string> = { DATA_KIOSK: '数据中心', REPORT: '报告补充' }

/** 日粒度：有数据时重拉最近多少天（官方会修正近期数据，importers.md 写“近 7 天每日重拉”）；店铺第一次拉取时回补多少天。 */
export const SALES_TRAFFIC_REFRESH_DAYS = 7
export const SALES_TRAFFIC_BACKFILL_DAYS = 90
/**
 * ASIN 粒度（D-02）每次只查一天（不依赖官方是否支持按日拆分的参数）：稳态每天重拉最近 3 天（昨天与前两天），店铺第一次拉取回补最近 7 天；
 * 更长的 ASIN 历史由 ASIN 趋势（D-03，一次查询一个窗口的逐日序列）与手动回补承担。
 */
export const SALES_TRAFFIC_ASIN_REFRESH_DAYS = 3
export const SALES_TRAFFIC_ASIN_BACKFILL_DAYS = 7
/** 周粒度回看最近几个完整周、月粒度回看最近几个完整月。 */
export const SALES_TRAFFIC_WEEKS = 5
export const SALES_TRAFFIC_MONTHS = 3
/** 一次查询的日期跨度上限（天）：回补 90 天加余量。 */
export const SALES_TRAFFIC_MAX_WINDOW_DAYS = 92
/** 数据中心的销售与流量最远能查多少天以前（官方保留两年）；超过的回补请求本地拒绝，不伪造。 */
export const SALES_TRAFFIC_RETENTION_DAYS = 730

/** 来源核对的容差：相对差异不超过 2% 或绝对差异不超过 1（件数、会话、浏览量，销售额取 1 美元）算一致。 */
export const SALES_TRAFFIC_DIFF_RELATIVE = 0.02
export const SALES_TRAFFIC_DIFF_ABSOLUTE = 1

export const SALES_TRAFFIC_DIFF_METRICS = ['orderedSales', 'unitsOrdered', 'sessions', 'pageViews'] as const
export type SalesTrafficDiffMetric = (typeof SALES_TRAFFIC_DIFF_METRICS)[number]
export const SALES_TRAFFIC_DIFF_METRIC_LABEL: Record<SalesTrafficDiffMetric, string> = {
  orderedSales: '订购销售额',
  unitsOrdered: '订购件数',
  sessions: '会话数',
  pageViews: '页面浏览量',
}

const DAY_MS = 86_400_000
const parseDay = (text: string) => Date.parse(`${text}T00:00:00Z`)
const dayText = (time: number) => new Date(time).toISOString().slice(0, 10)
const addDays = (text: string, days: number) => dayText(parseDay(text) + days * DAY_MS)

export interface SalesTrafficWindow {
  startDate: string
  endDate: string
}

/**
 * 各粒度的查询窗口（today 是企业时区的“今天”日期文本；结束日取已经结束的最后一个日、周、月，今天的数据不完整，进行中的周与月也不取）：
 *   DAY：有数据重拉最近 7 天，第一次回补 90 天；
 *   WEEK：最近 5 个完整周（亚马逊的周从周日开始，周六结束）；
 *   MONTH：最近 3 个完整月。
 */
export function salesTrafficWindow(granularity: SalesTrafficGranularity, today: string, hasData: boolean): SalesTrafficWindow {
  const yesterday = addDays(today, -1)
  if (granularity === 'DAY') return { startDate: addDays(yesterday, -((hasData ? SALES_TRAFFIC_REFRESH_DAYS : SALES_TRAFFIC_BACKFILL_DAYS) - 1)), endDate: yesterday }
  if (granularity === 'WEEK') {
    const weekday = new Date(parseDay(today)).getUTCDay() // 0 = 周日
    const lastSaturday = addDays(today, -(weekday === 6 ? 7 : weekday + 1)) // 今天之前最近的一个周六（周六当天这一周还没结束）
    return { startDate: addDays(lastSaturday, -(SALES_TRAFFIC_WEEKS * 7 - 1)), endDate: lastSaturday }
  }
  const [year, month] = today.split('-').map(Number)
  const firstOfThisMonth = Date.UTC(year, month - 1, 1)
  const firstOfStart = Date.UTC(year, month - 1 - SALES_TRAFFIC_MONTHS, 1)
  return { startDate: dayText(firstOfStart), endDate: dayText(firstOfThisMonth - DAY_MS) }
}

/** ASIN 粒度要查的日子（从最近的一天往前排，不含今天）。 */
export function salesTrafficAsinDays(today: string, hasData: boolean): string[] {
  const days = hasData ? SALES_TRAFFIC_ASIN_REFRESH_DAYS : SALES_TRAFFIC_ASIN_BACKFILL_DAYS
  return Array.from({ length: days }, (_, index) => addDays(today, -(index + 1)))
}

/** 查询窗口是否合法：日期格式、先后、跨度、不早于保留期（today 缺省不查保留期）。 */
export function salesTrafficWindowIssue(window: SalesTrafficWindow, today?: string): string | null {
  const pattern = /^\d{4}-\d{2}-\d{2}$/
  if (!pattern.test(window.startDate) || !pattern.test(window.endDate)) return '日期格式不对'
  const start = parseDay(window.startDate)
  const end = parseDay(window.endDate)
  // 回写比对：2 月 30 日这类不存在的日期会被自动进位，回写后与原文不同
  if (Number.isNaN(start) || Number.isNaN(end) || dayText(start) !== window.startDate || dayText(end) !== window.endDate) return '日期格式不对'
  if (end < start) return '结束日早于开始日'
  if ((end - start) / DAY_MS + 1 > SALES_TRAFFIC_MAX_WINDOW_DAYS) return `一次查询最多 ${SALES_TRAFFIC_MAX_WINDOW_DAYS} 天`
  if (today && (parseDay(today) - start) / DAY_MS > SALES_TRAFFIC_RETENTION_DAYS) return `数据中心只保留最近 ${SALES_TRAFFIC_RETENTION_DAYS} 天的销售与流量`
  return null
}

/** 官方百分数（95.5）→ 小数（0.955）；没给或不是有限数字为 null，超出 0 到 100 的值视为异常也返回 null（不截断、不补）。 */
export function percentToFraction(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round((n / 100) * 1e6) / 1e6
}

export interface SalesTrafficFigures {
  orderedSales: number | null
  unitsOrdered: number | null
  sessions: number | null
  pageViews: number | null
}

export interface SalesTrafficDiff {
  metric: SalesTrafficDiffMetric
  kioskValue: number
  reportValue: number
  /** 报告 − 数据中心。 */
  delta: number
  /** 差异占数据中心值的比例（数据中心值为 0 时为 null）。 */
  relative: number | null
}

/** 同一键下两个来源的差异：只比较两边都有值的指标；差异同时超过相对与绝对容差才记录（数据中心优先，不覆盖）。 */
export function salesTrafficDiffs(kiosk: SalesTrafficFigures, report: SalesTrafficFigures): SalesTrafficDiff[] {
  const out: SalesTrafficDiff[] = []
  for (const metric of SALES_TRAFFIC_DIFF_METRICS) {
    const a = kiosk[metric]
    const b = report[metric]
    if (a === null || b === null) continue
    const delta = Math.round((b - a) * 1e6) / 1e6
    const relative = a === 0 ? null : Math.abs(delta) / Math.abs(a)
    if (Math.abs(delta) <= SALES_TRAFFIC_DIFF_ABSOLUTE) continue
    if (relative !== null && relative <= SALES_TRAFFIC_DIFF_RELATIVE) continue
    out.push({ metric, kioskValue: a, reportValue: b, delta, relative })
  }
  return out
}

/** 从两个来源的同键行里挑一行用：数据中心优先，没有才用报告补充。 */
export function preferKiosk<T extends { source: string }>(rows: readonly T[]): T | null {
  return rows.find(row => row.source === 'DATA_KIOSK') ?? rows.find(row => row.source === 'REPORT') ?? null
}
