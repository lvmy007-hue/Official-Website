import type { CursorPageInfo } from './query.js'
import type { InventoryFreshness } from './inventory.js'

// A+ 内容（P4-14，05 章 5.8）：常量、类型与口径文字。模块结构与校验在 aplus-modules.ts，纯计算在 aplus-math.ts，请求校验在 aplus-query.ts（zod 单独成文件）。
// 数据来源：A+ 内容管理接口（内容查询、创建、更新、关联 ASIN、提交审核、发布记录）、上传接口（图片）、销售与流量（发布前后对照）。
// 没有数据显示“尚无记录”，没有权限显示“无权限”，来源没接上显示“尚未接入”，永远不显示成 0。接口字段依据官方文档整理，没有用真实店铺核对（CR-089）。

export const APLUS_READ = 'aplus.read'
export const APLUS_WRITE = 'aplus.write'
export const APLUS_SWITCH_KEY = 'sw.aplus.submit'
export const APLUS_SYNC_JOB = 'APLUS_SYNC'
export const APLUS_WRITE_JOB = 'APLUS_WRITE'
export const APLUS_FRESHNESS_KEY = 'aplus.api'
/** 店铺没有品牌备案或没获批 A+ 内容角色，接口返回 403：同步任务以这个不可重试的失败码结束（新鲜度记“未授权”，不触发同步失败预警）。 */
export const APLUS_ROLE_MISSING = 'APL_ROLE_MISSING'
export const APLUS_MARKETPLACE_ID = 'ATVPDKIKX0DER'
export const APLUS_ASIN_PATTERN = /^[A-Z0-9]{10}$/
export const APLUS_ACTIONS = {
  created: 'APLUS_CREATED',
  updated: 'APLUS_UPDATED',
  asinsAssociated: 'APLUS_ASINS_ASSOCIATED',
  imageUploaded: 'APLUS_IMAGE_UPLOADED',
  submitted: 'APLUS_SUBMITTED',
} as const

/** 内容状态。PUBLISHED = 已批准，并且发布记录里能查到关联 ASIN 的上线时间。 */
export const APLUS_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PUBLISHED'] as const
export type AplusStatus = (typeof APLUS_STATUSES)[number]
export const APLUS_STATUS_LABEL: Record<AplusStatus, string> = { DRAFT: '草稿', SUBMITTED: '已提交', APPROVED: '已批准', REJECTED: '被拒', PUBLISHED: '已发布' }
export const APLUS_CONTENT_TYPES = ['EBC', 'EMC'] as const
export type AplusContentType = (typeof APLUS_CONTENT_TYPES)[number]
export const APLUS_CONTENT_TYPE_LABEL: Record<AplusContentType, string> = { EBC: '标准 A+ 内容', EMC: '高级 A+ 内容' }
export const APLUS_LOCALES = ['en-US'] as const

export const APLUS_RUN_KINDS = ['CREATE', 'UPDATE', 'ASSOCIATE', 'UPLOAD', 'SUBMIT'] as const
export type AplusRunKind = (typeof APLUS_RUN_KINDS)[number]
export const APLUS_RUN_KIND_LABEL: Record<AplusRunKind, string> = { CREATE: '创建内容', UPDATE: '保存修改', ASSOCIATE: '关联 ASIN', UPLOAD: '上传图片', SUBMIT: '提交审核' }
export const APLUS_RUN_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const
export type AplusRunStatus = (typeof APLUS_RUN_STATUSES)[number]
export const APLUS_RUN_STATUS_LABEL: Record<AplusRunStatus, string> = { QUEUED: '排队中', RUNNING: '处理中', SUCCEEDED: '已完成', FAILED: '失败' }

export const APLUS_SORTS = ['updatedAt', 'name', 'asinCount', 'status'] as const
export type AplusSort = (typeof APLUS_SORTS)[number]

export const APLUS_UPLOAD_TYPES = ['image/jpeg', 'image/png'] as const

export const APLUS_LIMITS = {
  nameMax: 100,
  /** 一份内容最多的模块数（保守上限，亚马逊对各类内容有自己的规定，以亚马逊的审核为准）。 */
  modulesMax: 5,
  /** 一次关联最多的 ASIN 数。 */
  asinsPerRequestMax: 50,
  /** 图片：单个文件上限与列表展示条数。 */
  imageMaxBytes: 5 * 1024 * 1024,
  uploadsShown: 50,
  /** 详情页：时间线、写入记录、关联 ASIN 展示条数。 */
  timelineMax: 200,
  runsShown: 20,
  asinsShown: 500,
  /** 同步：每次最多逐个取详情的内容数、每次最多查发布记录的 ASIN 数。 */
  syncContentsMax: 100,
  syncPublishAsinsMax: 30,
  /** 列表读取上限（Prisma take 上限 20000，判断截断要多读一行）。 */
  listMax: 19_999,
  pageSizeDefault: 50,
  /** 前后对照：各取发布日前后各这么多天；每侧至少这么多会话才给结论；发布后不足这么多天不对比。 */
  compareDays: 28,
  compareMinSessions: 100,
  compareMinAfterDays: 7,
} as const

