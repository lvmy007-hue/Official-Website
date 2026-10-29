import { ADS_REPORT_GRANULARITY_LABEL, dayStamp, sliceReportWindows, type AdsParityCategory, type AdsParityStatus, type AdsReportGranularity } from './ads-connector'
import type { AdsMetricsDatasetKey } from './ads-metrics'
import type { DashState } from './dashboard'
import type { CursorPageInfo } from './query'

// 广告报表契约（P3-15，08 章 8.12）：只有常量、类型与纯函数，没有 zod（请求校验在 ads-reports-query.ts）。
// 报告任务走新报告接口（Reporting API v1，importers.md A-02）：用户选“模板 + 广告产品 + 起止日期”，后台创建报告、轮询、下载并按模板写入对应的指标表；
// 旧版报告接口（LEGACY）的任务（首次同步的历史回补创建）同样列出，但不能重试。模板里的维度与指标名是按“自由组合维度与指标”的描述写的，未对真实账户验证（集中在 ADS_REPORT_TEMPLATES）。
// 没有数据写“尚无记录”，没接入写“尚未接入”，空值不是 0。

export const ADS_REPORT_WRITE = 'ads.report'

export const ADS_REPORT_SOURCES = ['LEGACY', 'V1'] as const
export type AdsReportSource = (typeof ADS_REPORT_SOURCES)[number]
export const ADS_REPORT_SOURCE_LABEL: Record<AdsReportSource, string> = { LEGACY: '旧版接口', V1: '新报告接口' }

export const ADS_REPORT_STATUSES = ['PENDING', 'GENERATING', 'READY', 'FAILED'] as const
export type AdsReportStatus = (typeof ADS_REPORT_STATUSES)[number]
export const ADS_REPORT_STATUS_LABEL: Record<AdsReportStatus, string> = { PENDING: '排队中', GENERATING: '生成中', READY: '已完成', FAILED: '失败' }

/** 新报告接口任务的同步任务类型（队列域 ads）与迁移期核对任务。 */
export const ADS_REPORT_V1_JOB = 'ADS_REPORT_V1'
export const ADS_PARITY_JOB = 'ADS_PARITY'

/** 报告里可选的广告产品（一个任务一个产品：指标表按产品分键）。 */
export const ADS_REPORT_AD_PRODUCTS = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] as const
export type AdsReportAdProduct = (typeof ADS_REPORT_AD_PRODUCTS)[number]
export const ADS_REPORT_AD_PRODUCT_LABEL: Record<AdsReportAdProduct, string> = { SPONSORED_PRODUCTS: '商品推广', SPONSORED_BRANDS: '品牌推广', SPONSORED_DISPLAY: '展示型推广' }

export const ADS_REPORT_TEMPLATE_KEYS = [
  'CAMPAIGN_DAILY',
  'AD_GROUP_DAILY',
  'TARGET_DAILY',
  'SEARCH_TERM_DAILY',
  'ADVERTISED_PRODUCT_DAILY',
  'PLACEMENT_DAILY',
  'CAMPAIGN_HOURLY',
  'CONVERTED_PRODUCT_DAILY',
] as const
export type AdsReportTemplateKey = (typeof ADS_REPORT_TEMPLATE_KEYS)[number]

export interface AdsReportTemplate {
  key: AdsReportTemplateKey
  label: string
  description: string
  granularity: AdsReportGranularity
  /** 请求的维度与指标（新报告接口的字段名）。 */
  dimensions: readonly string[]
  metrics: readonly string[]
  /** 导入后落在哪个分析数据集（广告指标页可直接分析）。 */
  dataset: AdsMetricsDatasetKey
  /** 写入的表要求先有广告账户行（AdsAccount）；活动日报与广告组、词级写入的表不要求。 */
  needsAccount: boolean
}

const BASE_METRICS = ['impressions', 'clicks', 'cost', 'sales', 'purchases'] as const

