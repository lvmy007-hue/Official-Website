// 广告连接器（P3-01）的共用常量与纯函数（后台任务与前端共用；只有常量与纯函数，没有 zod）。
// 依据：02 章 2.5；08 章 8.14；freeze/importers.md A-01 至 A-04。

/** 新报告接口返回警告信号时的失败码：数据照常入库，只在页面角标提示。 */
export const ADS_WARNING_SIGNAL = 'ADS_WARNING_SIGNAL'
/** 单个报告的时间范围超出上限：前端先拦截，后台也再检查一次。 */
export const ADS_REPORT_WINDOW = 'ADS_REPORT_WINDOW'
/** 广告账户还没绑定店铺：只在广告连接页可见，不进入业务页。 */
export const ADS_ACCOUNT_UNBOUND = 'ADS_ACCOUNT_UNBOUND'
/** 新旧版本核对出差异。 */
export const ADS_LEGACY_DIFF = 'ADS_LEGACY_DIFF'
/** 营销数据流的接收端（部署专项）没有配置：状态“未接入”，今日广告与分时分析退化展示日报表数据。 */
export const ADS_STREAM_NO_SINK = 'STREAM_NO_SINK'
/** 营销数据流里投放对象只带编号：先靠实体同步解析名称，解析不到的显示编号。 */
export const ADS_STREAM_ID_UNRESOLVED = 'STREAM_ID_UNRESOLVED'

export type AdsStreamState = { connected: true } | { connected: false; code: typeof ADS_STREAM_NO_SINK; label: string }

/** 营销数据流的接入状态：接收端（存储桶与队列通知）没配置就是“未接入”，不编造数据（14.10）。 */
export function adsStreamState(input: { sinkConfigured: boolean }): AdsStreamState {
  return input.sinkConfigured ? { connected: true } : { connected: false, code: ADS_STREAM_NO_SINK, label: '未接入：营销数据流的接收端尚未配置，今日广告与分时分析退化展示日报表数据' }
}

/** 日指标近 3 天会被亚马逊按流量日期回补修正，所以每日重拉近 3 天（importers.md A-02）。 */
export const ADS_DAILY_REFETCH_DAYS = 3
/** 历史回补按 120 天切片（日粒度单个报告的上限）。 */
export const ADS_BACKFILL_SLICE_DAYS = 120

export const ADS_REPORT_GRANULARITIES = ['HOURLY', 'DAILY', 'MONTHLY'] as const
export type AdsReportGranularity = (typeof ADS_REPORT_GRANULARITIES)[number]

export const ADS_REPORT_GRANULARITY_LABEL: Record<AdsReportGranularity, string> = { HOURLY: '按小时', DAILY: '按日', MONTHLY: '按月' }

/**
 * 单个报告的时间范围上限（02 章 2.5）：按小时最多 14 天且只保留 14 天，按日最多 120 天，按月最多 25 个月。
 * 按日数据的保留期官方有 15 与 24 个月两种说法（CR-001），这里不拦截保留期，以接口实测为准。
 */
export const ADS_REPORT_LIMITS: Record<AdsReportGranularity, { maxDays?: number; maxMonths?: number; retentionDays?: number }> = {
  HOURLY: { maxDays: 14, retentionDays: 14 },
  DAILY: { maxDays: 120 },
  MONTHLY: { maxMonths: 25 },
}

/** 官方推荐的处理状态：新到的是待处理；采纳与忽略由人决定；亚马逊不再返回的待处理推荐记为已失效。 */
export const ADS_RECOMMENDATION_STATUSES = ['NEW', 'ADOPTED', 'IGNORED', 'EXPIRED'] as const
export type AdsRecommendationStatus = (typeof ADS_RECOMMENDATION_STATUSES)[number]
export const ADS_RECOMMENDATION_STATUS_LABEL: Record<AdsRecommendationStatus, string> = {
  NEW: '待处理',
  ADOPTED: '已采纳',
  IGNORED: '已忽略',
  EXPIRED: '已失效',
}