export const APLUS_BASIS =
  'A+ 内容来自亚马逊 A+ 内容管理接口（每日同步一次，需要品牌备案与品牌内容角色）。状态：草稿、已提交、已批准、被拒来自接口；“已发布”表示已批准且发布记录里能查到关联 ASIN 的上线时间。所有创建、修改、关联 ASIN、上传图片与提交审核都受写入开关“A+ 内容提交”控制，操作先登记再由后台任务发给亚马逊，结果在“写入记录”里看。'
export const APLUS_PREVIEW_NOTE = '接口只返回图片编号、不返回图片地址，预览用占位框表示图片位置、尺寸与替代文字；真实效果以亚马逊详情页为准。'
export const APLUS_COMPARE_BASIS =
  '发布前后对照：以关联 ASIN 里最早的上线时间（按 UTC 日期）为界，取前后各 28 天（发布当天不计入）的销售与流量，转化率 = 订购件数 ÷ 会话，合计所有关联 ASIN；每侧会话不少于 100 才给结论。只反映时间上的先后，价格、广告、季节与库存的变化都没有剔除，不代表 A+ 内容带来的因果效果。'
export const APLUS_ADVICE_BASIS = '修复建议是按拒绝原文里的关键词给出的通用提示，不是亚马逊的官方意见；接口没有返回拒绝原文时只能到卖家后台查看。'

// ---- 通用 ----

export type AplusSectionState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED'
export interface AplusStoreRef {
  id: string
  name: string
}
export interface AplusWriteStatus {
  allowed: boolean
  step: 'PERMISSION' | 'CONNECTION' | 'SWITCH' | null
  reason: string | null
  remedyPath: string | null
}
export interface AplusPendingRun {
  kind: AplusRunKind
  kindLabel: string
  status: 'QUEUED' | 'RUNNING'
}

// ---- 列表 ----

export interface AplusRow {
  id: string
  storeId: string
  storeName: string
  name: string
  contentType: AplusContentType
  contentTypeLabel: string
  locale: string
  status: AplusStatus
  statusLabel: string
  asinCount: number
  /** 亚马逊的内容引用键；本地新建、亚马逊还没创建成功的草稿为 null。 */
  contentReferenceKey: string | null
  updatedAt: string
  rejectionReason: string | null
  publishedAt: string | null
  /** 正在排队或处理的写入（同一内容同一时间只允许一个）。 */
  pendingRun: AplusPendingRun | null
}
export interface AplusSummary {
  total: number
  byStatus: Record<AplusStatus, number>
  /** 有写入正在排队或处理的内容数。 */
  pending: number
}
export interface AplusListResponse {
  state: AplusSectionState
  note: string | null
  items: AplusRow[]
  pageInfo: CursorPageInfo
  summary: AplusSummary
  stores: AplusStoreRef[]
  freshness: InventoryFreshness | null
  write: AplusWriteStatus
  truncated: boolean
  basis: string
}

// ---- 详情 ----

