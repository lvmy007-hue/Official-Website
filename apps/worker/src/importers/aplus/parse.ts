import { APLUS_ASIN_PATTERN, APLUS_CONTENT_TYPES, type AplusContentType } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'

// A+ 内容接口响应的纯解析（P4-14，importers.md I-18）。接口形状依据亚马逊官方文档整理，没有用真实店铺核对（CR-089 未验证清单），所以解析一律宽容：
//   - 缺字段当没有（返回 null 或跳过那一条），不抛错；
//   - 整个响应的形状认不出来（不是对象、关键数组的类型不对、有内容但一个已知字段都没有）才抛 APL_RESPONSE_UNRECOGNIZED（不可重试，重试不会让亚马逊换个格式）；
//   - 响应可能带 payload 外层，也可能没有，两种都认；
//   - 亚马逊返回的警告与拒绝原文只在这里做截断与取字符串，不做任何改写。

export const APLUS_RESPONSE_UNRECOGNIZED = 'APL_RESPONSE_UNRECOGNIZED'

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
/** 非空字符串（去掉首尾空白）；别的类型一律当没有。 */
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const unrecognized = (what: string) => new NonRetryableError(APLUS_RESPONSE_UNRECOGNIZED, `亚马逊的 A+ ${what}响应无法识别`)

/** 取出响应主体（去掉可能的 payload 外层）；一个已知键都没有、而响应又不是空对象时，认为形状不对。 */
function shape(body: unknown, knownKeys: readonly string[], what: string): Loose {
  const root = record(body)
  const base = record(root?.payload) ?? root
  if (!base) throw unrecognized(what)
  if (Object.keys(base).length > 0 && !knownKeys.some(key => key in base)) throw unrecognized(what)
  return base
}

/** 接口给的时间必须是能解析的日期字符串，并且年份合理；认不出来就当没有（不猜）。 */
export function dateOf(value: unknown): Date | null {
  const raw = text(value)
  if (!raw) return null
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) return null
  const year = new Date(time).getUTCFullYear()
  return year >= 2000 && year <= 2100 ? new Date(time) : null
}

// ---- 内容列表与详情 ----

export interface ParsedListItem {
  key: string
  name: string | null
  /** 亚马逊的原始状态文字（大小写原样），映射由调用方用 aplusStatusOf 完成。 */
  status: string | null
  updatedAt: Date | null
}
export interface ParsedList {
  items: ParsedListItem[]
  nextToken: string | null
  /** 缺少引用键而被跳过的条数。 */
  skipped: number
}

/** 查询内容列表：{ contentMetadataRecords: [{ contentReferenceKey, contentMetadata }], nextPageToken }。 */
export function parseContentList(body: unknown): ParsedList {
  const base = shape(body, ['contentMetadataRecords', 'nextPageToken'], '内容列表')
  if ('contentMetadataRecords' in base && !Array.isArray(base.contentMetadataRecords)) throw unrecognized('内容列表')
  const items: ParsedListItem[] = []
  let skipped = 0
  for (const entry of list(base.contentMetadataRecords)) {
    const item = record(entry)
    const key = text(item?.contentReferenceKey)
    if (!item || !key) {
      skipped += 1
      continue
    }
    const metadata = record(item.contentMetadata)
    items.push({ key, name: text(metadata?.name), status: text(metadata?.status), updatedAt: dateOf(metadata?.updateTime) })
  }
  return { items, nextToken: text(base.nextPageToken), skipped }
}

export interface ParsedDetail {
  key: string | null
  name: string | null
  /** 只认 EBC 与 EMC；别的取值当没有（调用方保持原值，不乱填）。 */
  contentType: AplusContentType | null
  locale: string | null
  status: string | null
  updatedAt: Date | null
  /** 亚马逊返回的模块结构，原样保留；接口没返回模块列表时为 null（调用方不能用空数组覆盖已有内容）。 */
  modules: unknown[] | null
  rejectionReason: string | null
}

/** 被拒原文可能出现的字段名：官方模型没有明确这个字段，只能宽容地取（取不到就是没有，绝不编造）。 */
const REJECTION_KEYS = ['rejectionReason', 'rejectionMessage', 'rejectReason', 'statusMessage', 'message', 'reason'] as const
const REJECTION_MAX = 2000

function rejectionOf(metadata: Loose | null): string | null {
  for (const key of REJECTION_KEYS) {
    const value = metadata?.[key]
    const found = text(value) ?? text(record(value)?.message) ?? text(record(value)?.text)
    if (found) return found.slice(0, REJECTION_MAX)
  }
  return null
}

const contentTypeOf = (value: unknown): AplusContentType | null => {
  const upper = text(value)?.toUpperCase()
  return APLUS_CONTENT_TYPES.find(type => type === upper) ?? null
}

/** 取详情：{ contentRecord: { contentReferenceKey, contentMetadata, contentDocument: { name, contentType, locale, contentModuleList } } }。 */
export function parseContentDetail(body: unknown): ParsedDetail {
  const base = shape(body, ['contentRecord'], '内容详情')
  const rec = record(base.contentRecord)
  if (!rec) throw unrecognized('内容详情')
  const metadata = record(rec.contentMetadata)
  const document = record(rec.contentDocument)
  const modules = document?.contentModuleList
  return {
    key: text(rec.contentReferenceKey),
    name: text(document?.name) ?? text(metadata?.name),
    contentType: contentTypeOf(document?.contentType),
    locale: text(document?.locale),
    status: text(metadata?.status),
    updatedAt: dateOf(metadata?.updateTime),
    modules: Array.isArray(modules) ? modules : null,
    rejectionReason: rejectionOf(metadata),
  }
}

