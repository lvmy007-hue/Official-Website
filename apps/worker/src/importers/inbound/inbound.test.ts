import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FbaInboundPlan } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { InboundApi } from '../../connectors/inbound-api'
import type { ImportContext } from '../../types'
import {
  parseBoxIds,
  parseEligibility,
  parsePackingOptions,
  parsePlacementOptions,
  parsePlan,
  parseReceived,
  parseShipment,
  parseShipmentItems,
  parseTransportOptions,
  parseWindows,
  sumMoney,
} from './v2024-parse'
import { syncInboundPlans, syncOnePlan, transportVoidDeadline } from './v2024-sync'

// 入仓计划（I-06、I-07）：官方格式的响应样例（apps/worker/fixtures/inbound）→ 解析结果与写入的表；
// 没给的金额保持 null、币种不一致不合计；按阶段只拉当下需要的内容；亚马逊侧作废同步为已取消；接收差异只在货件关闭后产生。

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../fixtures/inbound', name), 'utf8')) as Record<string, unknown>
const NOW = new Date('2026-10-22T10:00:00Z')

describe('响应解析', () => {
  it('费用合计：币种一致才合计；没有费用行是 null；多个 {value:{amount,code}} 行相加', () => {
    expect(sumMoney([{ value: { amount: 1.1, code: 'USD' } }, { amount: 2.2, code: 'USD' }])).toEqual({ amount: 3.3, currency: 'USD' })
    expect(sumMoney([{ value: { amount: 1, code: 'USD' } }, { value: { amount: 1, code: 'CAD' } }])).toBeNull()
    expect(sumMoney([])).toBeNull()
    expect(sumMoney(undefined)).toBeNull()
  })

  it('计划：状态大写、货件编号去掉没有编号的行', () => {
    expect(parsePlan(fixture('plan.json'))).toEqual({ inboundPlanId: 'wf1a2b3c4-0000-4000-8000-000000000001', status: 'ACTIVE', shipmentIds: ['sh1-aaaa', 'sh2-bbbb'] })
    expect(parsePlan({}).status).toBe('UNKNOWN')
  })

  it('装箱方案：费用减折扣由读取侧算，这里只给各自的合计；币种混合的费用是 null；没有编号的行计入跳过', () => {
    const { options, skipped } = parsePackingOptions(fixture('packing-options.json'))
    expect(skipped).toBe(1)
    expect(options[0]).toMatchObject({ packingOptionId: 'po1', status: 'OFFERED', fees: 14.75, discounts: 1, currency: 'USD', groupIds: ['pg1', 'pg2'], configs: ['GROUND_SMALL_PARCEL'] })
    expect(options[0].expiresAt).toEqual(new Date('2026-10-27T08:00:00Z'))
    expect(options[1]).toMatchObject({ status: 'ACCEPTED', fees: null, discounts: null })
  })

  it('分仓方案：没有费用行就是 0（免费分仓是事实）；货件编号随方案', () => {
    const { options, skipped } = parsePlacementOptions(fixture('placement-options.json'))
    expect(skipped).toBe(1)
    expect(options[0]).toMatchObject({ placementOptionId: 'pl1', fees: 30, discounts: 0, shipmentIds: ['sh1-aaaa'] })
    expect(options[1]).toMatchObject({ status: 'ACCEPTED', fees: 0, shipmentIds: ['sh1-aaaa', 'sh2-bbbb'] })
  })

  it('货件：目的仓、确认号、已选运输方案与时间窗、第一个追踪号；明细跳过缺 SKU 的行，数量 0 保留', () => {
    expect(parseShipment(fixture('shipment.json'))).toMatchObject({
      shipmentId: 'sh1-aaaa',
      destinationFc: 'ONT8',
      confirmationId: 'FBA15ABCDEF',
      selectedTransportOptionId: 'tr1',
      selectedWindowId: 'dw1',
      trackingNumber: '1Z999',
    })
    expect(parseShipment({})).toBeNull()
    expect(parseShipmentItems(fixture('shipment-items.json'))).toEqual([
      { sku: 'SKU-A', fnsku: 'X00A', quantity: 120 },
      { sku: 'SKU-B', fnsku: 'X00B', quantity: 60 },
      { sku: 'SKU-C', fnsku: null, quantity: 0 },
    ])
    expect(parseBoxIds({ boxes: [{ boxId: 'b1' }, {}, { boxId: 'b2' }] })).toEqual(['b1', 'b2'])
  })

  it('运输方案：报价、承运商、运输方式归类、作废截止；缺货件编号的行丢弃；没有报价的费用是 null', () => {
    const rows = parseTransportOptions(fixture('transport-options.json'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ transportOptionId: 'tr1', carrier: 'UPS', shippingMode: 'SPD', cost: 88.4, solution: 'AMAZON_PARTNERED_CARRIER', preconditions: ['CONFIRMED_DELIVERY_WINDOW'] })
    expect(rows[0].voidableUntil).toEqual(new Date('2026-10-24T08:00:00Z'))
    expect(rows[1]).toMatchObject({ shippingMode: 'LTL', cost: null, carrier: 'XYZ', voidableUntil: null })
  })

  it('送达时间窗：日期不合法的行丢弃；接收数量缺失是 null（不当 0）；资格预检没有明确回答时是 null', () => {
    const windows = parseWindows(fixture('delivery-windows.json'))
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ optionId: 'dw1', availabilityType: 'AVAILABLE' })
    expect(parseReceived(fixture('received.json'))).toEqual([
      { sku: 'SKU-A', shipped: 120, received: 118 },
      { sku: 'SKU-B', shipped: 60, received: 60 },
      { sku: 'SKU-C', shipped: 10, received: null },
    ])
    expect(parseEligibility({ isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0004'] })).toEqual({ eligible: false, reasons: ['FBA_INB_0004'] })
    expect(parseEligibility({})).toEqual({ eligible: null, reasons: [] })
  })
})

// ---- 同步：用内存替身验证“读哪些、写哪些” ----

const model = () => ({
  upsert: vi.fn(async () => ({})),
  findMany: vi.fn(async () => [] as unknown[]),
  findUnique: vi.fn(async () => null as unknown),
  create: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  updateMany: vi.fn(async () => ({ count: 1 })),
})
function setup(plan: Partial<FbaInboundPlan>, responses: { shipment?: Record<string, Record<string, unknown>>; boxesError?: number; windowsError?: number } = {}) {
  const db = {
    fbaInboundPlan: model(),
    packingOption: model(),
    packingGroup: model(),
    placementOption: model(),
    fbaInboundShipment: model(),
    shipmentItem: model(),
    transportOption: model(),
    deliveryWindow: model(),
    receivingDiscrepancy: model(),
    reimbursementOpportunity: model(),
    costVersion: { findFirst: vi.fn(async () => null as unknown) },
    tenantSetting: { findFirst: vi.fn(async () => null as unknown) },
  }
  const api = {
    getPlan: vi.fn(async () => fixture('plan.json')),
    listPackingOptions: vi.fn(async () => fixture('packing-options.json')),
    listPackingGroupItems: vi.fn(async () => ({ items: [{ msku: 'SKU-A', quantity: 10 }] })),
    listPlacementOptions: vi.fn(async () => fixture('placement-options.json')),
    getShipment: vi.fn(async (_plan: string, id: string) => responses.shipment?.[id] ?? (id === 'sh1-aaaa' ? fixture('shipment.json') : { shipmentId: id, status: 'WORKING' })),
    listShipmentItems: vi.fn(async () => fixture('shipment-items.json')),
    listShipmentBoxes: vi.fn(async () => {
      if (responses.boxesError) throw new UpstreamHttpError(`SP_API_${responses.boxesError}`, responses.boxesError, undefined, 'api')
      return { boxes: [{ boxId: 'box-1' }] }
    }),
    listTransportOptions: vi.fn(async () => fixture('transport-options.json')),
    listWindows: vi.fn(async () => {
      if (responses.windowsError) throw new UpstreamHttpError(`SP_API_${responses.windowsError}`, responses.windowsError, undefined, 'api')
      return fixture('delivery-windows.json')
    }),
    receivedItems: vi.fn(async () => fixture('received.json')),
  }
  const full = { id: 'p1', tenantId: 't1', sellerAccountId: 'sa1', externalPlanId: 'wf1', stage: 'CREATED', pendingOp: null, shippedAt: null, ...plan } as FbaInboundPlan
  const ctx = { prisma: db, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as ImportContext
  return { db, api: api as unknown as InboundApi, raw: api, ctx, plan: full }
}
const dataOf = (fn: { mock: { calls: unknown[][] } }, index = 0) => (fn.mock.calls[index][0] as { data: Record<string, unknown> }).data

describe('同步：按阶段拉取', () => {
  it('刚创建：只拉装箱方案与装箱组商品；不拉分仓、货件、运输；已接受的方案记为选中', async () => {
    const { db, api, raw, ctx, plan } = setup({ stage: 'CREATED' })
    await syncOnePlan(ctx, api, plan, NOW)
    expect(raw.listPackingOptions).toHaveBeenCalledOnce()
    expect(raw.listPackingGroupItems).toHaveBeenCalledTimes(3) // 装箱组按“方案 + 组”各取一次：po1 的 pg1、pg2，po2 的 pg1
    expect(raw.listPlacementOptions).not.toHaveBeenCalled()
    expect(raw.getShipment).not.toHaveBeenCalled()
    expect(db.packingOption.upsert).toHaveBeenCalledTimes(2)
    const upsert = db.packingOption.upsert.mock.calls[1][0] as unknown as { create: Record<string, unknown> }
    expect(upsert.create).toMatchObject({ packingOptionId: 'po2', confirmed: true, fees: null })
    expect(dataOf(db.fbaInboundPlan.update)).toMatchObject({ selectedPackingOptionId: 'po2', status: 'ACTIVE' })
  })

  it('分仓确认后：读已接受方案的货件、明细与箱子编号；运输方案与时间窗只在此阶段拉；箱子 4xx 当作还没有', async () => {
    const { db, api, raw, ctx, plan } = setup({ stage: 'PLACEMENT_CONFIRMED' }, { boxesError: 404 })
    await syncOnePlan(ctx, api, plan, NOW)
    expect(raw.listPackingOptions).not.toHaveBeenCalled()
    expect(raw.listTransportOptions).toHaveBeenCalledOnce()
    expect(raw.listWindows).toHaveBeenCalledTimes(2)
    expect(db.fbaInboundShipment.upsert).toHaveBeenCalledTimes(2)
    const shipment = db.fbaInboundShipment.upsert.mock.calls[0][0] as unknown as { create: Record<string, unknown> }
    expect(shipment.create).toMatchObject({ shipmentId: 'sh1-aaaa', destinationFc: 'ONT8', unitsExpected: 180, shipmentConfirmationId: 'FBA15ABCDEF' })
    expect(db.shipmentItem.upsert).toHaveBeenCalledTimes(6)
    const transport = db.transportOption.upsert.mock.calls[0][0] as unknown as { create: Record<string, unknown> }
    expect(transport.create).toMatchObject({ transportOptionId: 'tr1', confirmed: true, cost: 88.4 })
    expect(db.deliveryWindow.upsert.mock.calls[0][0]).toMatchObject({ create: { confirmed: true } })
    expect(dataOf(db.fbaInboundPlan.update)).toMatchObject({ selectedPlacementOptionId: 'pl2', shipmentCount: 2 })
  })

  it('时间窗 5xx 是同步失败，4xx 不是；箱子编号 5xx 同样抛出', async () => {
    const bad = setup({ stage: 'PLACEMENT_CONFIRMED' }, { windowsError: 500 })
    await expect(syncOnePlan(bad.ctx, bad.api, bad.plan, NOW)).rejects.toThrow(/SP_API_500/)
    const ignored = setup({ stage: 'PLACEMENT_CONFIRMED' }, { windowsError: 400 })
    await expect(syncOnePlan(ignored.ctx, ignored.api, ignored.plan, NOW)).resolves.toBeGreaterThan(0)
    const boxes = setup({ stage: 'PLACEMENT_CONFIRMED' }, { boxesError: 503 })
    await expect(syncOnePlan(boxes.ctx, boxes.api, boxes.plan, NOW)).rejects.toThrow(/SP_API_503/)
  })

  it('亚马逊侧计划作废：我方改为已取消；但有操作在途时不改（等操作结果回写）', async () => {
    const voided = setup({ stage: 'TRANSPORT_CONFIRMED' })
    voided.raw.getPlan.mockResolvedValueOnce({ inboundPlanId: 'wf1', status: 'VOIDED' })
    await syncOnePlan(voided.ctx, voided.api, voided.plan, NOW)
    expect(dataOf(voided.db.fbaInboundPlan.update)).toMatchObject({ stage: 'CANCELLED', status: 'VOIDED' })
    const busy = setup({ stage: 'TRANSPORT_CONFIRMED', pendingOp: 'CANCEL_PLAN' })
    busy.raw.getPlan.mockResolvedValueOnce({ inboundPlanId: 'wf1', status: 'VOIDED' })
    await syncOnePlan(busy.ctx, busy.api, busy.plan, NOW)
    expect(dataOf(busy.db.fbaInboundPlan.update)).not.toHaveProperty('stage', 'CANCELLED')
  })
})

describe('同步：接收与差异', () => {
  const closed = { 'sh1-aaaa': { ...fixture('shipment.json'), status: 'CLOSED' }, 'sh2-bbbb': { shipmentId: 'sh2-bbbb', status: 'CLOSED' } }

  it('货件还在接收：记接收数量与第一次看到到货的时间；差异为空（关闭之前不判差异）；计划进入接收中', async () => {
    const { db, api, ctx, plan } = setup({ stage: 'TRANSPORT_CONFIRMED' }, { shipment: { 'sh1-aaaa': { ...fixture('shipment.json'), status: 'RECEIVING' } } })
    await syncOnePlan(ctx, api, plan, NOW)
    const update = dataOf(db.fbaInboundShipment.update)
    expect(update).toMatchObject({ unitsReceived: 178, discrepancyQuantity: 0, receivedFirstAt: NOW })
    expect(update).not.toHaveProperty('receivedDoneAt')
    expect(db.shipmentItem.updateMany.mock.calls[0][0]).toMatchObject({ data: { receivedQty: 118, discrepancyQty: null } })
    expect(dataOf(db.fbaInboundPlan.update)).toMatchObject({ stage: 'RECEIVING', shippedAt: NOW })
  })

  it('全部关闭且有少收：差异处理中；缺接收数量的 SKU 不计差异；全部收齐则完结', async () => {
    const { db, api, ctx, plan } = setup({ stage: 'RECEIVING' }, { shipment: closed })
    await syncOnePlan(ctx, api, plan, NOW)
    expect(dataOf(db.fbaInboundShipment.update)).toMatchObject({ unitsReceived: 178, discrepancyQuantity: 2, receivedDoneAt: NOW })
    expect(db.shipmentItem.updateMany.mock.calls[0][0]).toMatchObject({ data: { receivedQty: 118, discrepancyQty: 2 } })
    expect(dataOf(db.fbaInboundPlan.update)).toMatchObject({ stage: 'DISCREPANCY' })
    const even = setup({ stage: 'RECEIVING' }, { shipment: closed })
    even.raw.receivedItems.mockResolvedValue({ payload: { ItemData: [{ SellerSKU: 'SKU-A', QuantityShipped: 120, QuantityReceived: 120 }] } })
    await syncOnePlan(even.ctx, even.api, even.plan, NOW)
    expect(dataOf(even.db.fbaInboundPlan.update)).toMatchObject({ stage: 'COMPLETED' })
  })

  it('关闭的货件落接收差异；还在接收的不落；落差异出错不拖垮计划同步', async () => {
    const done = setup({ stage: 'RECEIVING' }, { shipment: closed })
    done.db.fbaInboundShipment.findUnique.mockResolvedValue({ id: 'row1', receivedFirstAt: null, receivedDoneAt: new Date('2026-08-01T00:00:00Z') })
    await syncOnePlan(done.ctx, done.api, done.plan, NOW)
    const rows = done.db.receivingDiscrepancy.upsert.mock.calls.map(call => (call[0] as unknown as { create: Record<string, unknown> }).create)
    expect(rows[0]).toMatchObject({ kind: 'SHORT', qty: 2, source: 'RECEIPT', planId: 'p1' })
    expect(done.db.reimbursementOpportunity.upsert).toHaveBeenCalled() // 关闭已久，过了等待期
    const receiving = setup({ stage: 'TRANSPORT_CONFIRMED' }, { shipment: { 'sh1-aaaa': { ...fixture('shipment.json'), status: 'RECEIVING' } } })
    receiving.db.fbaInboundShipment.findUnique.mockResolvedValue({ id: 'row1', receivedFirstAt: null, receivedDoneAt: null })
    await syncOnePlan(receiving.ctx, receiving.api, receiving.plan, NOW)
    expect(receiving.db.receivingDiscrepancy.upsert).not.toHaveBeenCalled()
    const broken = setup({ stage: 'RECEIVING' }, { shipment: closed })
    broken.db.fbaInboundShipment.findUnique.mockResolvedValue({ id: 'row1', receivedFirstAt: null, receivedDoneAt: null })
    broken.db.receivingDiscrepancy.findMany.mockRejectedValue(new Error('db down'))
    await expect(syncOnePlan(broken.ctx, broken.api, broken.plan, NOW)).resolves.toBeGreaterThan(0)
    expect(dataOf(broken.db.fbaInboundPlan.update)).toMatchObject({ stage: 'DISCREPANCY' })
  })

  it('有操作在途时不推进阶段；还没到货不进接收中', async () => {
    const busy = setup({ stage: 'TRANSPORT_CONFIRMED', pendingOp: 'UPDATE_TRACKING' }, { shipment: closed })
    await syncOnePlan(busy.ctx, busy.api, busy.plan, NOW)
    expect(dataOf(busy.db.fbaInboundPlan.update)).not.toHaveProperty('stage')
    const waiting = setup({ stage: 'TRANSPORT_CONFIRMED' })
    await syncOnePlan(waiting.ctx, waiting.api, waiting.plan, NOW)
    expect(dataOf(waiting.db.fbaInboundPlan.update)).not.toHaveProperty('stage')
    expect(waiting.raw.receivedItems).not.toHaveBeenCalled() // 货件状态是 WORKING：不查接收
  })
})

describe('批量同步与作废截止', () => {
  it('只同步进行中的阶段；单个计划失败不影响其他，全部失败才算失败；指定计划时错误直接抛出', async () => {
    const { db, api, raw, ctx } = setup({})
    db.fbaInboundPlan.findMany.mockResolvedValueOnce([
      { id: 'p1', tenantId: 't1', externalPlanId: 'a', stage: 'CREATED', pendingOp: null },
      { id: 'p2', tenantId: 't1', externalPlanId: 'b', stage: 'CREATED', pendingOp: null },
    ])
    raw.getPlan.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(fixture('plan.json'))
    const result = await syncInboundPlans(ctx, api, { tenantId: 't1', sellerAccountId: 'sa1' }, { now: NOW })
    expect(result).toMatchObject({ plans: 2, failed: 1 })
    const where = (db.fbaInboundPlan.findMany.mock.calls[0] as unknown as [{ where: { stage: { in: string[] } } }])[0].where
    expect(where.stage.in).toContain('RECEIVING')
    expect(where.stage.in).not.toContain('DRAFT')
    expect(where.stage.in).not.toContain('CANCELLED')
    db.fbaInboundPlan.findMany.mockResolvedValueOnce([{ id: 'p1', tenantId: 't1', externalPlanId: 'a', stage: 'CREATED', pendingOp: null }])
    raw.getPlan.mockRejectedValueOnce(new Error('all down'))
    await expect(syncInboundPlans(ctx, api, { tenantId: 't1', sellerAccountId: 'sa1' }, { now: NOW })).rejects.toThrow('all down')
  })

  it('作废截止：取已确认方案报价里的截止时间（多个取最早）；没有就按运输方式的窗口时长（小包裹 24 小时、零担 1 小时）', async () => {
    const db = { transportOption: model() }
    const ctx = { prisma: db } as unknown as ImportContext
    db.transportOption.findMany.mockResolvedValueOnce([
      { mode: 'GROUND_SMALL_PARCEL', voidableUntil: new Date('2026-10-23T05:00:00Z') },
      { mode: 'GROUND_SMALL_PARCEL', voidableUntil: new Date('2026-10-23T02:00:00Z') },
    ])
    expect(await transportVoidDeadline(ctx, 'p1', NOW)).toEqual({ shippingMode: 'SPD', deadline: new Date('2026-10-23T02:00:00Z') })
    db.transportOption.findMany.mockResolvedValueOnce([{ mode: 'FREIGHT_LTL', voidableUntil: null }])
    expect(await transportVoidDeadline(ctx, 'p1', NOW)).toEqual({ shippingMode: 'LTL', deadline: new Date('2026-10-22T11:00:00Z') })
    db.transportOption.findMany.mockResolvedValueOnce([{ mode: 'GROUND_SMALL_PARCEL', voidableUntil: null }])
    expect((await transportVoidDeadline(ctx, 'p1', NOW)).deadline).toEqual(new Date('2026-10-23T10:00:00Z'))
    db.transportOption.findMany.mockResolvedValueOnce([])
    expect(await transportVoidDeadline(ctx, 'p1', NOW)).toEqual({ shippingMode: null, deadline: null })
  })
})
