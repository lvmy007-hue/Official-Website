import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 刊登质量与合规契约（P4-10，05 章 5.4）：只有常量、类型与纯函数，没有 zod（请求校验在 listing-quality-query.ts）。
// 数据来源（都是只读副本，没有来源的区块一律写“尚未接入”，不用 0 或估算值代替）：
//   - 刊登接口（I-10，searchListingsItems）每日同步：问题项、刊登状态、商品类型、标题与主图；
//   - 被搜索抑制报告（R-32，GET_MERCHANTS_LISTINGS_FYP_REPORT）每日；
//   - 刊登限制（I-11）按需查询，结果随查询任务保存、1 小时后过期；
//   - 推送（N-08 至 N-12）处理器已有，但推送接收端按 14.10 暂缓，没有接收端时不会有推送数据。

export const LISTING_QUALITY_READ = 'listing.read'
export const LISTING_QUALITY_WRITE = 'listing.write'
export const LISTING_SYNC_JOB = 'LISTING_SYNC'
export const LISTING_FRESHNESS_KEY = 'listings.items-v2021'
export const LISTING_FYP_REPORT_TYPE = 'GET_MERCHANTS_LISTINGS_FYP_REPORT'
export const LISTING_MARKETPLACE_ID = 'ATVPDKIKX0DER'
/** 刊登接口的角色（“商品刊登”）未获批时同步任务的失败码（不可重试）。 */
export const LISTING_ROLE_MISSING = 'LISTING_ROLE_MISSING'

export const LISTING_QUALITY_TABS = ['issues', 'suppressed', 'restrictions', 'missing', 'productType', 'otherEdits', 'inactive'] as const
export type ListingQualityTab = (typeof LISTING_QUALITY_TABS)[number]
export const LISTING_QUALITY_TAB_LABEL: Record<ListingQualityTab, string> = {
  issues: '问题项',
  suppressed: '被搜索抑制',
  restrictions: '刊登限制',
  missing: '属性缺失',
  productType: '商品类型变更',
  otherEdits: '他人内容修改',
  inactive: '非活跃刊登',
}

export const LISTING_ISSUE_KINDS = ['ISSUE', 'SEARCH_SUPPRESSED', 'COMPLIANCE'] as const
export type ListingIssueKind = (typeof LISTING_ISSUE_KINDS)[number]
export const LISTING_ISSUE_KIND_LABEL: Record<ListingIssueKind, string> = { ISSUE: '刊登问题', SEARCH_SUPPRESSED: '搜索抑制', COMPLIANCE: '合规' }

/** 只存错误与警告（05 章 5.4）；亚马逊的提示级（INFO）不入库。 */
export const LISTING_SEVERITIES = ['ERROR', 'WARNING'] as const
export type ListingSeverity = (typeof LISTING_SEVERITIES)[number]
export const LISTING_SEVERITY_LABEL: Record<ListingSeverity, string> = { ERROR: '错误', WARNING: '警告' }

export const LISTING_IMPACTS = ['NONE', 'SEARCH_SUPPRESSED', 'ATTRIBUTE_SUPPRESSED', 'LISTING_SUPPRESSED'] as const
export type ListingImpact = (typeof LISTING_IMPACTS)[number]
export const LISTING_IMPACT_LABEL: Record<ListingImpact, string> = {
  NONE: '无影响',
  SEARCH_SUPPRESSED: '被搜索抑制',
  ATTRIBUTE_SUPPRESSED: '属性被抑制',
  LISTING_SUPPRESSED: '不可售（刊登被抑制）',
}
const IMPACT_RANK: Record<ListingImpact, number> = { NONE: 0, ATTRIBUTE_SUPPRESSED: 1, SEARCH_SUPPRESSED: 2, LISTING_SUPPRESSED: 3 }

/** 亚马逊问题项的执法动作 → 影响：多个动作取最重的一个。认不出的动作按“无影响”处理，不猜。 */
export function listingImpactOf(actions: readonly string[]): ListingImpact {
  let worst: ListingImpact = 'NONE'
  for (const action of actions) {
    const value = (LISTING_IMPACTS as readonly string[]).includes(action) ? (action as ListingImpact) : 'NONE'
    if (IMPACT_RANK[value] > IMPACT_RANK[worst]) worst = value
  }
  return worst
}

