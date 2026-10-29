// 补货批次一键转入仓计划草稿的契约（P6-08，16 章第 5.2 节；freeze/api.md `/replenishment/batches/:id/to-inbound-drafts`、`/replenishment/intents`）。
// 本文件只放常量、标签、纯函数与响应类型，没有 zod；请求体与查询校验在 batch-inbound-query.ts。

export const BATCH_INBOUND_PERMISSION = 'replenishment.plan.create'
export const BATCH_INBOUND_READ = 'replenishment.read'
/** 一次最多转多少条建议（与决策、草稿接口的上限一致）。 */
export const TO_INBOUND_ITEMS_MAX = 200
/** 入仓计划名称上限（与手工新建计划一致）。 */
export const INBOUND_PLAN_NAME_MAX = 120

/** 转草稿时记在补货动作上的目标类型。 */
export const INBOUND_DRAFT_TARGET = 'INBOUND_PLAN'
export const INBOUND_DRAFT_SOURCE_TYPE = 'REPLENISHMENT_BATCH'

export interface ShipFromOption {
  id: string
  name: string
  /** 一行地址文字，给下拉选项与预览显示。 */
  summary: string
  isDefault: boolean
}

export interface InboundDraftItemPreview {
  recommendationId: string
  sku: string
  asin: string
  title: string | null
  /** 建议补货量（已按箱规取整）。 */
  recommendedQty: number
  /** 本次转成草稿的数量：默认等于建议量，调用方可以手改。 */
  quantity: number
  /** 数量是否被手改（与建议量不同）。 */
  edited: boolean
}

/** 一组 = 一个店铺 + 一个发货地址 = 一个草稿；没有地址的店铺单独成组，不能确认。 */
export interface InboundDraftGroup {
  key: string
  sellerAccountId: string
  storeName: string
  address: ShipFromOption | null
  /** 该店铺使用中的全部地址，预览里可以逐条改用别的地址。 */
  addressOptions: ShipFromOption[]
  items: InboundDraftItemPreview[]
  skuCount: number
  totalUnits: number
  /** 将要创建的草稿名称。 */
  planName: string
}

/** 已经转过草稿的建议：默认不重复生成，提示“已在草稿 X 中”。 */
export interface ConvertedRecommendation {
  recommendationId: string
  sku: string
  planId: string
  planName: string
  planStage: string
}

export interface ToInboundDraftsPreview {
  dryRun: true
  batchId: string
  batchNo: string
  groups: InboundDraftGroup[]
  converted: ConvertedRecommendation[]
  /** 能不能确认：有可生成的草稿、没有缺地址的组、没有已转过的建议。 */
  canConfirm: boolean
  /** 不能确认的原因，逐条写明。 */
  blockers: string[]
  /** 缺地址时给“去设置”的入口。 */
  remedy: { label: string; path: string } | null
}

export interface CreatedInboundDraft {
  planId: string
  name: string
  sellerAccountId: string
  storeName: string
  skuCount: number
  totalUnits: number
  shipFromAddressId: string
  shipFromAddressName: string
}

export interface ToInboundDraftsResult {
  dryRun: false
  batchId: string
  batchNo: string
  plans: CreatedInboundDraft[]
  /** 记到补货批次上的动作条数（每条建议一条）。 */
  actions: number
}

export type ToInboundDraftsResponse = ToInboundDraftsPreview | ToInboundDraftsResult

/** 以前只登记了“要生成入仓计划”的意向、没有生成单据的记录。 */
export interface InboundIntentRow {
  actionId: string
  batchId: string
  batchNo: string
  recommendationId: string
  sellerAccountId: string
  storeName: string
  sku: string
  asin: string
  title: string | null
  /** 登记时决定的数量；可能为空。 */
  qty: number | null
  registeredAt: string
}

export interface InboundIntentListResponse {
  items: InboundIntentRow[]
  page: number
  pageSize: number
  total: number
}

/** 批次详情“执行情况”里链接到的入仓计划草稿。 */
export interface BatchInboundPlanRef {
  id: string
  name: string
  stage: string
  stageLabel: string
  storeName: string
  skuCount: number
  totalUnits: number
  shipFromAddressName: string | null
}

/** 草稿名称：`补货批次 <批次号> · <店铺>`，同一店铺有多个地址时再带上地址名（超长截断）。 */
export function inboundDraftName(batchNo: string, storeName: string, addressName: string | null): string {
  const base = `补货批次 ${batchNo} · ${storeName}`
  const full = addressName ? `${base} · ${addressName}` : base
  return full.length <= INBOUND_PLAN_NAME_MAX ? full : `${full.slice(0, INBOUND_PLAN_NAME_MAX - 1)}…`
}
