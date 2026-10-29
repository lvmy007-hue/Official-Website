import { afterEach, describe, expect, it, vi } from 'vitest'
import { ObjectStorageService } from '../../platform/storage'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const READ = ['awd.read']
const WRITE = ['awd.read', 'awd.order.write']
const day = (date: string) => new Date(`${date}T00:00:00Z`)
const stamp = new Date('2026-10-22T08:00:00Z')

const ADDRESS = { name: '深圳仓', addressLine1: '1 Road', stateOrRegion: 'GD', countryCode: 'CN' }
const caseOf = (over: Record<string, unknown> = {}) => ({
  type: 'CASE',
  count: 10,
  measurements: { weight: { value: 5, unit: 'KILOGRAMS' }, dimensions: { length: 40, width: 30, height: 20, unit: 'CENTIMETERS' } },
  products: [{ sku: 'SKU-1', quantity: 24 }],
  ...over,
})

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  orderId: null,
  externalReferenceId: 'NOVA-AAAA',
  status: 'LOCAL_DRAFT',
  pendingAction: null,
  expectedUnits: 240,
  receivedUnits: null,
  packageDeliveryMode: 'CASE',
  originAddressJson: ADDRESS,
  packagesJson: [caseOf()],
  preferredRegion: null,
  destinationRegion: null,
  draftJson: null,
  note: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  version: 1,
  createdBy: 'user-1',
  amazonCreatedAt: null,
  amazonUpdatedAt: null,
  sourceUpdatedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  ...over,
})

const shipmentRow = (over: Record<string, unknown> = {}) => ({
  id: 'sh1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  shipmentId: 'SHIP-1',
  orderId: 'AWD-ORDER-1',
  status: 'IN_TRANSIT',
  carrier: 'UPSN',
  trackingNumber: '1Z999',
  destinationRegion: 'WEST',
  shipBy: null,
  labelStatus: null,
  labelObjectKey: null,
  amazonCreatedAt: stamp,
  amazonUpdatedAt: stamp,
  sourceUpdatedAt: stamp,
  createdAt: stamp,
  ...over,
})

const inventoryRow = (over: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  sku: 'SKU-1',
  snapshotDate: day('2026-10-22'),
  onhandQty: 500,
  availableQty: 480,
  reservedForReplenishment: null,
  inboundToAwdQty: 0,
  outboundToFbaInTransit: 20,
  expiryDate: null,
  expirationJson: [],
  ...over,
})

/** 写入通道全部通畅的替身：已授权连接、开关已开；各用例按需覆盖。 */
function stubs(permissions: string[], over: Record<string, any> = {}) {
  return prismaFor(permissions, {
    platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', sellerAccountId: 's1', healthChecks: [], lastErrorCode: null }) },
    integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: true, autoDisabledReason: null }) },
    sellerAccount: {
      findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺一' }]),
      findFirst: vi.fn().mockResolvedValue({ id: 's1', displayName: '店铺一' }),
    },
    awdInventory: {
      groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: day('2026-10-22') } }]),
      findMany: vi.fn().mockResolvedValue([inventoryRow()]),
      findFirst: vi.fn().mockResolvedValue(inventoryRow()),
      count: vi.fn().mockResolvedValue(1),
      aggregate: vi.fn().mockResolvedValue({ _sum: { onhandQty: 500, availableQty: 480, reservedForReplenishment: null, inboundToAwdQty: 0, outboundToFbaInTransit: 20 } }),
    },
    awdInboundOrder: {
      findFirst: vi.fn().mockResolvedValue(orderRow()),
      findMany: vi.fn().mockResolvedValue([orderRow()]),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => orderRow({ ...args.data, id: 'o-new' })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    awdInboundShipment: {
      findFirst: vi.fn().mockResolvedValue(shipmentRow()),
      findMany: vi.fn().mockResolvedValue([shipmentRow()]),
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn().mockResolvedValue({}),
    },
    awdShipmentItem: { findMany: vi.fn().mockResolvedValue([]) },
    syncJob: { create: vi.fn().mockResolvedValue({ id: 'job-1', type: 'AWD_ORDER_WRITE', priority: 5 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })
}

const createBody = (over: Record<string, unknown> = {}) => ({ sellerAccountId: 's1', originAddress: ADDRESS, packages: [caseOf()], ...over })

describe('AWD 接口：权限与范围', () => {
  it('没有 awd.read：读接口 403；没有 awd.order.write：写接口 403，且不产生任何写入', async () => {
    const prisma = stubs([])
    harness = await createTestApp(prisma)
    for (const path of ['/awd/inventory', '/awd/orders', '/awd/orders/o1', '/awd/shipments', '/awd/shipments/sh1/labels']) expect((await harness.call('GET', path)).status, path).toBe(403)
    expect((await harness.call('POST', '/awd/orders', { body: createBody() })).status).toBe(403)
    expect((await harness.call('POST', '/awd/shipments/sh1/labels')).status).toBe(403)
    expect(prisma.awdInboundOrder.create).not.toHaveBeenCalled()
    expect(prisma.syncJob.create).not.toHaveBeenCalled()
  })

  it('只读成员可以看，但不能创建、修改、确认、取消', async () => {
    harness = await createTestApp(stubs(READ))
    expect((await harness.call('GET', '/awd/orders')).status).toBe(200)
    expect((await harness.call('POST', '/awd/orders', { body: createBody() })).status).toBe(403)
    expect((await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1, note: 'x' } })).status).toBe(403)
    expect((await harness.call('POST', '/awd/orders/o1/confirm', { body: { version: 1 } })).status).toBe(403)
    expect((await harness.call('POST', '/awd/orders/o1/cancel', { body: { version: 1, reason: '不再需要' } })).status).toBe(403)
  })

  it('订单不属于当前企业（查不到）时返回 404，查询条件带企业编号', async () => {
    const prisma = stubs(WRITE, { awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/awd/orders/other')).status).toBe(404)
    expect((await harness.call('POST', '/awd/orders/other/confirm', { body: { version: 1 } })).status).toBe(404)
    expect(prisma.awdInboundOrder.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'other', tenantId: 'tenant-1' })
  })
})