export const LISTING_ISSUE_STATUSES = ['NEW', 'IN_PROGRESS', 'RESOLVED'] as const
export type ListingIssueStatus = (typeof LISTING_ISSUE_STATUSES)[number]
export const LISTING_ISSUE_STATUS_LABEL: Record<ListingIssueStatus, string> = { NEW: '新增', IN_PROGRESS: '处理中', RESOLVED: '已解决' }
/** 状态筛选：OPEN = 新增 + 处理中（默认）。 */
export const LISTING_ISSUE_STATUS_FILTERS = ['OPEN', 'NEW', 'IN_PROGRESS', 'RESOLVED', 'ALL'] as const
export type ListingIssueStatusFilter = (typeof LISTING_ISSUE_STATUS_FILTERS)[number]

/** 问题状态：已解决由同步器在问题消失时写入；处理中由本系统提交修复（修改或批量任务）时标记；其余是新增。 */
export function listingIssueStatusOf(row: { resolvedAt: Date | string | null; handlingStatus: string }): ListingIssueStatus {
  if (row.resolvedAt) return 'RESOLVED'
  return row.handlingStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'NEW'
}

export const LISTING_CHANGE_KINDS = ['PRODUCT_TYPE_CHANGE', 'CONTENT_CHANGE'] as const
export type ListingChangeKind = (typeof LISTING_CHANGE_KINDS)[number]
export const LISTING_CHANGE_KIND_LABEL: Record<ListingChangeKind, string> = { PRODUCT_TYPE_CHANGE: '商品类型变更', CONTENT_CHANGE: '内容变更' }
export const LISTING_ACTORS = ['SELF', 'AMAZON', 'OTHER', 'UNKNOWN'] as const
export type ListingActor = (typeof LISTING_ACTORS)[number]
export const LISTING_ACTOR_LABEL: Record<ListingActor, string> = { SELF: '本系统', AMAZON: '亚马逊', OTHER: '他人', UNKNOWN: '未知（非本系统）' }
/** 同步器能观察到的内容字段（只有标题与主图；五点、描述、全部图片与 A+ 属于 P4-14）。 */
export const LISTING_CONTENT_FIELDS = { item_name: '标题', main_image: '主图' } as const
export const listingFieldLabel = (field: string): string => (LISTING_CONTENT_FIELDS as Record<string, string>)[field] ?? field

/** 刊登摘要的状态数组 → 本系统的状态：包含 BUYABLE 是活跃，其余（只有 DISCOVERABLE、或数组为空）是非活跃。 */
export const listingStatusOfSummary = (statuses: readonly string[]): 'ACTIVE' | 'INACTIVE' => (statuses.includes('BUYABLE') ? 'ACTIVE' : 'INACTIVE')

export const LISTING_QUALITY_LIMITS = { pageMax: 200, statsResolvedRead: 5000, impactRows: 200, impactMinSpanDays: 2, impactMaxSpanDays: 180, textMax: 1000 } as const

/** 问题修复建议：按类别与影响给出方向性的建议（不是亚马逊原文；原文在“描述”列）。 */
export function listingAdviceOf(issue: { category: string; attributeName: string; kind: string; impact: ListingImpact; severity: string }): string {
  const attribute = issue.attributeName ? `属性「${issue.attributeName}」` : '相关属性'
  if (issue.kind === 'SEARCH_SUPPRESSED') return '检查标题、关键属性与图片是否完整、准确，补齐后亚马逊会自动恢复搜索展示；修复后在这里点“修复刊登”提交。'
  if (issue.category === 'MISSING_ATTRIBUTE') return `补充${attribute}的取值（必填项缺失会导致刊登不可售或被抑制），提交前先做校验预览。`
  if (issue.category === 'INVALID_ATTRIBUTE') return `修正${attribute}的取值或格式，使其符合该商品类型的要求，提交前先做校验预览。`
  if (issue.kind === 'COMPLIANCE') return '合规类问题通常需要在亚马逊卖家后台补充资质、证明文件或申请审核，系统内只能修改相关属性。'
  if (issue.impact === 'LISTING_SUPPRESSED') return '这个问题让刊登不可售，请优先处理：先阅读描述，再修改对应属性并做校验预览。'
  return issue.severity === 'ERROR' ? '按描述修改相关属性，提交前先做校验预览。' : '警告不影响销售，建议在方便时按描述优化。'
}

// ---- 问题对销售的影响估算 ----

export interface ListingImpactEstimate {
  isEstimate: true
  state: 'OK' | 'NO_DATA' | 'NOT_APPLICABLE'
  note: string | null
  spanDays: number
  /** 问题存续期内的日均销售额 / 此前同长度时段的日均销售额（美元，没有数据为 null）。 */
  duringDaily: number | null
  beforeDaily: number | null
  /** 估算的销售额变化 = （存续期日均 − 此前日均）× 存续天数；负数表示可能的损失。 */
  estimatedChange: number | null
}

