import { FRESHNESS_ERROR_LABEL } from './freshness'
import type { CursorPageInfo } from './query'

// 报表中心（P5-03，09 章 9.3；freeze/api.md /reports*）：把“能创建的每一种报告与数据集”登记成一张目录，页面、接口与导入器核对都读它。
// 本文件只放常量、标签、目录与纯函数，没有 zod（请求校验在 report-center-query.ts）。
// 目录里每一项都必须有导入器：SP-API 报告在 worker 的 reportImporterFor，广告模板在 ads-reports 的行解析与写入器，数据中心数据集在 datakiosk 的注册表；
// worker 的 report-catalog.test.ts 逐项核对，新增目录项而没有导入器会使测试失败。目录里没有的报告类型不能创建，也不会被导入。
// 申请条件（所需角色与资格）来自 importers.md 的“所需角色”一列；各报告的真实角色要求以亚马逊官方文档为准，没有逐个用真实店铺核对。

export const REPORT_READ = 'reports.read'
export const REPORT_WRITE = 'reports.create'
export const REPORT_ACTIONS = { created: 'REPORT_JOB_CREATED', cancelled: 'REPORT_JOB_CANCELLED', retried: 'REPORT_JOB_RETRIED', downloadIssued: 'REPORT_DOWNLOAD_LINK_ISSUED' } as const
/** 原始文件下载链接的有效期（秒）。 */
export const REPORT_DOWNLOAD_TTL_SECONDS = 300
/** 一次列表最多合并读取的行数（三类任务各自按创建时间取前若干条再合并）。 */
export const REPORT_LIST_WINDOW_MAX = 1000
/** 起止日期型报告一次最多申请的天数（我方取的保守上限，没有逐个对照亚马逊文档）。 */
export const REPORT_RANGE_MAX_DAYS = 31
export const REPORT_TIMELINE_MAX = 40
export const REPORT_COLUMNS_MAX = 80

export const REPORT_DOMAINS = ['LOGISTICS', 'BUSINESS', 'BRAND', 'FINANCE', 'ADS', 'DATA_CENTER'] as const
export type ReportDomain = (typeof REPORT_DOMAINS)[number]
export const REPORT_DOMAIN_LABEL: Readonly<Record<ReportDomain, string>> = {
  LOGISTICS: '亚马逊物流',
  BUSINESS: '业务报告',
  BRAND: '品牌分析',
  FINANCE: '财务',
  ADS: '广告',
  DATA_CENTER: '数据中心',
}

export const REPORT_SOURCES = ['SP_API', 'ADS', 'DATA_KIOSK'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]
export const REPORT_SOURCE_LABEL: Readonly<Record<ReportSource, string>> = { SP_API: '亚马逊报告接口', ADS: '广告报告接口', DATA_KIOSK: '数据中心查询' }

/** 创建方式：CREATE 在报表中心创建；RETRIEVE 亚马逊后台生成、系统每日检索（不能主动申请）；LINKED 在对应页面创建；SYSTEM 由系统按计划或页面操作触发。 */
export const REPORT_MODES = ['CREATE', 'RETRIEVE', 'LINKED', 'SYSTEM'] as const
export type ReportMode = (typeof REPORT_MODES)[number]
export const REPORT_MODE_LABEL: Readonly<Record<ReportMode, string>> = { CREATE: '可创建', RETRIEVE: '只能检索', LINKED: '在对应页面创建', SYSTEM: '系统自动' }

/** 数据周期：SNAPSHOT 当前状态快照（无周期）；RANGE 起止日期；BA_PERIOD 完整的自然周、月或季（品牌分析）。 */
export const REPORT_PERIODS = ['SNAPSHOT', 'RANGE', 'BA_PERIOD'] as const
export type ReportPeriod = (typeof REPORT_PERIODS)[number]
export const REPORT_PERIOD_LABEL: Readonly<Record<ReportPeriod, string>> = { SNAPSHOT: '当前快照', RANGE: '起止日期', BA_PERIOD: '自然周、月或季' }

