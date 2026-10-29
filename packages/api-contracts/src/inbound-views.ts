import type { InboundAction, InboundActionState, InboundBoxInput, InboundOp, InboundOpStatus, InboundStage, PlacementEstimate, ShippingMode } from './inbound.js'
import type { InboundFlowStepView } from './inbound-flow.js'
import type { LabelPrintStat } from './label-template.js'
import type { ClaimWindow, NoncomplianceItem, OpportunityItem, ReceivingExtra } from './receiving.js'

// 入仓计划的响应类型与纯函数（P2a-12）：分仓方案总成本与推荐、箱内物品校验与批量导入解析。

export interface InboundWriteStatus {
  allowed: boolean
  step: 'PERMISSION' | 'CONNECTION' | 'SWITCH' | null
  reason: string | null
  remedyPath: string | null
}
export interface InboundPlanRow {
  id: string
  name: string
  sellerAccountId: string
  storeName: string
  externalPlanId: string | null
  stage: InboundStage
  stageLabel: string
  pendingOp: InboundOp | null
  totalUnits: number
  skuCount: number
  shipmentCount: number
  sourceType: string
  createdAt: string
  updatedAt: string
  version: number
  lastErrorMessage: string | null
  /** 最近的截止时间（分仓方案过期或作废窗口）；没有为 null。 */
  nextDeadline: { kind: 'PLACEMENT_EXPIRES' | 'PACKING_EXPIRES' | 'VOID_WINDOW'; at: string } | null
}
export interface InboundException {
  kind: 'EXPIRING' | 'OP_FAILED' | 'DISCREPANCY'
  planId: string
  planName: string
  message: string
  at: string | null
}
export interface InboundPlanListResponse {
  items: InboundPlanRow[]
  page: number
  pageSize: number
  total: number
  board: Array<{ stage: InboundStage; label: string; count: number }>
  exceptions: InboundException[]
  write: InboundWriteStatus
  freshness: { status: string; statusLabel: string; lastSuccessAt: string | null; errorMessage: string | null } | null
}
export interface InboundStepView {
  stage: InboundStage
  label: string
  state: 'DONE' | 'CURRENT' | 'TODO'
}
export interface InboundItemView {
  sku: string
  fnsku: string | null
  asin: string | null
  productName: string | null
  quantity: number
  expiry: string | null
  /** 预处理与贴标固定为卖家处理。 */
  prepInstruction: string | null
  eligibility: { eligible: boolean; reasonCodes: string[]; checkedAt: string } | null
}
export interface InboundOverview {
  plan: InboundPlanRow
  address: Record<string, unknown> | null
  /** 五步流程（选品、装箱、分仓、运输、标签与发货）：每步的状态与可做的按钮（含不能做的原因），P6-10。 */
  steps: InboundFlowStepView[]
  /** 计划阶段链（草稿 → … → 已完结）：给“时间线”与阶段对照用。 */
  stageChain: InboundStepView[]
  nextAction: { action: InboundAction | null; text: string }
  actions: Record<InboundAction, InboundActionState>
  deadlines: { placementExpiresAt: string | null; packingExpiresAt: string | null; voidWindow: { deadline: string | null; remainingMs: number | null; expired: boolean; known: boolean } }
  items: InboundItemView[]
  eligibilitySummary: { checked: number; ineligible: number; unchecked: number }
  costs: InboundCostsView
  write: Record<string, InboundWriteStatus>
  cancelNote: string
}
export interface InboundCostsView {
  currency: string
  packingFee: number | null
  placementFee: number | null
  placementDiscount: number | null
  transportCost: number | null
  prepCost: number | null
  labelCost: number | null
  estimate: PlacementEstimate | null
  /** 已知部分合计；任何一项没有数据时只合计已知项，页面同时列出缺哪些。 */
  knownTotal: number | null
  missing: string[]
}
export interface PackingOptionView {
  packingOptionId: string
  status: string
  fees: number | null
  discounts: number | null
  currency: string
  expiresAt: string | null
  confirmed: boolean
  shippingConfigs: string[]
  groups: Array<{ packingGroupId: string; items: Array<{ sku: string; quantity: number }> }>
}
export interface PlacementShipmentView {
  shipmentId: string
  destinationFc: string | null
  units: number | null
}
export interface PlacementOptionView {
  placementOptionId: string
  status: string
  shipmentCount: number
  fees: number
  discounts: number
  currency: string
  expiresAt: string | null
  confirmed: boolean
  shipments: PlacementShipmentView[]
  cost: PlacementCostBreakdown
  recommended: boolean
  cheapestFee: boolean
}
export interface TransportOptionView {
  shipmentId: string
  transportOptionId: string
  carrier: string | null
  mode: string | null
  modeLabel: string | null
  solution: string | null
  cost: number | null
  currency: string
  eta: unknown
  preconditions: string[]
  voidableUntil: string | null
  expiresAt: string | null
  status: string
  confirmed: boolean
}
export interface DeliveryWindowView {
  shipmentId: string
  deliveryWindowOptionId: string
  windowStart: string
  windowEnd: string
  availabilityType: string | null
  availabilityExpiresAt: string | null
  confirmed: boolean
}
export interface InboundOptionsResponse {
  packing: PackingOptionView[]
  placement: PlacementOptionView[]
  recommendation: { placementOptionId: string | null; basis: 'FULL' | 'PARTIAL' | 'NONE'; missing: string[]; note: string }
  transport: TransportOptionView[]
  windows: DeliveryWindowView[]
  shipments: Array<{ shipmentId: string; destinationFc: string | null; shippingMode: ShippingMode | null }>
  estimate: PlacementEstimate | null
  /** 估算里的预计总重量（磅），来自已提交的箱内物品；没有箱子为 null。 */
  totalWeightLb: number | null
}
export interface InboundBoxView {
  boxId: string
  packingGroupId: string | null
  quantity: number
  weightLb: number
  lengthIn: number
  widthIn: number
  heightIn: number
  items: Array<{ sku: string; quantity: number }>
  labelStatus: string
}
export interface InboundBoxesResponse {
  boxes: InboundBoxView[]
  validation: BoxValidation
  groups: Array<{ packingGroupId: string; items: Array<{ sku: string; quantity: number }> }>
}
export interface InboundShipmentView {
  id: string
  shipmentId: string
  shipmentConfirmationId: string | null
  destinationFc: string | null
  status: string
  boxCount: number | null
  units: number
  /** 申报数量：亚马逊分仓方案里这个货件的预计件数（P6-26）；没有为 null。已发数量是 units，签收数量是 receivedUnits。 */
  declaredUnits?: number | null
  receivedUnits: number | null
  discrepancyUnits: number | null
  carrier: string | null
  trackingNumber: string | null
  shippingMode: ShippingMode | null
  receivedFirstAt: string | null
  receivedDoneAt: string | null
  items: Array<{ sku: string; fnsku: string | null; shippedQty: number; receivedQty: number | null; discrepancyQty: number | null }>
}
export interface InboundShipmentListRow extends InboundShipmentView {
  planId: string
  planName: string
  planStage: InboundStage
  /** 接收与差异页的补充列（P2a-13）。 */
  receiving: ReceivingExtra
}
export interface InboundShipmentListResponse {
  items: InboundShipmentListRow[]
  page: number
  pageSize: number
  total: number
  freshness: InboundPlanListResponse['freshness']
}
export interface InboundDiscrepancyRow {
  sku: string
  fnsku: string | null
  shippedQty: number
  receivedQty: number | null
  discrepancyQty: number | null
  /** SHORT 少收、OVER 多收、MATCH 一致、PENDING 货件还没有关闭或没有接收数据。 */
  state: 'SHORT' | 'OVER' | 'MATCH' | 'PENDING'
  /** 差异原因：亚马逊的接收接口不给原因，只有同一 SKU 在不合规报告里有记录时才有；没有为 null。 */
  reason: string | null
}
export interface InboundDiscrepancyResponse {
  shipmentId: string
  closed: boolean
  rows: InboundDiscrepancyRow[]
  /** 不合规问题：NOT_CONNECTED 表示不合规报告还没有同步成功过（显示“尚未接入”）；OK 且没有记录显示“尚无记录”。 */
  compliance: { state: 'OK' | 'NOT_CONNECTED'; items: NoncomplianceItem[]; note: string }
  /** 赔付任务（赔付机会）：货件没关闭不判断（NOT_JUDGED）；window 是入仓差异的等待期与申请期限。 */
  claims: { state: 'OK' | 'NOT_JUDGED'; items: OpportunityItem[]; window: ClaimWindow | null; note: string }
  note: string
}
export interface InboundTimelineEvent {
  at: string
  kind: 'PLAN' | 'TRANSPORT' | 'SHIPPED' | 'RECEIVING' | 'TRACKING' | 'OPERATION'
  title: string
  /** OBSERVED：我方同步时看到的时间，不是亚马逊发生的时间；EXACT：亚马逊或承运商给出的时间；LOCAL：我方操作时间。 */
  precision: 'OBSERVED' | 'EXACT' | 'LOCAL'
  detail: string | null
}
export interface InboundShipmentTimelineResponse {
  shipmentId: string
  events: InboundTimelineEvent[]
  note: string
}
export interface InboundOperationView {
  id: string
  operation: InboundOp
  operationLabel: string
  amazonOperationId: string | null
  status: InboundOpStatus
  statusLabel: string
  problems: Array<{ code: string | null; message: string; severity: string | null }>
  errorCode: string | null
  requestedBy: string
  startedAt: string
  finishedAt: string | null
}
export interface InboundLabelView {
  id: string
  kind: 'BOX' | 'ITEM'
  shipmentId: string | null
  status: string
  statusLabel: string
  pageType: string | null
  errorMessage: string | null
  createdAt: string
  url: string | null
}
/** 标签页签：亚马逊箱标签任务、本地生成（自定义箱标签、商品标签）的次数统计。 */
export interface InboundLabelsResponse {
  labels: InboundLabelView[]
  note: string
  printStats: LabelPrintStat[]
}
export interface InboundActionResponse {
  plan: InboundPlanRow
  state: 'QUEUED' | 'SAVED'
  jobId: string | null
  operationId: string | null
}