export const ADS_REPORT_TEMPLATES: readonly AdsReportTemplate[] = [
  {
    key: 'CAMPAIGN_DAILY',
    label: '活动日报',
    description: '活动 × 日：曝光、点击、花费、销售额、订单。广告控制台、日汇总与利润的广告花费都读这份数据。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId'],
    metrics: BASE_METRICS,
    dataset: 'CAMPAIGN',
    needsAccount: false,
  },
  {
    key: 'AD_GROUP_DAILY',
    label: '广告组日报',
    description: '广告组 × 日。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId', 'adGroupId'],
    metrics: BASE_METRICS,
    dataset: 'AD_GROUP',
    needsAccount: false,
  },
  {
    key: 'TARGET_DAILY',
    label: '投放对象日报',
    description: '投放对象（关键词与商品定向）× 日。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId', 'adGroupId', 'targetId', 'targetingExpression', 'matchType'],
    metrics: BASE_METRICS,
    dataset: 'TARGET',
    needsAccount: false,
  },
  {
    key: 'SEARCH_TERM_DAILY',
    label: '搜索词日报',
    description: '客户搜索词 × 投放对象 × 日；词级中心读这份数据。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId', 'adGroupId', 'targetId', 'targetingExpression', 'matchType', 'searchTerm'],
    metrics: BASE_METRICS,
    dataset: 'SEARCH_TERM',
    needsAccount: false,
  },
  {
    key: 'ADVERTISED_PRODUCT_DAILY',
    label: '广告商品日报',
    description: '活动 × 被推广 ASIN × 日；广告商品页读这份数据。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId', 'advertisedAsin'],
    metrics: [...BASE_METRICS, 'units'],
    dataset: 'ADVERTISED_PRODUCT',
    needsAccount: true,
  },
  {
    key: 'PLACEMENT_DAILY',
    label: '广告位日报',
    description: '活动 × 广告位 × 日（搜索结果顶部、其余位置、商品页）。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId', 'placement'],
    metrics: BASE_METRICS,
    dataset: 'PLACEMENT',
    needsAccount: true,
  },
  {
    key: 'CAMPAIGN_HOURLY',
    label: '活动小时报',
    description: '活动 × 小时，最多 14 天且只保留 14 天；今日广告与分时策略的热力图读这份数据。',
    granularity: 'HOURLY',
    dimensions: ['hour', 'adProduct', 'campaignId'],
    metrics: BASE_METRICS,
    dataset: 'HOURLY',
    needsAccount: true,
  },
  {
    key: 'CONVERTED_PRODUCT_DAILY',
    label: '转化商品日报',
    description: '被推广 ASIN × 实际被购买 ASIN × 日；两者不同就是光环销售。',
    granularity: 'DAILY',
    dimensions: ['date', 'adProduct', 'campaignId', 'advertisedAsin', 'purchasedAsin'],
    metrics: ['units', 'sales'],
    dataset: 'CONVERTED_PRODUCT',
    needsAccount: true,
  },
]

export function adsReportTemplateOf(key: string | null | undefined): AdsReportTemplate | null {
  return ADS_REPORT_TEMPLATES.find(template => template.key === key) ?? null
}

/** 失败码的中文说明（页面展示用；任务自带的失败原因更具体时以它为准）。 */
export const ADS_REPORT_FAILURE_LABEL: Record<string, string> = {
  ADS_REPORT_WINDOW: '时间范围超出单个报告的上限',
  ADS_REPORT_FAILED: '亚马逊生成报告失败',
  ADS_ACCOUNT_MISSING: '这个广告档案还没有发现统一接口的广告账户编号，无法使用新报告接口',
  ADS_REPORT_TEMPLATE_UNKNOWN: '报告模板不存在',
  ADS_REPORT_JOB_NOT_FOUND: '报告任务记录不存在',
  ADS_REPORT_ID_NOT_RETURNED: '亚马逊没有返回报告编号',
  ADS_REPORT_NOT_READY: '报告长时间没有生成完成',
}

export function adsReportFailureText(code: string | null, message: string | null): string | null {
  if (!code && !message) return null
  return message ?? (code ? (ADS_REPORT_FAILURE_LABEL[code] ?? `任务失败（${code}）`) : null)
}

/** 只有新报告接口的失败任务可以重试，且同一个失败任务只重试一次（重试建新任务，新任务再失败可继续重试）。 */
export function adsReportRetryable(row: { source: string; status: string }, alreadyRetried: boolean): boolean {
  return row.source === 'V1' && row.status === 'FAILED' && !alreadyRetried
}

/** 历史可用起点的说明：日级数据保留期官方有 15 与 24 个月两种说法（CR-001），以接口实测为准。 */
export const ADS_REPORT_HISTORY_NOTE = '亚马逊日级数据的保留期官方有 15 个月与 24 个月两种说法，以接口实测为准；“历史可用起点”是本系统已经取得数据的最早日期，只会往前推，不是亚马逊的承诺。'
export const ADS_BACKFILL_MONTHS_DEFAULT = 24
export const ADS_BACKFILL_MONTHS_MAX = 25
/** 历史回补一次最多建多少个任务（25 个月按 120 天切片约 7 片）。 */
export const ADS_BACKFILL_MAX_SLICES = 8
export const ADS_PARITY_SUNSET_NOTE = '旧版报告第三版与营销数据流第一版 2027 年 6 月 30 日停止；核对通过（连续多次无未解释差异）后关闭旧通道。'
export const ADS_PARITY_DIFF_LIMIT = 200