export interface ReportCatalogEntry {
  /** 报告类型（SP-API）、模板键（广告）或数据集编号（数据中心）。 */
  key: string
  source: ReportSource
  domain: ReportDomain
  label: string
  mode: ReportMode
  period: ReportPeriod
  /** 导入器编号（importers.md）。 */
  importer: string
  /** 申请条件：所需角色与资格。 */
  requirement: string
  /** 跳转到对应的分析页。 */
  analysisPath: string | null
  /** LINKED 类：到哪里创建。 */
  createPath: string | null
}

export const REPORT_STATUSES = ['PENDING', 'GENERATING', 'READY', 'FAILED', 'CANCELLED'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]
export const REPORT_STATUS_LABEL: Readonly<Record<ReportStatus, string>> = { PENDING: '排队中', GENERATING: '生成中', READY: '已完成', FAILED: '失败', CANCELLED: '已取消' }
/** 还没有结束的状态（可取消）。 */
export const REPORT_ACTIVE_STATUSES: readonly ReportStatus[] = ['PENDING', 'GENERATING']

export const REPORT_FILE_STATES = ['NONE', 'STORED', 'EXPIRED', 'NOT_STORED', 'NOT_APPLICABLE'] as const
export type ReportFileState = (typeof REPORT_FILE_STATES)[number]
export const REPORT_FILE_LABEL: Readonly<Record<ReportFileState, string>> = {
  NONE: '尚未生成',
  STORED: '已留存',
  EXPIRED: '已过保留期',
  NOT_STORED: '没有留存原始文件',
  NOT_APPLICABLE: '不在报表中心提供文件',
}

export const REPORT_PARSE_STATES = ['NOT_STARTED', 'PARSING', 'DONE', 'FAILED'] as const
export type ReportParseState = (typeof REPORT_PARSE_STATES)[number]
export const REPORT_PARSE_LABEL: Readonly<Record<ReportParseState, string>> = { NOT_STARTED: '未开始', PARSING: '解析中', DONE: '已解析', FAILED: '解析失败' }

export const REPORT_TIMELINE_STAGES = ['REQUESTED', 'SUBMITTED', 'AMAZON_QUEUED', 'AMAZON_PROCESSING', 'AMAZON_DONE', 'DOWNLOADING', 'IMPORTED', 'FAILED', 'CANCELLED', 'RETRIED'] as const
export type ReportTimelineStage = (typeof REPORT_TIMELINE_STAGES)[number]
export const REPORT_TIMELINE_LABEL: Readonly<Record<ReportTimelineStage, string>> = {
  REQUESTED: '已创建任务',
  SUBMITTED: '已向亚马逊申请',
  AMAZON_QUEUED: '亚马逊：排队中',
  AMAZON_PROCESSING: '亚马逊：生成中',
  AMAZON_DONE: '亚马逊：生成完成',
  DOWNLOADING: '开始下载并解析',
  IMPORTED: '导入完成',
  FAILED: '任务失败',
  CANCELLED: '已取消',
  RETRIED: '已创建重试任务',
}
/** 属于亚马逊侧的阶段（详情页的“亚马逊侧状态时间线”只看这几个）。 */
export const REPORT_AMAZON_STAGES: readonly ReportTimelineStage[] = ['SUBMITTED', 'AMAZON_QUEUED', 'AMAZON_PROCESSING', 'AMAZON_DONE']
/** 亚马逊 getReport 的处理状态 → 时间线阶段。 */
export const AMAZON_PROCESSING_STAGE: Readonly<Record<string, ReportTimelineStage>> = { IN_QUEUE: 'AMAZON_QUEUED', IN_PROGRESS: 'AMAZON_PROCESSING', DONE: 'AMAZON_DONE' }

export interface ReportTimelineEvent {
  at: string
  stage: ReportTimelineStage
  text?: string
}
const TIMELINE_STAGE_SET = new Set<string>(REPORT_TIMELINE_STAGES)