// ---- 分仓方案总成本 ----

export interface PlacementCostBreakdown {
  fees: number
  discounts: number
  /** 预估运费；没有填写估算参数为 null（不是 0）。 */
  freight: number | null
  /** 到仓时效差带来的断货风险成本；没有参数或缺某个运营中心的到仓天数为 null。 */
  stockout: number | null
  total: number
  missing: string[]
}
const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * 分仓方案总成本 = 分仓费 − 折扣 + 预估运费 + 断货风险成本（06 章 6.11）。
 * 运费 = 每磅单价 × 本方案分到的重量（按各货件件数占比摊总重量）+ 每货件固定费用 × 货件数；
 * 断货风险 = 每日断货损失 × Σ（该货件所在运营中心比“最快运营中心”多出的到仓天数 × 该货件件数占比）。
 * 参数没填的项不计入也不当 0：返回 null 并列在 missing 里，推荐时据此说明依据不完整。
 */
export function placementTotalCost(
  option: { fees: number; discounts: number; shipments: PlacementShipmentView[] },
  context: { totalWeightLb: number | null; params: PlacementEstimate | null },
): PlacementCostBreakdown {
  const params = context.params ?? {}
  const missing: string[] = []
  const totalUnits = option.shipments.reduce((sum, shipment) => sum + (shipment.units ?? 0), 0)
  const unitsKnown = option.shipments.length > 0 && option.shipments.every(shipment => shipment.units !== null)
  let freight: number | null = null
  const perLb = params.freightPerLb ?? null
  const perShipment = params.freightPerShipment ?? null
  if (perLb === null && perShipment === null) missing.push('预估运费（未填写运费估算参数）')
  else if (perLb !== null && (context.totalWeightLb === null || !unitsKnown || totalUnits === 0)) missing.push('预估运费（缺少箱子重量或货件件数）')
  else freight = round2((perLb !== null ? perLb * (context.totalWeightLb ?? 0) : 0) + (perShipment !== null ? perShipment * option.shipments.length : 0))
  let stockout: number | null = null
  const days = params.transitDaysByFc ?? {}
  const daily = params.dailyStockoutCost ?? null
  const fcValues = Object.values(days)
  if (daily === null || fcValues.length === 0) missing.push('断货风险成本（未填写每日断货损失与各运营中心到仓天数）')
  else {
    const unknownFc = option.shipments.filter(shipment => !shipment.destinationFc || days[shipment.destinationFc] === undefined).map(shipment => shipment.destinationFc ?? '未知')
    if (unknownFc.length > 0 || !unitsKnown || totalUnits === 0) missing.push(`断货风险成本（缺少 ${[...new Set(unknownFc)].join('、') || '货件件数'} 的到仓天数）`)
    else {
      const fastest = Math.min(...fcValues)
      stockout = round2(daily * option.shipments.reduce((sum, shipment) => sum + (days[shipment.destinationFc as string] - fastest) * ((shipment.units as number) / totalUnits), 0))
    }
  }
  return { fees: option.fees, discounts: option.discounts, freight, stockout, total: round2(option.fees - option.discounts + (freight ?? 0) + (stockout ?? 0)), missing }
}

