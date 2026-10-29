import type { AdsReportTemplateKey } from '@nova/api-contracts'
import { numberOf, textOf } from '../importers/ads/report-v1-parse'
import type { Row } from '../streaming/rows'

// 新报告接口各模板的行解析（纯函数，P3-15）。**列名没有对照真实报告**：按各模板请求的维度与指标名读取，同时兼容旧版常见别名；
// 缺的指标是 null（“没给”），不当 0；缺少这个模板必需的键就跳过该行（不猜），跳过原因计数并汇总到任务上。
// 小时报告的时间只认带时区的 ISO 时间戳（含 Z 或 +08:00），其余写法一律跳过——时区猜错会让整张热力图整体错位。

export type ReportMetrics = {
  impressions: number | null
  clicks: number | null
  cost: number | null
  sales: number | null
  purchases: number | null
  units: number | null
}

export type ReportKeys = {
  /** 日期 YYYY-MM-DD（按日模板）。 */
  day: string
  /** 小时起点（小时模板）。 */
  hourStart: Date | null
  adProduct: string
  campaignId: string
  adGroupId: string
  targetId: string
  targetText: string
  matchType: string
  searchTerm: string
  placement: string
  advertisedAsin: string
  purchasedAsin: string
}

export type ParsedReportRow = { keys: ReportKeys; metrics: ReportMetrics }
export type ReportSkipReason = 'NO_DATE' | 'NO_HOUR' | 'NO_CAMPAIGN' | 'NO_KEY' | 'NO_METRICS'
export type ReportRowSkip = { skipped: ReportSkipReason }

export const REPORT_SKIP_LABEL: Record<ReportSkipReason, string> = {
  NO_DATE: '没有日期',
  NO_HOUR: '没有带时区的小时时间',
  NO_CAMPAIGN: '没有活动编号',
  NO_KEY: '缺少模板必需的维度',
  NO_METRICS: '指标全为空',
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/
const ZONED_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i
const HOUR_MS = 3_600_000

/** 带时区的 ISO 时间戳 → 截到整点的时间；其它写法返回 null。 */
export function zonedHourOf(text: string): Date | null {
  if (!ZONED_HOUR.test(text)) return null
  const stamp = Date.parse(text)
  return Number.isNaN(stamp) ? null : new Date(Math.floor(stamp / HOUR_MS) * HOUR_MS)
}

/** 各模板除日期（或小时）与活动外必需的键。 */
const REQUIRED: Record<AdsReportTemplateKey, ReadonlyArray<keyof ReportKeys>> = {
  CAMPAIGN_DAILY: [],
  AD_GROUP_DAILY: ['adGroupId'],
  TARGET_DAILY: [],
  SEARCH_TERM_DAILY: ['searchTerm'],
  ADVERTISED_PRODUCT_DAILY: ['advertisedAsin'],
  PLACEMENT_DAILY: ['placement'],
  CAMPAIGN_HOURLY: [],
  CONVERTED_PRODUCT_DAILY: ['advertisedAsin', 'purchasedAsin'],
}

export function parseReportRow(templateKey: AdsReportTemplateKey, row: Row): ParsedReportRow | ReportRowSkip {
  const hourly = templateKey === 'CAMPAIGN_HOURLY'
  const day = DATE_PREFIX.exec(textOf(row, ['date', 'reportDate', 'startDate']))?.[1] ?? ''
  const hourStart = hourly ? zonedHourOf(textOf(row, ['hour', 'hourStart', 'timestamp', 'startTime'])) : null
  if (hourly ? !hourStart : !day) return { skipped: hourly ? 'NO_HOUR' : 'NO_DATE' }
  const keys: ReportKeys = {
    day,
    hourStart,
    adProduct: textOf(row, ['adProduct', 'adProductType']).toUpperCase(),
    campaignId: textOf(row, ['campaignId', 'campaign_id']),
    adGroupId: textOf(row, ['adGroupId', 'ad_group_id']),
    targetId: textOf(row, ['targetId', 'keywordId', 'target_id']),
    targetText: textOf(row, ['targetingExpression', 'keyword', 'keywordText', 'targeting', 'targetingText']),
    matchType: textOf(row, ['matchType', 'keywordMatchType', 'match_type']).toUpperCase(),
    searchTerm: textOf(row, ['searchTerm', 'customerSearchTerm', 'query', 'search_term']),
    placement: textOf(row, ['placement', 'placementClassification']),
    advertisedAsin: textOf(row, ['advertisedAsin', 'asin']),
    purchasedAsin: textOf(row, ['purchasedAsin']),
  }
  if (!keys.campaignId) return { skipped: 'NO_CAMPAIGN' }
  if (REQUIRED[templateKey].some(name => !keys[name])) return { skipped: 'NO_KEY' }
  // 投放对象日报至少要有投放对象编号或表达式之一
  if (templateKey === 'TARGET_DAILY' && !keys.targetId && !keys.targetText) return { skipped: 'NO_KEY' }
  const metrics: ReportMetrics = {
    impressions: numberOf(row, ['impressions']),
    clicks: numberOf(row, ['clicks']),
    cost: numberOf(row, ['cost', 'spend']),
    sales: numberOf(row, ['sales', 'sales7d', 'sales14d']),
    purchases: numberOf(row, ['purchases', 'orders', 'purchases7d', 'purchases14d']),
    units: numberOf(row, ['units', 'unitsSold']),
  }
  const values = Object.values(metrics)
  // 全空多半是字段名对不上；转化商品表的件数与销售额都不允许为空
  if (values.every(value => value === null)) return { skipped: 'NO_METRICS' }
  if (templateKey === 'CONVERTED_PRODUCT_DAILY' && (metrics.units === null || metrics.sales === null)) return { skipped: 'NO_METRICS' }
  return { keys, metrics }
}

/** YYYY-MM-DD → 当天零点（UTC）的日期，指标表的日期列都按这个口径存。 */
export const dayDate = (day: string) => new Date(`${day}T00:00:00Z`)
