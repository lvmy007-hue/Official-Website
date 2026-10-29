import { LISTING_MARKETPLACE_ID } from './listing-quality.js'

// 刊登修复的写入契约（P4-10，05 章 5.4 动作）：修改刊登（先校验预览再提交）、批量刊登任务（Feeds API）、刊登限制按需查询。
// 只有常量、类型与纯函数，没有 zod（请求校验在 listing-quality-query.ts）。亚马逊的调用都在后台任务里，接口只“受理”并立刻返回任务记录。
// 价格、库存、配送类属性不能在这里改（价格归定价工作包与它自己的开关）。

export const LISTING_WRITE_JOB = 'LISTING_WRITE'
export const LISTING_UPDATE_SWITCH = 'sw.listing.update'
export const LISTING_BATCH_SWITCH = 'sw.feeds.batch'
export const LISTING_SUBMITTED_ACTIONS = {
  VALIDATE: 'LISTING_VALIDATE_REQUESTED',
  PATCH: 'LISTING_PATCH_SUBMITTED',
  BATCH: 'LISTING_BATCH_SUBMITTED',
  RESTRICTIONS: 'LISTING_RESTRICTIONS_REQUESTED',
} as const

export const LISTING_RUN_KINDS = ['VALIDATE', 'PATCH', 'BATCH', 'RESTRICTIONS'] as const
export type ListingRunKind = (typeof LISTING_RUN_KINDS)[number]
export const LISTING_RUN_KIND_LABEL: Record<ListingRunKind, string> = { VALIDATE: '校验预览', PATCH: '修改刊登', BATCH: '批量刊登任务', RESTRICTIONS: '刊登限制查询' }