describe('AWD 接口：读取', () => {
  it('库存：每店取最近一次快照；没有数字的列保持为空，不补 0', async () => {
    harness = await createTestApp(stubs(READ))
    const res = await harness.call('GET', '/awd/inventory')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.state).toBe('OK')
    expect(data.snapshotDate).toBe('2026-10-22')
    expect(data.items[0]).toMatchObject({ sku: 'SKU-1', onhandQty: 500, reservedForReplenishment: null, outboundToFbaInTransit: 20 })
    expect(data.totals.reservedForReplenishment).toBeNull()
  })

  it('库存：从未同步时说明“尚未同步”，而不是显示空表加 0', async () => {
    harness = await createTestApp(stubs(READ, { awdInventory: { groupBy: vi.fn().mockResolvedValue([]) } }))
    const data = (await harness.call('GET', '/awd/inventory')).json.data
    expect(data.state).toBe('NOT_CONNECTED')
    expect(data.items).toEqual([])
    expect(data.totals.onhandQty).toBeNull()
  })

  it('订单列表：写入开关关闭时给出被拦截的环节与原因', async () => {
    harness = await createTestApp(stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }))
    const data = (await harness.call('GET', '/awd/orders')).json.data
    expect(data.items[0]).toMatchObject({ id: 'o1', status: 'LOCAL_DRAFT', statusLabel: expect.any(String) })
    expect(data.write).toMatchObject({ allowed: false, step: 'SWITCH' })
    expect(data.write.reason).toContain('开关')
  })

  it('货件：明细单位不是“件”时不给出件数合计', async () => {
    const items = [{ sellerAccountId: 's1', shipmentId: 'SHIP-1', sku: 'SKU-1', expectedQty: 4, receivedQty: 0, unit: 'CASES', expiryDate: null, prepInfoJson: null }]
    harness = await createTestApp(stubs(READ, { awdShipmentItem: { findMany: vi.fn().mockResolvedValue(items) } }))
    const row = (await harness.call('GET', '/awd/shipments')).json.data.items[0]
    expect(row).toMatchObject({ shipmentId: 'SHIP-1', expectedUnits: null, receivedUnits: null })
  })

  it('货件：明细都是“件”时累加；任一明细没有接收数则接收合计为空', async () => {
    const base = { sellerAccountId: 's1', shipmentId: 'SHIP-1', unit: 'PRODUCT_UNITS', expiryDate: null, prepInfoJson: null }
    const items = [
      { ...base, sku: 'A', expectedQty: 100, receivedQty: 100 },
      { ...base, sku: 'B', expectedQty: 50, receivedQty: null },
    ]
    harness = await createTestApp(stubs(READ, { awdShipmentItem: { findMany: vi.fn().mockResolvedValue(items) } }))
    const row = (await harness.call('GET', '/awd/shipments')).json.data.items[0]
    expect(row).toMatchObject({ expectedUnits: 150, receivedUnits: null })
  })

  it('订单详情：带货件、可执行动作与时间线', async () => {
    const events = [{ action: 'AWD_ORDER_CREATED', result: 'SUCCESS', createdAt: stamp, reason: null }]
    harness = await createTestApp(stubs(WRITE, { auditEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue(events) } }))
    const data = (await harness.call('GET', '/awd/orders/o1')).json.data
    expect(data.actions).toEqual(['EDIT', 'SUBMIT', 'CANCEL'])
    expect(data.packages).toHaveLength(1)
    expect(data.timeline.length).toBeGreaterThan(0)
    expect(data.write.allowed).toBe(true)
  })

  it('库存详情的上游仓储页签：有快照时给出库存，没有时不显示 0', async () => {
    const prisma = stubs(['inventory.read', 'awd.read'])
    harness = await createTestApp(prisma)
    const data = (await harness.call('GET', '/inventory/inv-1/awd')).json.data
    expect(data.state).toBe('OK')
    expect(data.stock).toMatchObject({ onhandQty: 500, reservedForReplenishment: null })
    expect(prisma.awdInventory.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', sku: 'SKU-1' })
  })

  it('库存详情的上游仓储页签：没有 awd.read 时 403', async () => {
    harness = await createTestApp(stubs(['inventory.read']))
    expect((await harness.call('GET', '/inventory/inv-1/awd')).status).toBe(403)
  })
})