/** 从 JSON 列读出时间线；格式不对的条目丢弃。接口与后台任务共用这一份读法。 */
export function reportEventsOf(value: unknown): ReportTimelineEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const { at, stage, text } = item as { at?: unknown; stage?: unknown; text?: unknown }
    if (typeof at !== 'string' || typeof stage !== 'string' || !TIMELINE_STAGE_SET.has(stage)) return []
    return [{ at, stage: stage as ReportTimelineStage, ...(typeof text === 'string' && text ? { text } : {}) }]
  })
}

/** 追加一个事件：和最后一个事件的阶段与文字都相同就不重复记（轮询会反复看到同一个状态），超过上限丢最早的。 */
export function appendReportEvent(current: unknown, stage: ReportTimelineStage, text?: string, now: Date = new Date()): ReportTimelineEvent[] {
  const events = reportEventsOf(current)
  const last = events[events.length - 1]
  if (last && last.stage === stage && (last.text ?? '') === (text ?? '')) return events
  return [...events, { at: now.toISOString(), stage, ...(text ? { text } : {}) }].slice(-REPORT_TIMELINE_MAX)
}

export interface ReportTimelineItem extends ReportTimelineEvent {
  label: string
  side: 'AMAZON' | 'LOCAL'
}

export interface ReportWarning {
  code: string
  message: string
}
export const REPORT_WARNING_LABEL = { NEW_COLUMN: '新出现的字段', MISSING_COLUMN: '上一份报告有、这一份没有的字段' } as const

const REPORT_FAILURE_LABEL: Readonly<Record<string, string>> = {
  REPORT_CANCELLED: '已在报表中心取消',
  CANCELLED: '亚马逊侧报告已取消',
  CANCELED: '亚马逊侧报告已取消',
  FATAL: '亚马逊侧生成报告失败（FATAL），可稍后重试；多次失败请联系亚马逊支持',
  FAILED: '亚马逊侧生成报告失败',
  QUEUE_UNAVAILABLE: '任务队列暂时不可用，没有排上队，请稍后重试',
  REPORT_ROWS_NOT_IMPORTED: '文件里有数据行，但一行都没有导入：多半是列名与预期不一致，请对照原始文件',
  REPORT_DOCUMENT_ID_NOT_RETURNED: '亚马逊报告已完成，但没有返回文件编号',
  REPORT_ID_NOT_RETURNED: '亚马逊没有返回报告编号',
  REPORT_TYPE_NOT_REGISTERED: '这个报告类型不在报表中心的目录里，没有对应的导入器',
  BA_NO_BRAND: '店铺没有品牌备案或没有品牌分析角色，这类报告对该店铺不适用',
  BA_PERIOD_INVALID: '品牌分析报告的时间范围必须是完整的自然周（周日至周六）、自然月或自然季度',
  JOB_TENANT_MISMATCH: '任务引用了不属于本企业的对象，已拒绝',
}

/** 失败原因的中文说明：先用任务自己写下的说明，再按失败码查（本表、同步新鲜度表），都没有写“原因未记录”。 */
export const reportFailureText = (code: string | null | undefined, message?: string | null): string | null => {
  if (message) return message
  if (!code) return null
  return REPORT_FAILURE_LABEL[code] ?? FRESHNESS_ERROR_LABEL[code] ?? `失败（${code}），具体原因未记录，可查看关联的同步任务`
}

export type ReportListState = 'OK' | 'NO_DATA'

export interface ReportRow {
  id: string
  source: ReportSource
  /** 目录里没有的类型（旧任务）没有业务域。 */
  domain: ReportDomain | null
  reportKey: string
  label: string
  storeName: string | null
  from: string | null
  to: string | null
  /** 数据周期的文字：快照类写“当前快照”，没有记录的写“未记录”。 */
  periodText: string
  status: ReportStatus
  failureCode: string | null
  failureText: string | null
  fileState: ReportFileState
  parseState: ReportParseState
  readRows: number | null
  importedRows: number | null
  skippedRows: number | null
  /** 原始文件保留到哪天；没有留存文件为 null。 */
  retentionUntil: string | null
  requirement: string
  createdAt: string
  createdByName: string | null
  attempt: number
  retryOfId: string | null
  canCancel: boolean
  canRetry: boolean
  canDownload: boolean
  analysisPath: string | null
  createPath: string | null
}