// ---- 关联 ASIN ----

export interface ParsedAsins {
  asins: string[]
  nextToken: string | null
  skipped: number
}

/** 取关联 ASIN：{ asinMetadataSet: [{ asin, title, badgeSet, parent, contentReferenceKeySet }], nextPageToken }。ASIN 统一大写，格式不对的跳过。 */
export function parseAsinList(body: unknown): ParsedAsins {
  const base = shape(body, ['asinMetadataSet', 'nextPageToken'], '关联 ASIN')
  if ('asinMetadataSet' in base && !Array.isArray(base.asinMetadataSet)) throw unrecognized('关联 ASIN')
  const found = new Set<string>()
  let skipped = 0
  for (const entry of list(base.asinMetadataSet)) {
    const asin = (text(entry) ?? text(record(entry)?.asin))?.toUpperCase()
    if (asin && APLUS_ASIN_PATTERN.test(asin)) found.add(asin)
    else skipped += 1
  }
  return { asins: [...found], nextToken: text(base.nextPageToken), skipped }
}

// ---- 发布记录 ----

export interface ParsedPublishRecord {
  key: string
  status: string | null
  /** 上线时间：字段名没有核对，按下面的候选名依次找，都认不出来就是 null（不猜、不拿别的时间顶替）。 */
  publishedAt: Date | null
}
export interface ParsedPublishRecords {
  records: ParsedPublishRecord[]
  nextToken: string | null
  skipped: number
}

const PUBLISH_TIME_KEYS = ['publishTime', 'publishedAt', 'liveTime', 'effectiveDate', 'publishDate', 'publishedDate', 'liveDate', 'startTime', 'startDate'] as const

/** 查发布记录：{ contentPublishRecordList: [{ marketplaceId, contentReferenceKey, contentType, contentSubType, contentStatus, …上线时间 }], nextPageToken }。 */
export function parsePublishRecords(body: unknown): ParsedPublishRecords {
  const base = shape(body, ['contentPublishRecordList', 'nextPageToken'], '发布记录')
  if ('contentPublishRecordList' in base && !Array.isArray(base.contentPublishRecordList)) throw unrecognized('发布记录')
  const records: ParsedPublishRecord[] = []
  let skipped = 0
  for (const entry of list(base.contentPublishRecordList)) {
    const item = record(entry)
    const key = text(item?.contentReferenceKey)
    if (!item || !key) {
      skipped += 1
      continue
    }
    const timeKey = PUBLISH_TIME_KEYS.find(name => dateOf(item[name]) !== null)
    records.push({ key, status: text(item.contentStatus), publishedAt: timeKey ? dateOf(item[timeKey]) : null })
  }
  return { records, nextToken: text(base.nextPageToken), skipped }
}

// ---- 写入响应 ----

const WARNINGS_MAX = 50
const WARNING_TEXT_MAX = 500

/** 警告：官方是 [{ code, message, details }]；也认纯字符串。统一成字符串数组（原文截断，不改写）。 */
export function warningsOf(base: Loose | null): string[] {
  return list(base?.warnings)
    .map(item => text(item) ?? text(record(item)?.message) ?? text(record(item)?.code))
    .filter((item): item is string => item !== null)
    .slice(0, WARNINGS_MAX)
    .map(item => item.slice(0, WARNING_TEXT_MAX))
}

export interface WriteAck {
  contentReferenceKey: string | null
  warnings: string[]
}

/**
 * 创建、更新、关联 ASIN、提交审核的响应。2xx 已表示受理，所以没有响应体（null）也算成功；
 * 响应不是对象（字符串、数组）认不出来；创建必须带回内容引用键，否则抛 APL_RESPONSE_UNRECOGNIZED（没有键，后面的操作都无从谈起）。
 */
export function parseWriteAck(body: unknown, requireKey = false): WriteAck {
  if (body === null || body === undefined) {
    if (requireKey) throw unrecognized('创建')
    return { contentReferenceKey: null, warnings: [] }
  }
  const root = record(body)
  if (!root) throw unrecognized('写入')
  const base = record(root.payload) ?? root
  const contentReferenceKey = text(base.contentReferenceKey)
  if (requireKey && !contentReferenceKey) throw unrecognized('创建')
  return { contentReferenceKey, warnings: warningsOf(base) }
}

export interface UploadDestination {
  uploadDestinationId: string
  url: string
  headers: Record<string, string>
}

/** 上传目的地：{ payload: { uploadDestinationId, url, headers } }，也可能没有 payload 外层。上传地址必须是 https。 */
export function parseUploadDestination(body: unknown): UploadDestination {
  const root = record(body)
  const base = record(root?.payload) ?? root
  const uploadDestinationId = text(base?.uploadDestinationId)
  const url = text(base?.url)
  if (!uploadDestinationId || !url || !url.startsWith('https://')) throw unrecognized('上传目的地')
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(record(base?.headers) ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') headers[name] = String(value)
  }
  return { uploadDestinationId, url, headers }
}
