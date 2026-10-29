import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const READ = ['inbound.read']
const WRITE = ['inbound.read', 'inbound.plan.write']
const stamp = new Date('2026-10-22T08:00:00Z')

const planRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  marketplaceId: 'ATVPDKIKX0DER',
  name: '10 月补货',
  status: 'DRAFT',
  stage: 'DRAFT',
  pendingOp: null,
  externalPlanId: null,
  selectedPackingOptionId: null,
  selectedPlacementOptionId: null,
  voidDeadlineAt: null,
  totalUnits: 15,
  shipmentCount: 0,
  sourceType: 'MANUAL',
  sourceRefId: null,
  items: null,
  lastErrorMessage: null,
  prepCost: null,
  labelCost: null,
  estimateJson: null,
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  ...over,
})

/** 操作记录替身：创建时记住操作名称，之后的更新返回合并后的整行。 */
function operationStub() {
  let row: Record<string, unknown> = { id: 'op-1', tenantId: 'tenant-1' }
  return {
    create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => (row = { ...row, ...args.data })),
    update: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => (row = { ...row, ...args.data })),
    findMany: vi.fn().mockResolvedValue([]),
  }
}
const optionStub = (first: unknown = null) => ({
  findFirst: vi.fn().mockResolvedValue(first),
  findMany: vi.fn().mockResolvedValue([]),
  groupBy: vi.fn().mockResolvedValue([]),
  aggregate: vi.fn().mockResolvedValue({ _min: { expiresAt: null }, _count: 0 }),
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
    fbaInboundPlan: {
      findFirst: vi.fn().mockResolvedValue(planRow()),
      findMany: vi.fn().mockResolvedValue([planRow()]),
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => planRow({ ...args.data, id: 'p-new' })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inboundPlanItem: {
      findMany: vi.fn().mockResolvedValue([{ sku: 'A', quantity: 10 }]),
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inboundEligibilityCheck: { findMany: vi.fn().mockResolvedValue([]) },
    inboundOperation: operationStub(),
    packingOption: optionStub(),
    placementOption: optionStub(),
    transportOption: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    deliveryWindow: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    shipmentItem: { findMany: vi.fn().mockResolvedValue([]) },
    labelPrintJob: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    inboundBox: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    packingGroup: { findMany: vi.fn().mockResolvedValue([]) },
    fbaInboundShipment: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ sellerSku: 'A', asin: 'B000000001', fnsku: 'X1', title: '商品 A' }]) },
    syncJob: { create: vi.fn().mockResolvedValue({ id: 'job-1', type: 'FBA_INBOUND_OP', priority: 5 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })
}

const ADDRESS = { name: '深圳仓', addressLine1: '1 Road', city: 'Shenzhen', stateOrProvinceCode: 'GD', countryCode: 'CN', postalCode: '518000', phoneNumber: '1234567' }
const createBody = (over: Record<string, unknown> = {}) => ({ name: '10 月补货', sourceAddress: ADDRESS, items: [{ sku: 'A', quantity: 10 }], ...over })
const atStage = (stage: string, over: Record<string, unknown> = {}) => ({
  fbaInboundPlan: { findFirst: vi.fn().mockResolvedValue(planRow({ stage, externalPlanId: 'IP-1', ...over })), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn(), count: vi.fn() },
})