export const LISTING_RUN_STATUSES = ['PENDING', 'RUNNING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'PARTIAL', 'FAILED'] as const
export type ListingRunStatus = (typeof LISTING_RUN_STATUSES)[number]
export const LISTING_RUN_STATUS_LABEL: Record<ListingRunStatus, string> = {
  PENDING: '排队中',
  RUNNING: '执行中',
  SUBMITTED: '已提交亚马逊',
  PROCESSING: '亚马逊处理中',
  SUCCEEDED: '已完成',
  PARTIAL: '部分成功',
  FAILED: '失败',
}
export const LISTING_RUN_FINAL: readonly ListingRunStatus[] = ['SUCCEEDED', 'PARTIAL', 'FAILED']
export const listingRunFinished = (status: string): boolean => (LISTING_RUN_FINAL as readonly string[]).includes(status)

export const LISTING_WRITE_LIMITS = {
  patchesMax: 10,
  valuesMax: 10,
  valueMax: 2000,
  attributeMax: 64,
  skuMax: 40,
  batchItemsMax: 200,
  previewTtlMs: 30 * 60 * 1000,
  restrictionsAsinsMax: 20,
  /** 批量任务结果的轮询：每 30 秒一次（任务运行时的固定间隔），最多 240 次，合计约 2 小时，之后以 FEED_TIMEOUT 结束（亚马逊那边可能仍在处理）。 */
  feedPollMax: 240,
  runListMax: 50,
  runRowsMax: 200,
  resultTextMax: 500,
} as const

/** 不允许在“修改刊登”里改的属性：价格、库存与配送属于各自的工作包与开关。 */
export const LISTING_BLOCKED_ATTRIBUTES: readonly string[] = [
  'purchasable_offer',
  'list_price',
  'uvp_list_price',
  'minimum_seller_allowed_price',
  'maximum_seller_allowed_price',
  'fulfillment_availability',
  'merchant_shipping_group',
]

export interface ListingPatchInput {
  op: 'replace' | 'delete'
  /** 亚马逊刊登属性名（小写字母、数字与下划线，例如 item_name、bullet_point）。 */
  attribute: string
  /** replace 时的取值（多值属性按顺序全部列出，会整体替换）；delete 时不填。 */
  values?: string[]
  languageTag?: string
}

const ATTRIBUTE = /^[a-z][a-z0-9_]*$/

/** 单个修改项的问题（没有问题返回 null）：前后端共用，提交前后端都会校验。 */
export function listingPatchIssue(patch: ListingPatchInput): string | null {
  if (!patch.attribute || patch.attribute.length > LISTING_WRITE_LIMITS.attributeMax || !ATTRIBUTE.test(patch.attribute)) return '属性名只能是小写字母、数字与下划线，并以字母开头'
  if (LISTING_BLOCKED_ATTRIBUTES.includes(patch.attribute)) return `属性「${patch.attribute}」属于价格、库存或配送，不能在这里修改`
  if (patch.op === 'delete') return patch.values && patch.values.length > 0 ? '删除属性时不能带取值' : null
  const values = patch.values ?? []
  if (values.length === 0 || values.length > LISTING_WRITE_LIMITS.valuesMax) return `取值要填 1 到 ${LISTING_WRITE_LIMITS.valuesMax} 个`
  if (values.some(value => value.trim() === '' || value.length > LISTING_WRITE_LIMITS.valueMax)) return `每个取值不能为空，也不能超过 ${LISTING_WRITE_LIMITS.valueMax} 个字符`
  return null
}

/** 一组修改项的问题：每项先查，再查同一属性是否重复。 */
export function listingPatchesIssue(patches: readonly ListingPatchInput[]): string | null {
  if (patches.length === 0 || patches.length > LISTING_WRITE_LIMITS.patchesMax) return `修改项要填 1 到 ${LISTING_WRITE_LIMITS.patchesMax} 个`
  for (const [index, patch] of patches.entries()) {
    const issue = listingPatchIssue(patch)
    if (issue) return `第 ${index + 1} 项：${issue}`
  }
  const names = patches.map(patch => patch.attribute)
  const dup = names.find((name, index) => names.indexOf(name) !== index)
  return dup ? `属性「${dup}」重复出现，同一个属性只能改一次` : null
}

/** 亚马逊刊登接口的局部修改项（JSON Patch，路径 /attributes/<属性名>，取值按“值 + 站点 + 语言”的对象数组）。 */
export function listingAmazonPatches(patches: readonly ListingPatchInput[], marketplaceId: string = LISTING_MARKETPLACE_ID): Array<{ op: string; path: string; value?: unknown }> {
  return patches.map(patch => ({
    op: patch.op,
    path: `/attributes/${patch.attribute}`,
    ...(patch.op === 'delete' ? {} : { value: (patch.values ?? []).map(value => ({ value, marketplace_id: marketplaceId, language_tag: patch.languageTag || 'en_US' })) }),
  }))
}

/** 修改项的稳定文字（用于校验预览令牌：提交时的修改必须与校验过的完全一致）。 */
export function listingPatchesText(sku: string, productType: string, patches: readonly ListingPatchInput[]): string {
  return JSON.stringify({ sku, productType, patches: patches.map(patch => ({ op: patch.op, attribute: patch.attribute, values: patch.values ?? [], languageTag: patch.languageTag ?? '' })) })
}

export interface ListingBatchItem {
  sku: string
  patches: ListingPatchInput[]
}

/** 批量任务的输入文件（Feeds API，JSON_LISTINGS_FEED）：每个商品一条 PATCH 消息，消息编号从 1 起，用来对应处理结果。 */
export function buildListingsFeed(input: { sellerId: string; items: ReadonlyArray<ListingBatchItem & { productType: string }>; marketplaceId?: string }) {
  return {
    header: { sellerId: input.sellerId, version: '2.0', issueLocale: 'en_US' },
    messages: input.items.map((item, index) => ({
      messageId: index + 1,
      sku: item.sku,
      operationType: 'PATCH',
      productType: item.productType,
      patches: listingAmazonPatches(item.patches, input.marketplaceId),
    })),
  }
}

// ---- 失败码与响应 ----

export const LISTING_FAILURE_LABEL: Record<string, string> = {
  SWITCH_DISABLED: '写入开关在提交后被关闭，没有向亚马逊发出请求',
  QUEUE_UNAVAILABLE: '任务没能进入后台队列，请稍后重新提交',
  LISTING_REQUEST_REJECTED: '亚马逊拒绝了这次请求（请求格式或属性不被接受），请检查修改内容',
  LISTING_RUN_STALE: '提交时发现该商品已有别的未完成的修改，请稍后再试',
  FEED_FATAL: '亚马逊批量任务处理失败（整个文件被拒绝或取消）',
  FEED_TIMEOUT: '批量任务长时间没有处理完成，请稍后在亚马逊后台核对结果',
  LISTING_REQUEST_INVALID: '提交的内容不完整，没有向亚马逊发出请求',
  LISTING_RESPONSE_UNRECOGNIZED: '亚马逊的响应无法识别，请在亚马逊后台核对这次修改是否生效',
  LISTING_RUN_NOT_FOUND: '写入记录不存在',
  SELLER_ID_MISSING: '店铺没有亚马逊卖家编号，无法调用刊登接口',
  CONNECTION_NOT_FOUND: '店铺授权不存在，请重新授权',
  LISTING_ROLE_MISSING: '亚马逊商品刊登接口的角色尚未获批，请在亚马逊后台为应用授权“商品刊登”角色',
  SP_API_401: '亚马逊授权已失效，请重新授权',
  SP_API_403: '没有刊登接口的访问权限（缺少“商品刊登”角色），请在亚马逊后台为应用授权',
  SP_API_429: '亚马逊限流，稍后会自动重试',
  SP_API_500: '亚马逊服务暂时不可用',
}
export const listingFailureText = (code: string | null | undefined): string => (code ? (LISTING_FAILURE_LABEL[code] ?? '执行失败，请稍后重试或联系管理员') : '执行失败')

export interface ListingValidationIssue {
  code: string
  severity: string
  message: string
  attributeNames: string[]
}

export interface ListingBatchRowResult {
  sku: string
  ok: boolean
  issues: ListingValidationIssue[]
}

export interface ListingRunView {
  id: string
  kind: ListingRunKind
  kindLabel: string
  status: ListingRunStatus
  statusLabel: string
  storeId: string
  storeName: string
  sku: string | null
  productType: string | null
  /** 校验预览的结论：VALID / INVALID；没有（还没跑完或不是校验）为 null。 */
  validation: 'VALID' | 'INVALID' | null
  /** 提交修改所依据的校验预览编号。 */
  previewRunId: string | null
  itemCount: number
  issues: ListingValidationIssue[]
  rows: ListingBatchRowResult[]
  summary: { accepted: number; invalid: number } | null
  failureCode: string | null
  failureText: string | null
  requestedBy: string | null
  createdAt: string
  finishedAt: string | null
  /** 校验预览可用于提交的截止时间（只有校验通过的预览有）。 */
  usableUntil: string | null
}

export interface ListingRunListResponse {
  items: ListingRunView[]
  truncated: boolean
}

export interface ListingRunSubmitResponse {
  run: ListingRunView
  /** QUEUED 表示已进入后台队列（提交成功只代表已受理）；FAILED 表示没能入队，记录已标为失败，可以重新提交。 */
  state: 'QUEUED' | 'FAILED'
}