/** 新旧版本核对的结果：旧版本没有数据是“旧接口不可用”，不算通过也不算失败。 */
export const ADS_PARITY_STATUSES = ['PASSED', 'HAS_DIFFS', 'LEGACY_UNAVAILABLE'] as const
export type AdsParityStatus = (typeof ADS_PARITY_STATUSES)[number]
export const ADS_PARITY_CATEGORIES = ['TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED'] as const
export type AdsParityCategory = (typeof ADS_PARITY_CATEGORIES)[number]
export const ADS_PARITY_CATEGORY_LABEL: Record<AdsParityCategory, string> = {
  TIME_BASIS: '时间口径',
  ATTRIBUTION_BASIS: '归因口径',
  SCOPE: '范围',
  UNEXPLAINED: '未解释',
}

const DAY_MS = 86_400_000
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD 转成当天 UTC 零点的毫秒数；格式或日历日期不合法返回 null（不用本机时区）。 */
export function dayStamp(day: string): number | null {
  if (!DAY_TEXT.test(day)) return null
  const stamp = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(stamp) || new Date(stamp).toISOString().slice(0, 10) !== day ? null : stamp
}

const dayText = (stamp: number) => new Date(stamp).toISOString().slice(0, 10)

/** 包含起止两天的天数。 */
export function inclusiveDays(from: string, to: string): number | null {
  const start = dayStamp(from)
  const end = dayStamp(to)
  return start === null || end === null ? null : Math.round((end - start) / DAY_MS) + 1
}

/** 两个日期相隔的月数（按日历月份，起止月份都算：1 月 1 日到 1 月 31 日是 1 个月）。 */
function inclusiveMonths(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number)
  const [toYear, toMonth] = to.split('-').map(Number)
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1
}

/**
 * 检查报告的时间范围：返回 null 表示可以提交，否则返回给用户看的中文原因（失败码是 ADS_REPORT_WINDOW）。
 * today 是企业数据口径时区的“今天”（YYYY-MM-DD），只用于按小时报告的保留期；结束日期不能晚于今天。
 */
export function adsReportWindowIssue(input: { granularity: AdsReportGranularity; from: string; to: string; today: string }): string | null {
  const days = inclusiveDays(input.from, input.to)
  if (days === null) return '报告的起止日期格式不对，应为 YYYY-MM-DD'
  if (days < 1) return '报告的结束日期不能早于开始日期'
  if (input.to > input.today) return '报告的结束日期不能晚于今天'
  const limit = ADS_REPORT_LIMITS[input.granularity]
  const label = ADS_REPORT_GRANULARITY_LABEL[input.granularity]
  if (limit.maxDays !== undefined && days > limit.maxDays) return `${label}的报告单次最多取 ${limit.maxDays} 天，请缩短时间范围或分段`
  if (limit.maxMonths !== undefined && inclusiveMonths(input.from, input.to) > limit.maxMonths) return `${label}的报告单次最多取 ${limit.maxMonths} 个月，请缩短时间范围或分段`
  if (limit.retentionDays !== undefined) {
    const today = dayStamp(input.today)
    const start = dayStamp(input.from)
    if (today !== null && start !== null && Math.round((today - start) / DAY_MS) + 1 > limit.retentionDays) return `${label}的数据只保留最近 ${limit.retentionDays} 天，开始日期太早`
  }
  return null
}

/** 把一段时间按日粒度切成不超过 sliceDays 天的片（历史回补用），起止都含；范围不合法返回空数组。 */
export function sliceReportWindows(from: string, to: string, sliceDays: number = ADS_BACKFILL_SLICE_DAYS): Array<{ from: string; to: string }> {
  const start = dayStamp(from)
  const end = dayStamp(to)
  if (start === null || end === null || end < start || sliceDays < 1) return []
  const slices: Array<{ from: string; to: string }> = []
  for (let cursor = start; cursor <= end; cursor += sliceDays * DAY_MS) slices.push({ from: dayText(cursor), to: dayText(Math.min(end, cursor + (sliceDays - 1) * DAY_MS)) })
  return slices
}

/** 日期是否落在“近 3 天会被回补修正”的区间内（today 当天与前两天）。 */
export function inRefetchWindow(day: string, today: string): boolean {
  const target = dayStamp(day)
  const base = dayStamp(today)
  if (target === null || base === null) return false
  const age = Math.round((base - target) / DAY_MS)
  return age >= 0 && age < ADS_DAILY_REFETCH_DAYS
}