const DAY_MS = 86_400_000
const dayIndex = (date: Date | string) =>
  Math.floor((typeof date === 'string' ? Date.parse(`${date.slice(0, 10)}T00:00:00Z`) : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) / DAY_MS)

/**
 * 影响估算：问题存续期（首次出现到解决或到 `now`）内的日均销售额，与此前同长度时段对比。
 * 这是粗略的对比，没有排除季节、促销与广告变化，页面一律标“估算”；存续期太短、此前没有销售记录或销售汇总里没有这个商品时不给数。
 */
export function estimateIssueImpact(input: {
  impact: ListingImpact
  firstSeenAt: Date
  endAt: Date
  /** 这个店铺 × ASIN 的逐日销售额（日期 YYYY-MM-DD → 美元）。 */
  salesByDay: ReadonlyMap<string, number> | null
}): ListingImpactEstimate {
  const base = { isEstimate: true as const, duringDaily: null, beforeDaily: null, estimatedChange: null }
  if (input.impact === 'NONE') return { ...base, state: 'NOT_APPLICABLE', note: '这个问题不影响展示与销售，不做影响估算', spanDays: 0 }
  const start = dayIndex(input.firstSeenAt)
  const end = dayIndex(input.endAt)
  const spanDays = Math.min(end - start + 1, LISTING_QUALITY_LIMITS.impactMaxSpanDays)
  if (spanDays < LISTING_QUALITY_LIMITS.impactMinSpanDays) return { ...base, state: 'NO_DATA', note: `问题存续不足 ${LISTING_QUALITY_LIMITS.impactMinSpanDays} 天，样本太短，不做估算`, spanDays }
  if (!input.salesByDay || input.salesByDay.size === 0) return { ...base, state: 'NO_DATA', note: '销售汇总里没有这个商品的销售记录，无法估算', spanDays }
  const sumOf = (from: number, to: number) => {
    let total = 0
    let days = 0
    for (let day = from; day <= to; day += 1) {
      const value = input.salesByDay!.get(new Date(day * DAY_MS).toISOString().slice(0, 10))
      if (value !== undefined) days += 1
      total += value ?? 0
    }
    return { total, days }
  }
  const during = sumOf(end - spanDays + 1, end)
  const before = sumOf(end - 2 * spanDays + 1, end - spanDays)
  if (before.days === 0) return { ...base, state: 'NO_DATA', note: '问题出现之前同长度时段内没有销售记录，无法对比', spanDays }
  const duringDaily = during.total / spanDays
  const beforeDaily = before.total / spanDays
  return { isEstimate: true, state: 'OK', note: null, spanDays, duringDaily, beforeDaily, estimatedChange: (duringDaily - beforeDaily) * spanDays }
}

/** 平均解决时长（小时）：只算已解决且时间合理（解决时间不早于首次出现）的问题，没有样本为 null。 */
export function averageResolveHours(rows: ReadonlyArray<{ firstSeenAt: Date; resolvedAt: Date | null }>): number | null {
  const spans = rows.flatMap(row => (row.resolvedAt && row.resolvedAt >= row.firstSeenAt ? [(row.resolvedAt.getTime() - row.firstSeenAt.getTime()) / 3_600_000] : []))
  return spans.length === 0 ? null : spans.reduce((sum, value) => sum + value, 0) / spans.length
}

// ---- 刊登限制 ----

export const LISTING_RESTRICTION_REASON_LABEL: Record<string, string> = {
  APPROVAL_REQUIRED: '需要先获得类目或品牌批准',
  ASIN_NOT_FOUND: '目录里没有这个 ASIN',
  NOT_ELIGIBLE: '当前账户不具备销售资格',
}
export const listingRestrictionReasonLabel = (code: string): string => LISTING_RESTRICTION_REASON_LABEL[code] ?? '亚马逊没有给出可识别的原因代码'
/** 刊登限制的查询结果在查询任务里保存的时长（importers.md I-11：缓存保留 1 小时）。 */
export const LISTING_RESTRICTION_TTL_MS = 60 * 60 * 1000

// ---- 响应 ----

export interface ListingIssueRow {
  id: string
  storeId: string
  storeName: string
  sku: string
  asin: string
  productId: string | null
  title: string | null
  imageUrl: string | null
  kind: ListingIssueKind
  code: string
  attributeName: string
  category: string
  severity: ListingSeverity
  impact: ListingImpact
  message: string
  advice: string
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  /** 存续时长（小时）：首次出现到解决，未解决的算到现在。 */
  durationHours: number
  status: ListingIssueStatus
  ownerUserId: string | null
  ownerName: string | null
  estimate: ListingImpactEstimate | null
}