const dayText = (stamp: number) => new Date(stamp).toISOString().slice(0, 10)

/** 往前推 N 个月（日历月，日数落到当月最后一天以内），格式 YYYY-MM-DD；日期不合法返回 null。 */
export function monthsBefore(day: string, months: number): string | null {
  const stamp = dayStamp(day)
  if (stamp === null) return null
  const date = new Date(stamp)
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return dayText(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), lastDay)))
}

/** 历史回补的时间片：从今天往前 N 个月，按 120 天切片，最近的片排在前面；月数不合法返回空数组。 */
export function backfillWindowsOf(today: string, months: number): Array<{ from: string; to: string }> {
  if (!Number.isInteger(months) || months < 1 || months > ADS_BACKFILL_MONTHS_MAX) return []
  const from = monthsBefore(today, months)
  return from === null ? [] : sliceReportWindows(from, today).reverse()
}

/** 日粒度、小时、月三种粒度的说明（模板表里展示）。 */
export const adsReportGranularityText = (granularity: AdsReportGranularity | null) => (granularity ? ADS_REPORT_GRANULARITY_LABEL[granularity] : '—')

export interface AdsReportWarningView {
  code: string
  message: string
}

export interface AdsReportProfileRef {
  id: string
  name: string
  storeName: string | null
}

export interface AdsReportRow {
  id: string
  source: AdsReportSource
  templateKey: string | null
  /** 新报告接口任务是模板名称；旧版任务是原始报表类型。 */
  title: string
  adProduct: string
  granularity: AdsReportGranularity | null
  dimensions: string[]
  metrics: string[]
  from: string | null
  to: string | null
  status: AdsReportStatus
  importedRows: number | null
  skippedRows: number | null
  warnings: AdsReportWarningView[]
  failureCode: string | null
  failureText: string | null
  attempt: number
  retryOfId: string | null
  canRetry: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  profile: AdsReportProfileRef
  requestedByName: string | null
}

export interface AdsReportListResponse {
  state: DashState
  note: string | null
  items: AdsReportRow[]
  /** 当前范围内各状态的任务数（不受状态筛选影响）。 */
  counts: Record<AdsReportStatus, number>
  pageInfo: CursorPageInfo
}

export interface AdsReportProfileOption extends AdsReportProfileRef {
  /** 是否已经发现统一接口的广告账户编号：没有就不能创建新报告接口任务。 */
  ready: boolean
  notReadyReason: string | null
  historyFrom: string | null
  historyProbedAt: string | null
}

export interface AdsReportTemplatesResponse {
  state: DashState
  note: string | null
  templates: AdsReportTemplate[]
  profiles: AdsReportProfileOption[]
  historyNote: string
  today: string
}

export interface AdsReportCreateResult {
  report: AdsReportRow
  syncJobId: string
}

export interface AdsReportBackfillResult {
  reports: AdsReportRow[]
  windows: Array<{ from: string; to: string }>
}

// ---- 迁移期对照 ----

export interface AdsParityProfileRow extends AdsReportProfileRef {
  adsAccountReady: boolean
  legacyEnabled: boolean
  consecutivePasses: number
  requiredPasses: number
  lastRunAt: string | null
  closedAt: string | null
  closedReason: string | null
  lastStatus: AdsParityStatus | null
}

export interface AdsParityRunRow {
  id: string
  adsProfileId: string
  profileName: string
  windowStart: string
  windowEnd: string
  legacyCount: number
  newCount: number
  matchedCount: number
  unexplainedCount: number
  warningCount: number
  status: AdsParityStatus
  startedAt: string
  finishedAt: string | null
  counts: Record<AdsParityCategory, number>
}

export interface AdsParityResponse {
  state: DashState
  note: string | null
  sunsetNote: string
  profiles: AdsParityProfileRow[]
  runs: AdsParityRunRow[]
}

export interface AdsParityDiffRow {
  id: string
  category: AdsParityCategory
  entityKey: string
  field: string
  legacyValue: string | null
  newValue: string | null
  explanation: string
}

export interface AdsParityDiffsResponse {
  run: AdsParityRunRow
  items: AdsParityDiffRow[]
  /** 差异行多于上限时只返回前面的（未解释优先），总数看 run.counts。 */
  truncated: boolean
}

export interface AdsParityRunResult {
  syncJobId: string
}