/** 按总成本最低推荐：只在“未过期的可选方案”里选；并列时货件少的优先。依据不完整时明说。 */
export function recommendPlacement(
  options: Array<{ placementOptionId: string; status: string; expiresAt: string | null; shipmentCount: number; cost: PlacementCostBreakdown }>,
  now: Date = new Date(),
): InboundOptionsResponse['recommendation'] {
  const live = options.filter(option => option.status === 'OFFERED' && (!option.expiresAt || new Date(option.expiresAt).getTime() > now.getTime()))
  if (live.length === 0) return { placementOptionId: null, basis: 'NONE', missing: [], note: '没有可选的分仓方案（尚未生成，或已过期）' }
  const best = [...live].sort((a, b) => a.cost.total - b.cost.total || a.shipmentCount - b.shipmentCount)[0]
  const missing = [...new Set(live.flatMap(option => option.cost.missing))]
  return {
    placementOptionId: best.placementOptionId,
    basis: missing.length === 0 ? 'FULL' : 'PARTIAL',
    missing,
    note: missing.length === 0 ? '按总成本（分仓费 − 折扣 + 预估运费 + 断货风险成本）最低推荐' : `依据不完整，目前只按已知成本推荐：${missing.join('；')}`,
  }
}

// ---- 箱内物品校验与批量导入 ----