export interface ReportListResponse {
  state: ReportListState
  note: string | null
  items: ReportRow[]
  pageInfo: CursorPageInfo
  /** 各状态条数（不受状态筛选影响，受业务域筛选影响）。 */
  counts: Record<ReportStatus, number>
  /** 各业务域条数（不受业务域筛选影响）。 */
  domainCounts: Record<ReportDomain, number>
  /** 读取窗口被截断：更早的任务没有合并进列表。 */
  truncated: boolean
}

export interface ReportSyncJobView {
  id: string
  type: string
  status: string
  attempts: number
  failureCode: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface ReportImportStats {
  read: number | null
  imported: number | null
  skipped: number | null
  /** 读到但既没导入也没算跳过的行（例如与本报告无关的类型）。 */
  ignored: number | null
  /** 导入器只统计“写入”行数，不区分新增与更新；此处恒为 null，页面写“未区分”。 */
  added: null
  updated: null
  /** 一个批次写库失败会让整份报告失败，不存在“部分行失败”，所以成功的任务写 0，其余为 null。 */
  failed: number | null
}

export interface ReportRequestView {
  marketplaceId: string | null
  externalReportId: string | null
  requestId: string
  requestedBy: string | null
  dimensions: string[]
  metrics: string[]
  adProduct: string | null
  dataset: string | null
  params: Record<string, string> | null
}

export interface ReportDetailResponse {
  report: ReportRow
  request: ReportRequestView
  timeline: ReportTimelineItem[]
  stats: ReportImportStats
  warnings: ReportWarning[]
  syncJob: ReportSyncJobView | null
  /** 这一份详情里没有的信息说明（例如广告与数据中心任务没有逐阶段的亚马逊时间线）。 */
  notes: string[]
}

export interface ReportCreateResponse {
  report: ReportRow
  syncJobId: string
}

export interface ReportDownloadResponse {
  url: string
  expiresAt: string
}

/** 把起止日期写成文字。 */
export function reportPeriodText(period: ReportPeriod | null, from: string | null, to: string | null): string {
  if (from && to) return from === to ? from : `${from} 至 ${to}`
  if (period === 'SNAPSHOT') return '当前快照'
  return '未记录'
}

/** 解析状态：由状态与时间线推出（下载开始之后失败 = 解析失败）。 */
export function reportParseState(status: ReportStatus, stages: readonly ReportTimelineStage[]): ReportParseState {
  if (status === 'READY') return 'DONE'
  const downloading = stages.includes('DOWNLOADING')
  if (status === 'FAILED') return downloading ? 'FAILED' : 'NOT_STARTED'
  if (status === 'GENERATING' && downloading) return 'PARSING'
  return 'NOT_STARTED'
}

/** 取消只对没有结束的任务；重试对失败与已取消、且还没有被重试过的任务（只有 SP-API 报告任务在报表中心重试，其他来源去各自页面）。 */
export const reportCanCancel = (source: ReportSource, status: ReportStatus): boolean => source === 'SP_API' && REPORT_ACTIVE_STATUSES.includes(status)
export const reportCanRetry = (source: ReportSource, status: ReportStatus, retried: boolean): boolean => source === 'SP_API' && (status === 'FAILED' || status === 'CANCELLED') && !retried

/** 新旧字段对比（新出现与消失的字段）：没有上一份可比时不产生警告。 */
export function columnWarnings(current: readonly string[], previous: readonly string[] | null): ReportWarning[] {
  if (!previous || previous.length === 0 || current.length === 0) return []
  const before = new Set(previous)
  const now = new Set(current)
  const added = current.filter(name => !before.has(name))
  const removed = previous.filter(name => !now.has(name))
  return [
    ...(added.length > 0 ? [{ code: 'NEW_COLUMN', message: `${REPORT_WARNING_LABEL.NEW_COLUMN}：${added.slice(0, 20).join('、')}` }] : []),
    ...(removed.length > 0 ? [{ code: 'MISSING_COLUMN', message: `${REPORT_WARNING_LABEL.MISSING_COLUMN}：${removed.slice(0, 20).join('、')}` }] : []),
  ]
}