export interface ListingChangeRow {
  id: string
  storeId: string
  storeName: string
  sku: string
  asin: string
  productId: string | null
  title: string | null
  kind: ListingChangeKind
  fieldPath: string
  fieldLabel: string
  before: string | null
  after: string | null
  actor: ListingActor
  actorLabel: string
  occurredAt: string
}

export interface ListingInactiveRow {
  id: string
  storeId: string
  storeName: string
  sku: string
  asin: string
  productId: string | null
  title: string | null
  imageUrl: string | null
  productType: string | null
  /** 亚马逊给出的状态原文（例如 DISCOVERABLE）；数组为空表示既不可售也不可被发现。 */
  statuses: string[]
  statusSince: string
  inactiveDays: number
  syncedAt: string
}

export interface ListingRestrictionRow {
  runId: string
  storeId: string
  storeName: string
  asin: string
  conditionType: string
  restricted: boolean
  reasons: Array<{ code: string; label: string; message: string; links: Array<{ title: string; url: string }> }>
  checkedAt: string
  expiresAt: string
}

export interface ListingLifecycleStats {
  range: { from: string; to: string; days: number; defaulted: boolean }
  /** 范围内首次出现的问题数 / 范围内解决的问题数 / 当前未解决且标为处理中 / 当前未解决合计。 */
  newCount: number
  resolvedCount: number
  inProgressCount: number
  openCount: number
  openErrors: number
  openWarnings: number
  /** 当前未解决且影响销售的问题数（影响不是“无影响”）。 */
  openImpactCount: number
  avgResolveHours: number | null
  /** 平均解决时长只读取最近解决的这么多条，超过时标 true。 */
  resolveSampleTruncated: boolean
}

export interface ListingSourceView {
  key: string
  label: string
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
}

/** 写入通道的状态：服务端按 权限 → 卖家连接 → 写入开关 判断，页面据此禁用按钮并写明卡在哪一步。 */
export interface ListingWriteStatus {
  allowed: boolean
  step: 'PERMISSION' | 'CONNECTION' | 'SWITCH' | null
  reason: string | null
  remedyPath: string | null
}

export interface ListingWriteStatuses {
  /** 校验预览与刊登限制查询：只读，要权限和卖家连接。 */
  validate: ListingWriteStatus
  /** 修改刊登：再加 sw.listing.update 开关。 */
  update: ListingWriteStatus
  /** 批量任务：再加 sw.feeds.batch 开关。 */
  batch: ListingWriteStatus
}

export interface ListingQualityResponse {
  tab: ListingQualityTab
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  issueRows: ListingIssueRow[]
  changeRows: ListingChangeRow[]
  inactiveRows: ListingInactiveRow[]
  restrictionRows: ListingRestrictionRow[]
  pageInfo: CursorPageInfo
  /** 各页签当前的条数（问题类按“未解决”计）；刊登限制是未过期的查询结果数。 */
  counts: Record<ListingQualityTab, number>
  stats: ListingLifecycleStats
  sources: ListingSourceView[]
  freshness: InventoryFreshness
  basis: readonly string[]
  write: ListingWriteStatuses
  /** 范围内的店铺（批量任务与刊登限制查询选店铺用）。 */
  stores: Array<{ id: string; name: string }>
}

export const LISTING_QUALITY_BASIS: readonly string[] = [
  '问题项来自刊登接口每日同步：每次同步里仍存在的问题保持原状，消失的问题记为“已解决”（解决时间是同步发现的时间，不是亚马逊修复的时间），再次出现会重新计为新增。',
  '“处理中”只表示本系统已为该商品提交过修复（修改刊登或批量任务）；亚马逊侧是否已生效以下一次同步为准。',
  '“被搜索抑制”来自被搜索抑制报告与刊登接口里执法动作为搜索抑制的问题；“属性缺失”是类别为缺少必填属性的问题。',
  '“非活跃”按刊登接口的状态判断：不可购买（没有 BUYABLE 状态）即非活跃，可能是缺货、被抑制或已手动停用，状态自变化日起累计天数。',
  '“他人内容修改”按每日同步的标题与主图比对：与上次不同且最近没有本系统的成功写入时，记为“非本系统修改”，无法区分是亚马逊、他人还是其他工具；推送接收端未接入时没有实时记录。',
  '影响估算只比较问题存续期与此前同长度时段的日均销售额，没有排除季节、促销、广告与库存变化，仅供参考。',
]
