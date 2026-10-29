import type { AwdInboundOrder, PrismaClient } from '@prisma/client'
import { NonRetryableError, type StepContext, type WriteRunIntent } from '@nova/workflow'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 上游仓储订单写入流程（P2a-08）：调用亚马逊前先确认开关；创建沿用已有订单编号；更新以亚马逊当前订单为底并要求草稿状态；
// 确认与取消靠重新读订单对账；回写按动作落状态；永久失败后订单不再“处理中”、只有真正调用亚马逊的失败计入开关。

const amazon = vi.hoisted(() => ({
  createOrder: vi.fn(),
  updateOrder: vi.fn(),
  confirmOrder: vi.fn(),
  cancelOrder: vi.fn(),
  updateTransport: vi.fn(),
  getOrder: vi.fn(),
}))
vi.mock('../connectors/awd-api', () => ({
  AwdApi: vi.fn(function () {
    return amazon
  }),
}))
vi.mock('../connectors/amazon-sp-api', () => ({ AmazonSpApiClient: vi.fn() }))
vi.mock('@nova/tenancy', () => ({ runWithTenant: (_tenantId: string, fn: () => unknown) => fn() }))
const outcome = vi.hoisted(() => ({ recordSwitchOutcome: vi.fn(async () => ({ autoClosed: [] })) }))
vi.mock('../platform/switch-outcome', () => outcome)

import { markAwdWriteFailed } from '../connectors/awd-dispatch'
import { createAwdWorkflow, resolveOrderPayload } from './awd-workflow'

beforeEach(() => {
  for (const fn of Object.values(amazon)) fn.mockReset()
})

const address = { name: 'Our Warehouse', addressLine1: '9 Origin St', stateOrRegion: 'CA', countryCode: 'US' }
const pack = {
  type: 'CASE',
  count: 2,
  measurements: { weight: { value: 10, unit: 'POUNDS' }, dimensions: { length: 20, width: 15, height: 10, unit: 'INCHES' } },
  products: [{ sku: 'SKU-A', quantity: 12 }],
}
const baseRow = {
  id: 'row-1',
  tenantId: 't1',
  sellerAccountId: 'sa1',
  orderId: null,
  externalReferenceId: 'REF-1',
  status: 'LOCAL_DRAFT',
  pendingAction: 'CREATE',
  originAddressJson: address,
  packagesJson: [pack],
  preferredRegion: 'us-east',
  draftJson: null,
} as unknown as AwdInboundOrder

function setup(row: Partial<AwdInboundOrder> = {}, options: { switchOn?: boolean; shipment?: unknown } = {}) {
  const current = { ...baseRow, ...row }
  const update = vi.fn(async () => current)
  const prisma = {
    awdInboundOrder: { findFirst: vi.fn(async () => current), update },
    awdInboundShipment: { findFirst: vi.fn(async () => options.shipment ?? null) },
    integrationSwitch: { findFirst: vi.fn(async () => (options.switchOn === false ? null : { id: 's1' })) },
    platformConnection: { findFirst: vi.fn(async () => ({ id: 'c1' })) },
  } as unknown as PrismaClient
  const definition = createAwdWorkflow({ prisma, guardFor: vi.fn(), secrets: {} as never })
  const ctx = (action: WriteRunIntent['awdAction'], responses: unknown[] = []) =>
    ({
      tenantId: 't1',
      intent: { tenantId: 't1', connectionId: 'c1', awdOrderId: 'row-1', awdAction: action },
      request: {},
      responseOf: (seq: number) => responses[seq],
    }) as unknown as StepContext<WriteRunIntent>
  return { definition, ctx, update, steps: definition.steps }
}

describe('订单内容的解析', () => {
  it('编辑中的改动优先于订单现有字段；缺地址或包装、缺尺寸都判不可重试', () => {
    const payload = resolveOrderPayload({ ...baseRow, draftJson: { pending: { preferredRegion: 'us-west' } } } as unknown as AwdInboundOrder)
    expect(payload.region).toBe('us-west')
    expect(payload.packages).toHaveLength(1)
    expect(() => resolveOrderPayload({ ...baseRow, originAddressJson: null } as unknown as AwdInboundOrder)).toThrow(/发货地址/)
    const noDims = { ...pack, measurements: { weight: pack.measurements.weight } }
    expect(() => resolveOrderPayload({ ...baseRow, packagesJson: [noDims] } as unknown as AwdInboundOrder)).toThrow(NonRetryableError)
  })
})