export interface BoxValidation {
  ok: boolean
  rows: Array<{ sku: string; planned: number; packed: number; diff: number }>
  unknownSkus: string[]
  problems: string[]
}
/** 校验箱内物品：每个 SKU 的装箱总数必须等于计划数量；没有的 SKU 不能装；有多个装箱组时每箱必须指明装箱组，且每组数量与组内商品一致。 */
export function validateBoxes(
  planItems: Array<{ sku: string; quantity: number }>,
  boxes: Array<Pick<InboundBoxInput, 'quantity' | 'items'> & { packingGroupId?: string | null; boxId?: string }>,
  groups: Array<{ packingGroupId: string; items: Array<{ sku: string; quantity: number }> }> = [],
): BoxValidation {
  const problems: string[] = []
  const packed = new Map<string, number>()
  const known = new Set(planItems.map(item => item.sku))
  const unknown = new Set<string>()
  const byGroup = new Map<string, Map<string, number>>()
  boxes.forEach((box, index) => {
    const label = box.boxId ?? `第 ${index + 1} 箱`
    if (groups.length > 1 && !box.packingGroupId) problems.push(`${label} 没有指定装箱组`)
    if (box.packingGroupId && groups.length > 0 && !groups.some(group => group.packingGroupId === box.packingGroupId)) problems.push(`${label} 的装箱组不存在`)
    for (const item of box.items) {
      if (!known.has(item.sku)) unknown.add(item.sku)
      packed.set(item.sku, (packed.get(item.sku) ?? 0) + item.quantity * box.quantity)
      const group = box.packingGroupId ?? (groups.length === 1 ? groups[0].packingGroupId : null)
      if (group) {
        const inner = byGroup.get(group) ?? new Map<string, number>()
        inner.set(item.sku, (inner.get(item.sku) ?? 0) + item.quantity * box.quantity)
        byGroup.set(group, inner)
      }
    }
  })
  const rows = planItems.map(item => ({ sku: item.sku, planned: item.quantity, packed: packed.get(item.sku) ?? 0, diff: (packed.get(item.sku) ?? 0) - item.quantity }))
  for (const row of rows) if (row.diff !== 0) problems.push(`${row.sku} 计划 ${row.planned} 件，已装箱 ${row.packed} 件（${row.diff > 0 ? '多' : '少'} ${Math.abs(row.diff)} 件）`)
  for (const sku of unknown) problems.push(`${sku} 不在这个计划里，不能装箱`)
  for (const group of groups) {
    const inner = byGroup.get(group.packingGroupId) ?? new Map<string, number>()
    for (const item of group.items)
      if ((inner.get(item.sku) ?? 0) !== item.quantity) problems.push(`装箱组 ${group.packingGroupId} 的 ${item.sku} 应装 ${item.quantity} 件，现装 ${inner.get(item.sku) ?? 0} 件`)
  }
  return { ok: problems.length === 0 && boxes.length > 0, rows, unknownSkus: [...unknown], problems }
}