describe('入仓计划接口：权限与范围', () => {
  it('没有 inbound.read：读接口 403；没有 inbound.plan.write：写接口 403，且没有任何写入', async () => {
    const prisma = stubs([])
    harness = await createTestApp(prisma)
    for (const path of ['/inbound/plans', '/inbound/plans/p1', '/inbound/plans/p1/operations', '/inbound/plans/p1/boxes', '/inbound/shipments'])
      expect((await harness.call('GET', path)).status, path).toBe(403)
    expect((await harness.call('POST', '/inbound/plans', { body: createBody() })).status).toBe(403)
    expect((await harness.call('POST', '/inbound/plans/p1/eligibility', { body: { version: 1 } })).status).toBe(403)
    expect(prisma.fbaInboundPlan.create).not.toHaveBeenCalled()
    expect(prisma.syncJob.create).not.toHaveBeenCalled()
  })

  it('只读成员可以看，但所有写接口都是 403', async () => {
    harness = await createTestApp(stubs(READ))
    expect((await harness.call('GET', '/inbound/plans')).status).toBe(200)
    const writes: Array<[string, string, unknown]> = [
      ['POST', '/inbound/plans', createBody()],
      ['POST', '/inbound/plans/p1/eligibility', { version: 1 }],
      ['POST', '/inbound/plans/p1/submit', { version: 1 }],
      ['POST', '/inbound/plans/p1/packing-options', { version: 1, action: 'GENERATE' }],
      ['PUT', '/inbound/plans/p1/boxes', { version: 1, boxes: [] }],
      ['POST', '/inbound/plans/p1/packing-info', { version: 1 }],
      ['POST', '/inbound/plans/p1/placement-options', { version: 1, action: 'GENERATE' }],
      ['POST', '/inbound/plans/p1/transport-options', { version: 1, action: 'GENERATE', shipments: [] }],
      ['POST', '/inbound/plans/p1/delivery-windows', { version: 1, action: 'GENERATE', shipmentId: 'sh1' }],
      ['POST', '/inbound/plans/p1/labels/print-jobs', { kind: 'BOX' }],
      ['PATCH', '/inbound/plans/p1/costs', { version: 1, prepCost: 1 }],
      ['POST', '/inbound/plans/p1/confirm', { version: 1 }],
      ['POST', '/inbound/plans/p1/cancel', { version: 1, reason: '不再需要' }],
      ['PATCH', '/inbound/shipments/sh1/tracking', { version: 1, billOfLadingNumber: 'B1' }],
    ]
    for (const [method, path, payload] of writes) expect((await harness.call(method, path, { body: payload })).status, `${method} ${path}`).toBe(403)
  })

  it('计划不属于当前企业（查不到）时 404，查询条件带企业编号', async () => {
    const prisma = stubs(WRITE, { fbaInboundPlan: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/inbound/plans/other')).status).toBe(404)
    expect((await harness.call('POST', '/inbound/plans/other/eligibility', { body: { version: 1 } })).status).toBe(404)
    expect(prisma.fbaInboundPlan.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'other', tenantId: 'tenant-1' })
  })
})

describe('入仓计划接口：创建草稿', () => {
  it('只保存本地草稿：不要求授权连接与开关，不建任务、不入队；装箱与贴标责任固定为卖家', async () => {
    const prisma = stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) }, platformConnection: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans', { body: createBody({ sellerAccountId: 's1' }) })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ state: 'SAVED', jobId: null, operationId: null })
    const data = prisma.fbaInboundPlan.create.mock.calls[0][0].data
    expect(data).toMatchObject({ tenantId: 'tenant-1', stage: 'DRAFT', totalUnits: 10, createdBy: 'user-1' })
    expect(JSON.stringify(data)).not.toMatch(/AMAZON|prepOwner|labelOwner/i)
    expect(prisma.inboundPlanItem.createMany.mock.calls[0][0].data[0]).toMatchObject({ sku: 'A', quantity: 10, asin: 'B000000001', fnsku: 'X1' })
    expect(prisma.syncJob.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('校验：缺名称、缺商品、SKU 重复、数量非法都是 422，不碰数据库', async () => {
    const prisma = stubs(WRITE)
    harness = await createTestApp(prisma)
    for (const body of [
      createBody({ name: '' }),
      createBody({ items: [] }),
      createBody({
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'A', quantity: 2 },
        ],
      }),
      createBody({ items: [{ sku: 'A', quantity: 0 }] }),
      createBody({ sourceAddress: undefined }),
    ])
      expect((await harness.call('POST', '/inbound/plans', { body })).status).toBe(422)
    expect(prisma.fbaInboundPlan.create).not.toHaveBeenCalled()
  })

  it('商品目录里没有的 SKU 不能入仓：422 并指出是哪个 SKU', async () => {
    const prisma = stubs(WRITE, { fbaProduct: { findMany: vi.fn().mockResolvedValue([]) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans', { body: createBody({ sellerAccountId: 's1' }) })
    expect(res.status).toBe(422)
    expect(res.json.error.message).toContain('A')
    expect(prisma.fbaInboundPlan.create).not.toHaveBeenCalled()
  })
})

describe('入仓计划接口：调用亚马逊的动作（权限 → 连接 → 开关 → 状态 → 校验）', () => {
  it('资格预检：不受写入开关控制，直接入队，不登记写入流程', async () => {
    const prisma = stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/eligibility', { body: { version: 1 } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ state: 'QUEUED', jobId: 'job-1', operationId: 'op-1' })
    expect(prisma.fbaInboundPlan.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'p1', tenantId: 'tenant-1', version: 1 }, data: { pendingOp: 'ELIGIBILITY' } })
    expect(prisma.syncJob.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', type: 'FBA_INBOUND_OP', context: { inboundOpId: 'op-1' } })
    expect(harness.workflow.registerWriteRun).not.toHaveBeenCalled()
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ inboundOpId: 'op-1' }), 'job-1', expect.objectContaining({ type: 'FBA_INBOUND_OP' }))
  })

  it('提交到亚马逊：开关没开返回 409 并说明环节；计划、任务、队列都不动', async () => {
    const prisma = stubs(WRITE, {
      ...atStage('ELIGIBILITY', { externalPlanId: null }),
      inboundEligibilityCheck: { findMany: vi.fn().mockResolvedValue([{ sku: 'A', eligible: true, checkedAt: stamp }]) },
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/submit', { body: { version: 1 } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('WRITE_SWITCH_OFF')
    expect(prisma.fbaInboundPlan.updateMany).not.toHaveBeenCalled()
    expect(prisma.syncJob.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交到亚马逊：没有授权连接返回 409', async () => {
    const prisma = stubs(WRITE, {
      ...atStage('ELIGIBILITY', { externalPlanId: null }),
      inboundEligibilityCheck: { findMany: vi.fn().mockResolvedValue([{ sku: 'A', eligible: true, checkedAt: stamp }]) },
      platformConnection: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/submit', { body: { version: 1 } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('CONNECTION_UNAVAILABLE')
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交到亚马逊：有 SKU 没通过资格预检时 409 并列出 SKU', async () => {
    const prisma = stubs(WRITE, {
      ...atStage('ELIGIBILITY', { externalPlanId: null }),
      inboundEligibilityCheck: { findMany: vi.fn().mockResolvedValue([{ sku: 'A', eligible: false, checkedAt: stamp }]) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/submit', { body: { version: 1 } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('A')
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交到亚马逊：全部合格后计划标为处理中，登记写入流程并在提交后入队', async () => {
    const prisma = stubs(WRITE, {
      ...atStage('ELIGIBILITY', { externalPlanId: null }),
      inboundEligibilityCheck: { findMany: vi.fn().mockResolvedValue([{ sku: 'A', eligible: true, checkedAt: stamp }]) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/submit', { body: { version: 1 } })
    expect(res.status).toBe(201)
    expect(res.json.data.state).toBe('QUEUED')
    expect(prisma.fbaInboundPlan.updateMany.mock.calls[0][0].data).toMatchObject({ pendingOp: 'CREATE_PLAN' })
    expect(harness.workflow.registerWriteRun).toHaveBeenCalledTimes(1)
    expect(harness.queue.add).toHaveBeenCalledTimes(1)
  })

  it('版本已被他人推进：409 并带当前版本，不建任务', async () => {
    const prisma = stubs(WRITE, { fbaInboundPlan: { findFirst: vi.fn().mockResolvedValue(planRow({ version: 4 })), updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/eligibility', { body: { version: 1 } })
    expect(res.status).toBe(409)
    expect(res.json.error.details).toMatchObject({ currentVersion: 4, expectedVersion: 1 })
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('有操作处理中时任何动作都 409 并说明原因；状态不对也 409', async () => {
    harness = await createTestApp(stubs(WRITE, atStage('CREATED', { pendingOp: 'GENERATE_PACKING' })))
    const busy = await harness.call('POST', '/inbound/plans/p1/packing-options', { body: { version: 1, action: 'GENERATE' } })
    expect(busy.status).toBe(409)
    expect(busy.json.error.message).toContain('正在处理')
    await harness.close()
    harness = await createTestApp(stubs(WRITE, atStage('DRAFT')))
    expect((await harness.call('POST', '/inbound/plans/p1/placement-options', { body: { version: 1, action: 'GENERATE' } })).status).toBe(409)
  })

  it('生成装箱方案不受开关控制；确认装箱方案受 sw.inbound.packing.confirm 控制', async () => {
    const offered = { packingOptionId: 'PO-1', status: 'OFFERED', expiresAt: new Date(Date.now() + 3_600_000) }
    const prisma = stubs(WRITE, {
      ...atStage('CREATED'),
      packingOption: { findFirst: vi.fn().mockResolvedValue(offered), groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-options', { body: { version: 1, action: 'GENERATE' } })).status).toBe(201)
    const confirm = await harness.call('POST', '/inbound/plans/p1/packing-options', { body: { version: 2, action: 'CONFIRM', optionId: 'PO-1' } })
    expect(confirm.status).toBe(409)
    expect(confirm.json.error.code).toBe('WRITE_SWITCH_OFF')
    expect(harness.queue.add).toHaveBeenCalledTimes(1)
  })

  it('确认方案：缺方案编号 422；方案已过期或不可选 409，都不入队', async () => {
    const expired = { packingOptionId: 'PO-1', status: 'OFFERED', expiresAt: new Date(Date.now() - 1000) }
    const prisma = stubs(WRITE, {
      ...atStage('CREATED'),
      packingOption: { findFirst: vi.fn().mockResolvedValue(expired), groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue([]) },
    })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/inbound/plans/p1/packing-options', { body: { version: 1, action: 'CONFIRM' } })).status).toBe(422)
    const res = await harness.call('POST', '/inbound/plans/p1/packing-options', { body: { version: 1, action: 'CONFIRM', optionId: 'PO-1' } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('过期')
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交箱内物品：服务端校验每个 SKU 的装箱总数，不一致 422，不入队', async () => {
    const boxes = [{ boxId: 'BOX-001', packingGroupId: null, quantity: 1, contentJson: [{ sku: 'A', quantity: 4 }] }]
    const prisma = stubs(WRITE, { ...atStage('PACKING_CONFIRMED'), inboundBox: { findMany: vi.fn().mockResolvedValue(boxes) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/packing-info', { body: { version: 1 } })
    expect(res.status).toBe(422)
    expect(res.json.error.fieldErrors.boxes.length).toBeGreaterThan(0)
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('提交箱内物品：对齐后受 sw.inbound.packinginfo.submit 控制，通过则入队', async () => {
    const boxes = [{ boxId: 'BOX-001', packingGroupId: null, quantity: 1, contentJson: [{ sku: 'A', quantity: 10 }] }]
    const prisma = stubs(WRITE, { ...atStage('PACKING_CONFIRMED'), inboundBox: { findMany: vi.fn().mockResolvedValue(boxes) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/packing-info', { body: { version: 1 } })
    expect(res.status).toBe(201)
    expect(prisma.fbaInboundPlan.updateMany.mock.calls[0][0].data).toMatchObject({ pendingOp: 'SUBMIT_PACKING_INFO' })
    await harness.close()
    harness = await createTestApp(
      stubs(WRITE, { ...atStage('PACKING_CONFIRMED'), inboundBox: { findMany: vi.fn().mockResolvedValue(boxes) }, integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }),
    )
    expect((await harness.call('POST', '/inbound/plans/p1/packing-info', { body: { version: 1 } })).json.error.code).toBe('WRITE_SWITCH_OFF')
  })

  it('运输方案：联系人必填；货件不属于计划时 422', async () => {
    harness = await createTestApp(stubs(WRITE, { ...atStage('PLACEMENT_CONFIRMED'), fbaInboundShipment: { findMany: vi.fn().mockResolvedValue([{ shipmentId: 'SH-1' }]), findFirst: vi.fn() } }))
    const contact = { name: '张三', phoneNumber: '123456', email: 'a@b.com' }
    const when = '2026-11-01T00:00:00.000Z'
    expect((await harness.call('POST', '/inbound/plans/p1/transport-options', { body: { version: 1, action: 'GENERATE', shipments: [{ shipmentId: 'SH-1', readyToShipAt: when }] } })).status).toBe(422)
    expect(
      (await harness.call('POST', '/inbound/plans/p1/transport-options', { body: { version: 1, action: 'GENERATE', shipments: [{ shipmentId: 'SH-X', readyToShipAt: when, contact }] } })).status,
    ).toBe(422)
    expect(
      (await harness.call('POST', '/inbound/plans/p1/transport-options', { body: { version: 1, action: 'GENERATE', shipments: [{ shipmentId: 'SH-1', readyToShipAt: when, contact }] } })).status,
    ).toBe(201)
    // 联系人不进审计
    const audits = (harness.writeGuardStubs.auditEvent.create as ReturnType<typeof vi.fn>).mock.calls.map(call => JSON.stringify(call[0]))
    expect(audits.join('')).not.toContain('123456')
  })

  it('确认运输方案：每个货件都要选，报价过期 409', async () => {
    const quote = { transportOptionId: 'T-1', expiresAt: new Date(Date.now() - 1000), preconditionsJson: [] }
    const prisma = stubs(WRITE, {
      ...atStage('PLACEMENT_CONFIRMED'),
      fbaInboundShipment: { findMany: vi.fn().mockResolvedValue([{ shipmentId: 'SH-1' }, { shipmentId: 'SH-2' }]), findFirst: vi.fn() },
      transportOption: { findFirst: vi.fn().mockResolvedValue(quote) },
    })
    harness = await createTestApp(prisma)
    const contact = { name: '张三', phoneNumber: '123456', email: 'a@b.com' }
    const one = { version: 1, action: 'CONFIRM', selections: [{ shipmentId: 'SH-1', transportOptionId: 'T-1', contact }] }
    expect((await harness.call('POST', '/inbound/plans/p1/transport-options', { body: one })).status).toBe(422)
    const both = { ...one, selections: [...one.selections, { shipmentId: 'SH-2', transportOptionId: 'T-1', contact }] }
    const res = await harness.call('POST', '/inbound/plans/p1/transport-options', { body: both })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('过期')
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('批量打印标签：只读调用不受开关控制、不要求版本号；每个货件一个打印任务，在同一事务里建立', async () => {
    const prisma = stubs(WRITE, {
      ...atStage('TRANSPORT_CONFIRMED', { voidDeadlineAt: new Date(Date.now() + 3_600_000) }),
      fbaInboundPlan: { findFirst: vi.fn().mockResolvedValue(planRow({ stage: 'TRANSPORT_CONFIRMED', externalPlanId: 'IP-1' })), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      fbaInboundShipment: { findMany: vi.fn().mockResolvedValue([{ shipmentId: 'SH-1' }, { shipmentId: 'SH-2' }]), findFirst: vi.fn() },
      labelPrintJob: { create: vi.fn().mockImplementation(async (args: { data: { shipmentId: string } }) => ({ id: `job-${args.data.shipmentId}` })) },
      integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/labels/print-jobs', { body: { kind: 'BOX' } })
    expect(res.status).toBe(201)
    expect(prisma.labelPrintJob.create).toHaveBeenCalledTimes(2)
    expect(prisma.labelPrintJob.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', kind: 'BOX', status: 'QUEUED', pageType: 'PackageLabel_Letter_6' })
    expect(prisma.inboundOperation.update.mock.calls.some((call: Array<{ data: unknown }>) => JSON.stringify(call[0].data).includes('job-SH-1'))).toBe(true)
    expect(harness.workflow.registerWriteRun).not.toHaveBeenCalled()
  })
})

describe('入仓计划接口：不调用亚马逊的写入', () => {
  it('保存箱内物品：整体替换，自动补箱号；SKU 不在计划里或箱号重复 422', async () => {
    const prisma = stubs(WRITE, atStage('PACKING_CONFIRMED'))
    harness = await createTestApp(prisma)
    const box = { quantity: 1, weightLb: 10, lengthIn: 10, widthIn: 10, heightIn: 10, items: [{ sku: 'A', quantity: 10 }] }
    const res = await harness.call('PUT', '/inbound/plans/p1/boxes', {
      body: {
        version: 1,
        boxes: [
          { ...box, boxId: 'BOX-001' },
          { ...box, boxId: 'BOX-001' },
        ],
      },
    })
    expect(res.status).toBe(422)
    expect((await harness.call('PUT', '/inbound/plans/p1/boxes', { body: { version: 1, boxes: [{ ...box, items: [{ sku: 'Z', quantity: 1 }] }] } })).status).toBe(422)
    expect((await harness.call('PUT', '/inbound/plans/p1/boxes', { body: { version: 1, boxes: [{ ...box, weightLb: 0 }] } })).status).toBe(422)
    const ok = await harness.call('PUT', '/inbound/plans/p1/boxes', { body: { version: 1, boxes: [box, box] } })
    expect(ok.status).toBe(200)
    const rows = prisma.inboundBox.createMany.mock.calls[0][0].data
    expect(rows.map((row: { boxId: string }) => row.boxId)).toEqual(['BOX-001', 'BOX-002'])
    expect(prisma.inboundBox.deleteMany).toHaveBeenCalledTimes(1)
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('标记已发货：只改本地状态，需要标签已打印，不入队', async () => {
    const prisma = stubs(WRITE, atStage('LABELS_PRINTED'))
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/inbound/plans/p1/confirm', { body: { version: 1 } })
    expect(res.status).toBe(201)
    expect(prisma.fbaInboundPlan.updateMany.mock.calls[0][0].data).toMatchObject({ stage: 'SHIPPED' })
    expect(harness.queue.add).not.toHaveBeenCalled()
    await harness.close()
    harness = await createTestApp(stubs(WRITE, atStage('TRANSPORT_CONFIRMED')))
    const early = await harness.call('POST', '/inbound/plans/p1/confirm', { body: { version: 1 } })
    expect(early.status).toBe(409)
    expect(early.json.error.message).toContain('标签')
  })

  it('取消：需要原因；还没到亚马逊的计划只在本地取消，不要求开关', async () => {
    const prisma = stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/inbound/plans/p1/cancel', { body: { version: 1 } })).status).toBe(422)
    const res = await harness.call('POST', '/inbound/plans/p1/cancel', { body: { version: 1, reason: '不再需要' } })
    expect(res.status).toBe(201)
    expect(res.json.data.state).toBe('SAVED')
    expect(prisma.fbaInboundPlan.updateMany.mock.calls[0][0].data).toMatchObject({ stage: 'CANCELLED' })
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('取消已在亚马逊的计划：受 sw.inbound.plan.create 控制；作废窗口已过 409', async () => {
    harness = await createTestApp(stubs(WRITE, { ...atStage('CREATED'), integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }))
    const off = await harness.call('POST', '/inbound/plans/p1/cancel', { body: { version: 1, reason: '不再需要' } })
    expect(off.status).toBe(409)
    expect(off.json.error.code).toBe('WRITE_SWITCH_OFF')
    await harness.close()
    harness = await createTestApp(stubs(WRITE, atStage('TRANSPORT_CONFIRMED', { voidDeadlineAt: new Date(Date.now() - 60_000) })))
    const late = await harness.call('POST', '/inbound/plans/p1/cancel', { body: { version: 1, reason: '不再需要' } })
    expect(late.status).toBe(409)
    expect(late.json.error.message).toContain('作废窗口')
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('填写成本与估算：至少改一项；乐观锁生效', async () => {
    const prisma = stubs(WRITE)
    harness = await createTestApp(prisma)
    expect((await harness.call('PATCH', '/inbound/plans/p1/costs', { body: { version: 1 } })).status).toBe(422)
    const res = await harness.call('PATCH', '/inbound/plans/p1/costs', { body: { version: 1, prepCost: 12.5, estimate: { freightPerLb: 0.4 } } })
    expect(res.status).toBe(200)
    expect(prisma.fbaInboundPlan.updateMany.mock.calls[0][0].data).toMatchObject({ prepCost: 12.5, estimateJson: { freightPerLb: 0.4 } })
  })
})

describe('入仓计划接口：读取', () => {
  it('列表：返回十三个阶段的看板与写入状态；开关关闭时说明被拦截的环节', async () => {
    harness = await createTestApp(stubs(WRITE, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }))
    const res = await harness.call('GET', '/inbound/plans')
    expect(res.status).toBe(200)
    expect(res.json.data.items[0]).toMatchObject({ id: 'p1', stage: 'DRAFT', stageLabel: expect.any(String) })
    expect(res.json.data.board).toHaveLength(13)
    expect(res.json.data.write).toMatchObject({ allowed: false, step: 'SWITCH' })
    expect(res.json.data.write.reason).toContain('开关')
  })

  it('列表：阶段筛选参数非法时 422', async () => {
    harness = await createTestApp(stubs(READ))
    expect((await harness.call('GET', '/inbound/plans?stage=WHATEVER')).status).toBe(422)
  })

  it('概览：只给当前状态下允许的动作，带步骤条', async () => {
    harness = await createTestApp(stubs(WRITE, atStage('CREATED')))
    const res = await harness.call('GET', '/inbound/plans/p1')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.actions.CONFIRM_PACKING.allowed).toBe(true)
    expect(data.actions.SUBMIT.allowed).toBe(false)
    expect(data.actions.MARK_SHIPPED.reason).toContain('标签')
  })

  it('概览：每个写入开关各给一个状态，生成方案这类不受开关控制的动作单列', async () => {
    harness = await createTestApp(stubs(WRITE, { ...atStage('CREATED'), integrationSwitch: { findFirst: vi.fn().mockResolvedValue(null) } }))
    const write = (await harness.call('GET', '/inbound/plans/p1')).json.data.write
    expect(write['sw.inbound.packing.confirm']).toMatchObject({ allowed: false, step: 'SWITCH' })
    expect(write.NONE.allowed).toBe(true)
  })
})
