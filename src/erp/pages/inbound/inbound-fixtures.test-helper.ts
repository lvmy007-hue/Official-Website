import {
  INBOUND_STAGES,
  INBOUND_STAGE_LABEL,
  INBOUND_STEP_CHAIN,
  INBOUND_SWITCH_KEYS,
  inboundFlowSteps,
  inboundPlanActions,
  inboundStageIndex,
  type InboundOptionsResponse,
  type InboundOverview,
  type InboundPlanListResponse,
  type InboundPlanRow,
  type InboundShipmentView,
  type InboundStage,
  type InboundWriteStatus,
} from '@nova/api-contracts'

// 入仓计划页面测试用的假数据；字段与服务端响应一致，动作可用性用契约里的同一份规则算出。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const allowed: InboundWriteStatus = { allowed: true, step: null, reason: null, remedyPath: null }
export const switchOff: InboundWriteStatus = { allowed: false, step: 'SWITCH', reason: '“入仓计划写入”开关还没有打开', remedyPath: '/app/switches' }

const FUTURE = () => new Date(Date.now() + 5 * 3_600_000).toISOString()
const PAST = () => new Date(Date.now() - 3_600_000).toISOString()
export const future = FUTURE
export const past = PAST

export const planRow = (over: Partial<InboundPlanRow> = {}): InboundPlanRow => ({
  id: 'p1',
  name: '10 月补货',
  sellerAccountId: 'st1',
  storeName: 'Northstar US',
  externalPlanId: null,
  stage: 'DRAFT',
  stageLabel: INBOUND_STAGE_LABEL.DRAFT,
  pendingOp: null,
  totalUnits: 15,
  skuCount: 2,
  shipmentCount: 0,
  sourceType: 'MANUAL',
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-22T08:00:00.000Z',
  version: 3,
  lastErrorMessage: null,
  nextDeadline: null,
  ...over,
})

export const planList = (items: InboundPlanRow[] = [planRow()], write: InboundWriteStatus = allowed, over: Partial<InboundPlanListResponse> = {}): InboundPlanListResponse => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  board: INBOUND_STAGES.map(stage => ({ stage, label: INBOUND_STAGE_LABEL[stage], count: items.filter(item => item.stage === stage).length })),
  exceptions: [],
  write,
  freshness: { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-22T08:00:00.000Z', errorMessage: null },
  ...over,
})

const writes = (state: InboundWriteStatus): Record<string, InboundWriteStatus> => Object.fromEntries([...INBOUND_SWITCH_KEYS.map(key => [key, state]), ['NONE', allowed]])

export const overview = (stage: InboundStage = 'DRAFT', over: Partial<InboundOverview> = {}, planOver: Partial<InboundPlanRow> = {}, state: InboundWriteStatus = allowed): InboundOverview => {
  const plan = planRow({ stage, stageLabel: INBOUND_STAGE_LABEL[stage], externalPlanId: stage === 'DRAFT' || stage === 'ELIGIBILITY' ? null : 'IP-1', ...planOver })
  const index = inboundStageIndex(stage)
  return {
    plan,
    address: { name: '深圳仓', addressLine1: '1 Road', city: 'Shenzhen', stateOrProvinceCode: 'GD', postalCode: '518000', countryCode: 'CN' },
    steps: inboundFlowSteps({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: over.deadlines?.voidWindow.deadline ?? null, lastErrorMessage: plan.lastErrorMessage }),
    stageChain: INBOUND_STEP_CHAIN.map((item, i) => ({ stage: item, label: INBOUND_STAGE_LABEL[item], state: i < index ? 'DONE' : i === index ? 'CURRENT' : 'TODO' })),
    nextAction: { action: null, text: '' },
    actions: inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: over.deadlines?.voidWindow.deadline ?? null }),
    deadlines: { placementExpiresAt: null, packingExpiresAt: null, voidWindow: { deadline: null, remainingMs: null, expired: false, known: false } },
    items: [
      { sku: 'SKU-A', fnsku: 'X00A', asin: 'B000000001', productName: '商品 A', quantity: 10, expiry: null, prepInstruction: null, eligibility: null },
      { sku: 'SKU-B', fnsku: null, asin: 'B000000002', productName: '商品 B', quantity: 5, expiry: null, prepInstruction: null, eligibility: null },
    ],
    eligibilitySummary: { checked: 0, ineligible: 0, unchecked: 2 },
    costs: {
      currency: 'USD',
      packingFee: null,
      placementFee: null,
      placementDiscount: null,
      transportCost: null,
      prepCost: null,
      labelCost: null,
      estimate: null,
      knownTotal: null,
      missing: ['分仓费', '运费'],
    },
    write: writes(state),
    cancelNote: '运输方案确认后，小包裹 24 小时、零担与整车 1 小时内可以取消；超过窗口不能取消。',
    ...over,
  }
}

export const shipmentView = (over: Partial<InboundShipmentView> = {}): InboundShipmentView => ({
  id: 'sh1',
  shipmentId: 'FBA-SH-1',
  shipmentConfirmationId: null,
  destinationFc: 'ONT8',
  status: 'WORKING',
  boxCount: 2,
  units: 15,
  receivedUnits: null,
  discrepancyUnits: null,
  carrier: null,
  trackingNumber: null,
  shippingMode: 'SPD',
  receivedFirstAt: null,
  receivedDoneAt: null,
  items: [],
  ...over,
})

const emptyCost = { fees: 0, discounts: 0, freight: null, stockout: null, total: 0, missing: [] as string[] }
export const options = (over: Partial<InboundOptionsResponse> = {}): InboundOptionsResponse => ({
  packing: [],
  placement: [],
  recommendation: { placementOptionId: null, basis: 'NONE', missing: [], note: '没有可选的分仓方案（尚未生成，或已过期）' },
  transport: [],
  windows: [],
  shipments: [{ shipmentId: 'FBA-SH-1', destinationFc: 'ONT8', shippingMode: 'SPD' }],
  estimate: null,
  totalWeightLb: null,
  ...over,
})

export const placementOption = (id: string, total: number, over: Record<string, unknown> = {}) => ({
  placementOptionId: id,
  status: 'OFFERED',
  shipmentCount: 2,
  fees: 20,
  discounts: 5,
  currency: 'USD',
  expiresAt: FUTURE(),
  confirmed: false,
  shipments: [{ shipmentId: 'FBA-SH-1', destinationFc: 'ONT8', units: 15 }],
  cost: { ...emptyCost, fees: 20, discounts: 5, total },
  recommended: false,
  cheapestFee: false,
  ...over,
})