describe('流程：调用亚马逊', () => {
  it('写入开关已关闭：不向亚马逊发任何请求，永久失败', async () => {
    const { steps, ctx } = setup({}, { switchOn: false })
    await expect(steps[0].run(ctx('CREATE'))).rejects.toMatchObject({ code: 'SWITCH_DISABLED' })
    expect(amazon.createOrder).not.toHaveBeenCalled()
  })

  it('创建：请求体是官方格式，外部引用编号沿用本地编号；已经有订单编号时不重复创建', async () => {
    amazon.createOrder.mockResolvedValueOnce({ orderId: 'ORD-9' })
    const { steps, ctx } = setup()
    expect(await steps[0].run(ctx('CREATE'))).toEqual({ orderId: 'ORD-9' })
    const body = amazon.createOrder.mock.calls[0][0]
    expect(body).toMatchObject({ externalReferenceId: 'REF-1', originAddress: address, preferences: { destinationRegion: 'us-east' } })
    expect(body.packagesToInbound[0]).toMatchObject({ count: 2, distributionPackage: { type: 'CASE' } })
    amazon.createOrder.mockClear()
    const again = setup({ orderId: 'ORD-OLD' })
    expect(await again.steps[0].run(again.ctx('CREATE'))).toEqual({ orderId: 'ORD-OLD' })
    expect(amazon.createOrder).not.toHaveBeenCalled()
  })

  it('更新：以亚马逊当前订单为底整体覆盖（PUT）；订单已不是草稿则拒绝', async () => {
    amazon.getOrder.mockResolvedValueOnce({ orderId: 'ORD-1', orderStatus: 'DRAFT', createdAt: 'T0', packagesToInbound: [], originAddress: {} })
    const { steps, ctx } = setup({ orderId: 'ORD-1', pendingAction: 'UPDATE' })
    await steps[0].run(ctx('UPDATE'))
    expect(amazon.updateOrder).toHaveBeenCalledWith('ORD-1', expect.objectContaining({ orderId: 'ORD-1', orderStatus: 'DRAFT', createdAt: 'T0', originAddress: address }))
    amazon.getOrder.mockResolvedValueOnce({ orderId: 'ORD-1', orderStatus: 'CONFIRMED' })
    await expect(steps[0].run(ctx('UPDATE'))).rejects.toMatchObject({ code: 'AWD_ORDER_NOT_DRAFT' })
  })

  it('确认与取消调用对应接口；还没有提交到亚马逊的订单不能确认', async () => {
    const confirm = setup({ orderId: 'ORD-1', pendingAction: 'CONFIRM' })
    await confirm.steps[0].run(confirm.ctx('CONFIRM'))
    expect(amazon.confirmOrder).toHaveBeenCalledWith('ORD-1')
    const cancel = setup({ orderId: 'ORD-1', pendingAction: 'CANCEL' })
    await cancel.steps[0].run(cancel.ctx('CANCEL'))
    expect(amazon.cancelOrder).toHaveBeenCalledWith('ORD-1')
    const unsent = setup()
    await expect(unsent.steps[0].run(unsent.ctx('CONFIRM'))).rejects.toMatchObject({ code: 'AWD_ORDER_NOT_SUBMITTED' })
  })

  it('运输信息：填到订单对应的货件上；还没有货件时说明原因，不发请求', async () => {
    const transport = { pending: { transport: { carrierCode: 'ABCD', bookingId: 'BK-1' } } }
    const ok = setup({ orderId: 'ORD-1', pendingAction: 'TRANSPORT', draftJson: transport } as never, { shipment: { shipmentId: 'SHIP-1' } })
    await ok.steps[0].run(ok.ctx('TRANSPORT'))
    expect(amazon.updateTransport).toHaveBeenCalledWith('SHIP-1', { bookingId: 'BK-1', carrierCode: 'ABCD' })
    amazon.updateTransport.mockClear()
    const none = setup({ orderId: 'ORD-1', pendingAction: 'TRANSPORT', draftJson: transport } as never)
    await expect(none.steps[0].run(none.ctx('TRANSPORT'))).rejects.toMatchObject({ code: 'AWD_SHIPMENT_NOT_FOUND' })
    expect(amazon.updateTransport).not.toHaveBeenCalled()
  })

  it('对账：确认看订单是否已确认、取消看是否已取消；创建与更新不对账（创建只认已回写的订单编号）', async () => {
    const { steps, ctx } = setup({ orderId: 'ORD-1' })
    amazon.getOrder.mockResolvedValueOnce({ orderStatus: 'CONFIRMED' })
    expect(await steps[0].reconcile!(ctx('CONFIRM'))).toMatchObject({ found: true })
    amazon.getOrder.mockResolvedValueOnce({ orderStatus: 'DRAFT' })
    expect(await steps[0].reconcile!(ctx('CONFIRM'))).toEqual({ found: false })
    amazon.getOrder.mockResolvedValueOnce({ orderStatus: 'CANCELLED' })
    expect(await steps[0].reconcile!(ctx('CANCEL'))).toMatchObject({ found: true })
    expect(await steps[0].reconcile!(ctx('UPDATE'))).toEqual({ found: false })
    expect(await steps[0].reconcile!(ctx('CREATE'))).toMatchObject({ found: true, response: { orderId: 'ORD-1' } })
    const fresh = setup()
    expect(await fresh.steps[0].reconcile!(fresh.ctx('CREATE'))).toEqual({ found: false })
  })
})