export interface AplusAsinRow {
  asin: string
  title: string | null
  publishedAt: string | null
}
export interface AplusTimelineEvent {
  status: AplusStatus
  statusLabel: string
  /** 亚马逊给的原文（被拒原因）；没有为 null。 */
  message: string | null
  occurredAt: string
  source: 'SYNC' | 'LOCAL'
}
export interface AplusRunRow {
  id: string
  kind: AplusRunKind
  kindLabel: string
  status: AplusRunStatus
  statusLabel: string
  failureCode: string | null
  failureText: string | null
  warnings: string[]
  requestedBy: string | null
  createdAt: string
  finishedAt: string | null
}
export interface AplusActionState {
  allowed: boolean
  reason: string | null
}
export interface AplusActions {
  edit: AplusActionState
  associate: AplusActionState
  submit: AplusActionState
}
export interface AplusCompareSide {
  from: string
  to: string
  days: number
  daysWithData: number
  sessions: number | null
  units: number | null
  /** 订购件数 ÷ 会话（小数）；会话为 0 或没有数据为 null。 */
  conversion: number | null
}
export type AplusCompareState = 'OK' | 'NOT_PUBLISHED' | 'NO_PUBLISH_TIME' | 'TOO_RECENT' | 'INSUFFICIENT_DATA' | 'NOT_CONNECTED' | 'RESTRICTED'
export interface AplusCompare {
  state: AplusCompareState
  note: string | null
  publishedAt: string | null
  before: AplusCompareSide | null
  after: AplusCompareSide | null
  /** 发布后 − 发布前的转化率差（小数，0.01 = 1 个百分点）与相对变化（小数）；任一侧没有转化率为 null。 */
  delta: number | null
  relative: number | null
  asinCount: number
  basis: string
}
export interface AplusRejection {
  reason: string | null
  advice: string[]
  adviceBasis: string
}
export interface AplusDetailResponse {
  item: AplusRow
  /** 亚马逊的模块结构（contentModuleList）原样返回；页面用 aplusModulesFromAmazon 转成表单模型预览与编辑。 */
  modules: unknown[]
  /** 能否在编辑器里编辑：只要有一个模块不在支持范围、或转换后与原结构不一致，就不允许编辑（避免保存时丢失内容）。 */
  editable: boolean
  editNote: string | null
  version: number
  asins: AplusAsinRow[]
  asinsTruncated: boolean
  timeline: AplusTimelineEvent[]
  rejection: AplusRejection | null
  compare: AplusCompare
  runs: AplusRunRow[]
  write: AplusWriteStatus
  actions: AplusActions
  freshness: InventoryFreshness | null
  basis: string
}

// ---- 图片上传 ----

export interface AplusUploadRow {
  id: string
  storeId: string
  storeName: string
  fileName: string
  contentType: string
  sizeBytes: number
  width: number
  height: number
  status: AplusRunStatus
  statusLabel: string
  /** 上传成功后亚马逊给的上传编号，模块里的图片用它引用；没成功为 null。 */
  uploadDestinationId: string | null
  failureCode: string | null
  failureText: string | null
  createdAt: string
  requestedBy: string | null
}
export interface AplusUploadsResponse {
  items: AplusUploadRow[]
  stores: AplusStoreRef[]
  write: AplusWriteStatus
  maxBytes: number
  types: readonly string[]
}
export interface AplusUploadTicket {
  uploadUrl: string
  method: 'PUT'
  headers: Record<string, string>
  objectKey: string
  expiresAt: string
  maxBytes: number
}

// ---- 写入结果（POST 返回 201、PATCH 返回 200，后台任务稍后完成）----

export interface AplusWriteResult {
  /** 内容编号（创建时是新建的本地内容）；上传图片没有内容，为 null。 */
  contentId: string | null
  runId: string
  status: 'QUEUED'
  /** 受理后的内容版本号（下一次提交要带它）；上传图片为 null。 */
  version: number | null
  /** 任务没能入队时为 false（写入记录已标为失败，可以重新提交）。 */
  queued: boolean
}
export interface AplusUploadResult extends AplusWriteResult {
  width: number
  height: number
}

/** 失败码 → 中文说明。失败码只留“来源 + 状态码”（SP_API_400），亚马逊返回的原文不入库。 */
export function aplusFailureText(code: string | null | undefined): string | null {
  if (!code) return null
  if (/^SP_API_401|^SP_API_403/.test(code)) return '亚马逊拒绝了授权：请检查品牌备案与 A+ 内容角色，并确认授权没有失效'
  if (/^SP_API_429/.test(code)) return '亚马逊限流，稍后重试'
  if (/^SP_API_4\d\d/.test(code)) return `亚马逊拒绝了这次请求（${code.slice(7)}）：内容或图片不符合要求，请修改后重新提交`
  if (/^SP_API_5\d\d/.test(code)) return '亚马逊服务暂时不可用，稍后重试'
  const known: Record<string, string> = {
    APL_SWITCH_OFF: '写入开关“A+ 内容提交”已关闭，没有向亚马逊发出请求',
    APL_FILE_MISSING: '图片文件已不在存储里，请重新上传',
    APL_UPLOAD_FAILED: '图片没能传到亚马逊的上传地址，请重新上传',
    APL_KEY_MISSING: '这份内容在亚马逊还没有创建成功，不能做这个操作',
    APL_RESPONSE_UNRECOGNIZED: '亚马逊的响应无法识别，请稍后重试或联系管理员',
    APL_REQUEST_INVALID: '请求内容不完整，没有发给亚马逊',
    QUEUE_UNAVAILABLE: '任务队列暂时不可用，没有发出请求，请重新提交',
  }
  return known[code] ?? '写入失败，请稍后重试或查看同步中心'
}