describe('AWD 接口：创建', () => {
  it('只保存本地草稿：不调用守卫、不建任务、不入队', async () => {
    const prisma = stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders', { body: createBody({ submit: false }) })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ state: 'SAVED', jobId: null })
    const data = prisma.awdInboundOrder.create.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: 'tenant-1', status: 'LOCAL_DRAFT', pendingAction: null, expectedUnits: 240, createdBy: 'user-1' })
    expect(data.externalReferenceId).toMatch(/^NOVA-[0-9A-F]{12}$/)
    expect(prisma.syncJob.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交亚马逊：开关没开返回 409 并说明环节，订单与任务都不产生', async () => {
    const prisma = stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders', { body: createBody() })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('WRITE_SWITCH_OFF')
    expect(prisma.awdInboundOrder.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交亚马逊：没有授权连接返回 409，不建订单', async () => {
    const prisma = stubs(WRITE, { platformConnection: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders', { body: createBody() })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('CONNECTION_UNAVAILABLE')
    expect(prisma.awdInboundOrder.create).not.toHaveBeenCalled()
  })

  it('提交亚马逊：通过后订单标为处理中，任务与订单同一事务，提交后才入队并登记流程', async () => {
    const prisma = stubs(WRITE)
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders', { body: createBody() })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ state: 'QUEUED', jobId: 'job-1' })
    expect(prisma.awdInboundOrder.create.mock.calls[0][0].data.pendingAction).toBe('CREATE')
    expect(prisma.syncJob.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', type: 'AWD_ORDER_WRITE', context: { awdOrderId: 'o-new', awdAction: 'CREATE' } })
    expect(harness.workflow.registerWriteRun).toHaveBeenCalledTimes(1)
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ awdOrderId: 'o-new', awdAction: 'CREATE' }), 'job-1', expect.objectContaining({ type: 'AWD_ORDER_WRITE' }))
  })

  it('校验：提交时缺地址、缺包装、缺长宽高都是 422，不碰数据库', async () => {
    const prisma = stubs(WRITE)
    harness = await createTestApp(prisma)
    const noDims = caseOf({ measurements: { weight: { value: 5, unit: 'KILOGRAMS' } } })
    for (const body of [createBody({ originAddress: undefined }), createBody({ packages: [] }), createBody({ packages: [noDims] }), createBody({ sellerAccountId: '' })]) {
      expect((await harness.call('POST', '/awd/orders', { body })).status).toBe(422)
    }
    expect(prisma.awdInboundOrder.create).not.toHaveBeenCalled()
  })

  it('校验：包装必须且只能装商品或箱，托盘外的包装不能装箱', async () => {
    harness = await createTestApp(stubs(WRITE))
    expect((await harness.call('POST', '/awd/orders', { body: createBody({ packages: [caseOf({ products: undefined })] }) })).status).toBe(422)
    expect((await harness.call('POST', '/awd/orders', { body: createBody({ packages: [caseOf({ packages: [caseOf()] })] }) })).status).toBe(422)
  })

  it('范围外的店铺：404 或 403，不创建', async () => {
    const prisma = stubs(WRITE, { sellerAccount: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/awd/orders', { body: createBody({ submit: false }) })).status).toBe(404)
    expect(prisma.awdInboundOrder.create).not.toHaveBeenCalled()
  })
})

describe('AWD 接口：修改、确认、取消', () => {
  it('确认：只有亚马逊草稿能确认；本地草稿 409', async () => {
    harness = await createTestApp(stubs(WRITE))
    const res = await harness.call('POST', '/awd/orders/o1/confirm', { body: { version: 1 } })
    expect(res.status).toBe(409)
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('确认：亚马逊草稿通过后标记处理中并入队', async () => {
    const draft = orderRow({ status: 'DRAFT', orderId: 'AWD-ORDER-1' })
    const prisma = stubs(WRITE, { awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(draft), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders/o1/confirm', { body: { version: 1 } })
    expect(res.status).toBe(201)
    expect(res.json.data.state).toBe('QUEUED')
    expect(prisma.awdInboundOrder.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'o1', tenantId: 'tenant-1', version: 1 }, data: { pendingAction: 'CONFIRM' } })
    expect(prisma.syncJob.create.mock.calls[0][0].data.context).toEqual({ awdOrderId: 'o1', awdAction: 'CONFIRM' })
    expect(harness.queue.add).toHaveBeenCalledTimes(1)
  })

  it('确认：版本已被他人推进返回 409 并带当前版本，不建任务', async () => {
    const draft = orderRow({ status: 'DRAFT', orderId: 'AWD-ORDER-1', version: 3 })
    const prisma = stubs(WRITE, { awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(draft), updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders/o1/confirm', { body: { version: 1 } })
    expect(res.status).toBe(409)
    expect(res.json.error.details).toMatchObject({ currentVersion: 3, expectedVersion: 1 })
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('有操作处理中时，任何动作都 409 并说明原因', async () => {
    const busy = orderRow({ status: 'DRAFT', orderId: 'AWD-ORDER-1', pendingAction: 'CONFIRM' })
    harness = await createTestApp(stubs(WRITE, { awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(busy) } }))
    const res = await harness.call('POST', '/awd/orders/o1/cancel', { body: { version: 1, reason: '重复下单' } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('正在处理')
  })

  it('取消本地草稿：只改本地，不要求开关，不入队', async () => {
    const prisma = stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/orders/o1/cancel', { body: { version: 1, reason: '不再需要' } })
    expect(res.status).toBe(201)
    expect(res.json.data.state).toBe('SAVED')
    expect(prisma.awdInboundOrder.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CANCELLED', pendingAction: null })
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('取消需要原因；取消亚马逊上的订单要过开关', async () => {
    const confirmed = orderRow({ status: 'CONFIRMED', orderId: 'AWD-ORDER-1' })
    const prisma = stubs(WRITE, {
      awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(confirmed), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/awd/orders/o1/cancel', { body: { version: 1 } })).status).toBe(422)
    expect((await harness.call('POST', '/awd/orders/o1/cancel', { body: { version: 1, reason: '不再需要' } })).status).toBe(409)
    expect(prisma.awdInboundOrder.updateMany).not.toHaveBeenCalled()
  })

  it('修改亚马逊草稿的包装：整体写入待提交内容并入队更新；只改备注不调用亚马逊', async () => {
    const draft = orderRow({ status: 'DRAFT', orderId: 'AWD-ORDER-1', draftJson: { source: 'REPLENISHMENT', batchId: 'b1' } })
    const prisma = stubs(WRITE, { awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(draft), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1, packages: [caseOf({ count: 20 })] } })
    expect(res.status).toBe(200)
    const data = prisma.awdInboundOrder.updateMany.mock.calls[0][0].data
    expect(data.pendingAction).toBe('UPDATE')
    expect(data.draftJson).toMatchObject({ source: 'REPLENISHMENT', batchId: 'b1', pending: { packages: [expect.objectContaining({ count: 20 })] } })
    expect(harness.queue.add).toHaveBeenCalledTimes(1)
    const note = await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1, note: '备注' } })
    expect(note.json.data.state).toBe('SAVED')
    expect(harness.queue.add).toHaveBeenCalledTimes(1)
  })

  it('修改：已确认的订单不能改包装；没有货件时也不能更新运输信息', async () => {
    const confirmed = orderRow({ status: 'CONFIRMED', orderId: 'AWD-ORDER-1' })
    const noShipment = { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) }
    harness = await createTestApp(
      stubs(WRITE, { awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(confirmed), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }, awdInboundShipment: noShipment }),
    )
    expect((await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1, packages: [caseOf()] } })).status).toBe(409)
    expect((await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1, transport: { bookingId: 'BK1' } } })).status).toBe(409)
  })

  it('修改：什么都没改 422', async () => {
    harness = await createTestApp(stubs(WRITE))
    expect((await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1 } })).status).toBe(422)
  })

  it('运输信息：已确认且有货件时才允许，写入待提交内容并入队', async () => {
    const confirmed = orderRow({ status: 'CONFIRMED', orderId: 'AWD-ORDER-1' })
    const prisma = stubs(WRITE, {
      awdInboundOrder: { findFirst: vi.fn().mockResolvedValue(confirmed), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      awdInboundShipment: { count: vi.fn().mockResolvedValue(1), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/awd/orders/o1', { body: { version: 1, transport: { carrierCode: 'upsn', bookingId: 'BK1' } } })
    expect(res.status).toBe(200)
    expect(prisma.awdInboundOrder.updateMany.mock.calls[0][0].data).toMatchObject({ pendingAction: 'TRANSPORT', draftJson: { pending: { transport: { carrierCode: 'UPSN', bookingId: 'BK1' } } } })
    expect(prisma.syncJob.create.mock.calls[0][0].data.context).toEqual({ awdOrderId: 'o1', awdAction: 'TRANSPORT' })
  })
})

describe('AWD 接口：标签', () => {
  it('还没有标签：不给链接，说明如何获取', async () => {
    harness = await createTestApp(stubs(READ))
    const data = (await harness.call('GET', '/awd/shipments/sh1/labels')).json.data
    expect(data).toMatchObject({ url: null, expiresAt: null, labelStatusLabel: expect.any(String) })
    expect(data.note).toContain('获取标签')
  })

  it('标签已生成：签发 5 分钟有效的下载链接，文件路径不返回给前端', async () => {
    const generated = shipmentRow({ labelStatus: 'GENERATED', labelObjectKey: 'tenants/tenant-1/awd-labels/SHIP-1.pdf' })
    harness = await createTestApp(stubs(READ, { awdInboundShipment: { findFirst: vi.fn().mockResolvedValue(generated) } }))
    const signDownload = vi.fn().mockResolvedValue({ url: 'https://files.example/x?sig=1', method: 'GET', headers: {}, expiresAt: new Date('2026-10-22T08:05:00Z') })
    vi.spyOn(harness.app.get(ObjectStorageService), 'forTenant').mockReturnValue({ signDownload } as never)
    const res = await harness.call('GET', '/awd/shipments/sh1/labels')
    expect(res.json.data).toMatchObject({ url: 'https://files.example/x?sig=1', note: null })
    expect(signDownload).toHaveBeenCalledWith('tenants/tenant-1/awd-labels/SHIP-1.pdf', 300)
    expect(JSON.stringify(res.json)).not.toContain('awd-labels/SHIP-1.pdf')
  })

  it('发起获取：只读调用不受写入开关限制，建任务并入队；已取消的货件 409', async () => {
    const prisma = stubs(READ, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) }, syncJob: { create: vi.fn().mockResolvedValue({ id: 'job-2', type: 'AWD_LABELS', priority: 5 }) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/awd/shipments/sh1/labels')
    expect(res.status).toBe(201)
    expect(res.json.data).toEqual({ state: 'QUEUED', jobId: 'job-2' })
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ awdShipmentId: 'SHIP-1' }), 'job-2', expect.objectContaining({ type: 'AWD_LABELS' }))
    expect(harness.workflow.registerWriteRun).not.toHaveBeenCalled()
    await harness.close()
    harness = await createTestApp(stubs(READ, { awdInboundShipment: { findFirst: vi.fn().mockResolvedValue(shipmentRow({ status: 'CANCELLED' })) } }))
    expect((await harness.call('POST', '/awd/shipments/sh1/labels')).status).toBe(409)
  })
})