describe('流程：回写', () => {
  it('创建：落订单编号与草稿状态并清掉在途标记；草稿来源信息（补货批次）保留，等待提交的编辑内容清掉', async () => {
    const plain = setup({ draftJson: { source: 'REPLENISHMENT', batchId: 'b1', pending: { preferredRegion: 'us-west' } } } as never)
    expect(await plain.steps[1].run(plain.ctx('CREATE', [{ orderId: 'ORD-9' }]))).toEqual({ orderId: 'ORD-9' })
    expect((plain.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({
      orderId: 'ORD-9',
      status: 'DRAFT',
      pendingAction: null,
      lastErrorCode: null,
      draftJson: { source: 'REPLENISHMENT', batchId: 'b1' },
    })
  })
  it('确认与取消落目标状态；更新把编辑内容写进订单字段并清掉草稿改动', async () => {
    const confirm = setup({ orderId: 'ORD-1' })
    await confirm.steps[1].run(confirm.ctx('CONFIRM', [{ orderId: 'ORD-1' }]))
    expect((confirm.update.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toMatchObject({ status: 'CONFIRMED', pendingAction: null })
    const cancel = setup({ orderId: 'ORD-1' })
    await cancel.steps[1].run(cancel.ctx('CANCEL', [{ orderId: 'ORD-1' }]))
    expect((cancel.update.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toMatchObject({ status: 'CANCELLED', pendingAction: null })
    const edit = setup({ orderId: 'ORD-1', draftJson: { pending: { preferredRegion: 'us-west' } } } as never)
    await edit.steps[1].run(edit.ctx('UPDATE', [{ orderId: 'ORD-1' }]))
    expect((edit.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data).toMatchObject({ preferredRegion: 'us-west', pendingAction: null })
  })
})

describe('永久失败的处置', () => {
  const failing = (row: Record<string, unknown>) => {
    const update = vi.fn(async () => ({}))
    const db = { awdInboundOrder: { findFirst: vi.fn(async () => row), update } } as unknown as PrismaClient
    return { db, update }
  }

  it('还没创建成功的订单标为“提交失败”；调用亚马逊的失败计入开关，授权失效立即关闭；开关关闭与内容不完整不计入', async () => {
    outcome.recordSwitchOutcome.mockClear()
    const created = failing({ id: 'row-1', orderId: null })
    await markAwdWriteFailed(created.db, 't1', { syncJobId: 'j1', requestId: 'r', awdOrderId: 'row-1' }, 'SP_API_403_x')
    expect((created.update.mock.calls[0] as unknown as [{ data: unknown }])[0].data).toMatchObject({ status: 'CREATE_FAILED', pendingAction: null, lastErrorCode: 'SP_API_403' })
    expect(outcome.recordSwitchOutcome).toHaveBeenCalledWith(created.db, 't1', 'sw.awd.order.write', expect.objectContaining({ success: false, authInvalid: true }))
    outcome.recordSwitchOutcome.mockClear()
    await markAwdWriteFailed(created.db, 't1', { syncJobId: 'j1', requestId: 'r', awdOrderId: 'row-1' }, 'SWITCH_DISABLED')
    await markAwdWriteFailed(created.db, 't1', { syncJobId: 'j1', requestId: 'r', awdOrderId: 'row-1' }, 'AWD_ORDER_INCOMPLETE')
    expect(outcome.recordSwitchOutcome).not.toHaveBeenCalled()
  })

  it('已在亚马逊的订单失败时保持原状态，只清掉在途标记并记下原因（不含亚马逊返回的原文）', async () => {
    const existing = failing({ id: 'row-1', orderId: 'ORD-1' })
    await markAwdWriteFailed(existing.db, 't1', { syncJobId: 'j1', requestId: 'r', awdOrderId: 'row-1' }, 'SP_API_400_{"errors":[{"message":"bad"}]}')
    const data = (existing.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data
    expect(data.status).toBeUndefined()
    expect(data.pendingAction).toBeNull()
    expect(String(data.lastErrorMessage)).not.toContain('bad')
  })
})
