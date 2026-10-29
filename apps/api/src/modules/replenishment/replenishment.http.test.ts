import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { policyRow, prismaFor, record } from '../inventory/inventory-http.test-helper'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
// 批次号、回看窗口都按“今天”算：把时钟固定在测试数据写死的日期上，否则每过一天就有断言失败（P3-01 收尾时发现，日期从 10-22 走到 10-23）。只冻结 Date，不影响定时器与网络。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
})
afterEach(async () => {
  vi.useRealTimers()
  await harness?.close()
  harness = undefined
})

const READ = ['inventory.read', 'replenishment.read']
const PLAN = [...READ, 'replenishment.plan.create']
const day = (date: string) => new Date(`${date}T00:00:00Z`)
const num = (value: string) => ({ toString: () => value })

const fullPolicy = (over: Record<string, unknown> = {}) =>
  policyRow({
    serviceLevel: num('0.9500'),
    productionDays: 10,
    domesticDays: 3,
    receivingDays: 7,
    transportPreference: 'AUTO',
    transportOptionsJson: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
    casePackQty: 10,
    moq: 100,
    ...over,
  })

const SNAPSHOT = {
  method: 'replenishment-chain@1',
  today: '2026-10-22',
  storeIds: ['s1'],
  skipped: {},
  truncated: false,
  subscribeSaveUsed: 0,
  dataTimes: { inventoryUpdatedAt: null, ordersThrough: '2026-10-21', restockSnapshotDate: null },
}
const batchRow = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  tenantId: 'tenant-1',
  batchNo: 'RB-20261022-001',
  status: 'PENDING_REVIEW',
  today: day('2026-10-22'),
  storeIdsJson: ['s1'],
  policyVersionsJson: [],
  snapshotJson: SNAPSHOT,
  skuTotal: 1,
  recommendedCount: 1,
  computedAt: new Date('2026-10-22T08:00:00Z'),
  computedBy: 'user-1',
  createdAt: new Date('2026-10-22T08:00:00Z'),
  ...over,
})
const recRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  tenantId: 'tenant-1',
  batchId: 'b1',
  sellerAccountId: 's1',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  fnsku: 'X0TEST0001',
  channel: 'PURCHASE',
  riskLevel: 'HIGH',
  recommendedQty: 440,
  purchaseQty: 440,
  dueDate: day('2026-10-22'),
  shipDate: day('2026-11-04'),
  arriveDate: day('2026-12-11'),
  stockoutDate: day('2026-11-11'),
  confidence: num('0.9000'),
  calcStepsJson: { dailyDemand: 10, coverageDays: 60, steps: [] },
  shipmentsJson: [{ mode: 'SEA', qty: 440, orderDate: '2026-10-22', shipDate: '2026-11-04', arriveDate: '2026-12-11', leadDays: 50, lateDays: 30, unitCost: 0.5 }],
  capitalAmount: null,
  amazonRestockQty: 500,
  amazonShipDate: null,
  diffReason: '目标天数不同',
  createdAt: new Date(),
  actions: [],
  ...over,
})

function stubs(permissions: string[], over: Record<string, any> = {}) {
  return prismaFor(permissions, {
    replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(fullPolicy()), findMany: vi.fn().mockResolvedValue([fullPolicy()]), create: vi.fn().mockResolvedValue(fullPolicy({ versionNo: 2 })) },
    fbaProduct: {
      findFirst: vi.fn().mockResolvedValue({ id: 'p1' }),
      findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', sellerSku: 'SKU-1', title: '示例商品', brand: '示例品牌', productType: '耳机' }]),
    },
    fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([record()]), findFirst: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
    replenishmentBatch: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(batchRow()),
      findFirst: vi.fn().mockResolvedValue(batchRow()),
      findFirstOrThrow: vi.fn().mockResolvedValue(batchRow()),
      findMany: vi.fn().mockResolvedValue([batchRow()]),
      update: vi.fn().mockResolvedValue({}),
    },
    replenishmentRecommendation: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([recRow()]) },
    replenishmentAction: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([]) },
    replenishmentOutcome: { findMany: vi.fn().mockResolvedValue([]) },
    supplier: { findFirst: vi.fn().mockResolvedValue({ id: 'sup-1', currency: 'USD', status: 'ACTIVE' }) },
    purchaseOrder: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({ id: 'po-1', number: 'PO-RB-20261022-001-01' }), findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  })
}
describe('补货接口：权限', () => {
  it('没有 replenishment.read：读接口 403；没有 plan.create：写接口 403；没有 policy.write：保存策略 403', async () => {
    harness = await createTestApp(stubs([]))
    for (const path of ['/replenishment/policies', '/replenishment/recommendations', '/replenishment/batches', '/replenishment/batches/b1', '/replenishment/simulations/x'])
      expect((await harness.call('GET', path)).status, path).toBe(403)
    await harness.close()
    harness = await createTestApp(stubs(READ))
    for (const path of [
      '/replenishment/recompute',
      '/replenishment/batches/b1/decisions',
      '/replenishment/batches/b1/evaluate',
      '/replenishment/to-purchase-draft',
      '/replenishment/batches/b1/to-inbound-drafts',
      '/replenishment/to-awd-draft',
    ]) {
      expect((await harness.call('POST', path, { body: {} })).status, path).toBe(403)
    }
    expect((await harness.call('PUT', '/replenishment/policies', { body: {} })).status).toBe(403)
  })
})

describe('补货策略（三级、版本）', () => {
  const body = {
    level: 'SKU',
    levelRef: 'SKU-1',
    expectedVersionNo: 0,
    leadTimeDays: 30,
    awdLeadTimeDays: null,
    safetyDays: 14,
    coverageDays: 60,
    redundancyMultiplier: 1.5,
    inboundCounted: ['WORKING', 'SHIPPED'],
    agingFromDays: 271,
    changeReason: '主推款加大覆盖',
    productionDays: 10,
    domesticDays: 3,
    receivingDays: 7,
    serviceLevel: 0.95,
    transportPreference: 'AUTO',
    transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
    casePackQty: 10,
    moq: 100,
    minOrderValue: null,
  }

  it('列表：返回各版本、企业级当前版本与可选品类', async () => {
    harness = await createTestApp(stubs(READ))
    const { data } = (await harness.call('GET', '/replenishment/policies')).json
    expect(data.items).toHaveLength(1)
    expect(data.tenantCurrent).toMatchObject({ level: 'TENANT', serviceLevel: 0.95, productionDays: 10, transportOptions: [{ mode: 'SEA' }] })
    expect(data.categories).toEqual(['耳机'])
  })

  it('列表参数不合法 422', async () => {
    harness = await createTestApp(stubs(READ))
    expect((await harness.call('GET', '/replenishment/policies?level=NOPE')).status).toBe(422)
  })

  it('保存 SKU 级新版本：版本号 1，带上全部新参数，写审计与时间线', async () => {
    const prisma = stubs(['replenishment.policy.write'], {
      replenishmentPolicy: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(fullPolicy({ level: 'SKU', levelRef: 'SKU-1', versionNo: 1 })),
      },
      fbaInventoryRecord: { findFirst: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/replenishment/policies', { body })
    expect(res.status).toBe(200)
    expect(prisma.replenishmentPolicy.create.mock.calls[0][0].data).toMatchObject({
      level: 'SKU',
      levelRef: 'SKU-1',
      versionNo: 1,
      serviceLevel: '0.9500',
      productionDays: 10,
      casePackQty: 10,
      moq: 100,
      minOrderValue: null,
      createdBy: 'user-1',
    })
    expect(prisma.entityEvent.create.mock.calls[0][0].data).toMatchObject({ entityType: 'REPLENISHMENT_POLICY', entityId: 'SKU:SKU-1' })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'REPLENISHMENT_POLICY_VERSIONED' })
    expect(res.json.data).toMatchObject({ level: 'SKU', levelRef: 'SKU-1', versionNo: 1 })
  })

  it('版本号与最新版本不一致：409，不创建', async () => {
    const prisma = stubs(['replenishment.policy.write'], {
      replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(fullPolicy({ level: 'SKU', levelRef: 'SKU-1', versionNo: 3 })), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
      fbaInventoryRecord: { findFirst: vi.fn().mockResolvedValue({ id: 'inv-1' }) },
    })
    harness = await createTestApp(prisma)
    expect((await harness.call('PUT', '/replenishment/policies', { body })).status).toBe(409)
    expect(prisma.replenishmentPolicy.create).not.toHaveBeenCalled()
  })

  it('企业级对象必须是 ALL、运输方式不能重复、偏好必须在选项里：422', async () => {
    harness = await createTestApp(stubs(['replenishment.policy.write']))
    expect((await harness.call('PUT', '/replenishment/policies', { body: { ...body, level: 'TENANT', levelRef: 'SKU-1' } })).status).toBe(422)
    expect((await harness.call('PUT', '/replenishment/policies', { body: { ...body, transportOptions: [body.transportOptions[0], body.transportOptions[0]] } })).status).toBe(422)
    expect((await harness.call('PUT', '/replenishment/policies', { body: { ...body, transportPreference: 'AIR' } })).status).toBe(422)
  })

  it('SKU 级或品类级的对象不存在：422，不创建（避免拼写错误的覆盖永远不生效）', async () => {
    const prisma = stubs(['replenishment.policy.write'], {
      fbaInventoryRecord: { findFirst: vi.fn().mockResolvedValue(null) },
      fbaProduct: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    })
    harness = await createTestApp(prisma)
    expect((await harness.call('PUT', '/replenishment/policies', { body })).status).toBe(422)
    expect((await harness.call('PUT', '/replenishment/policies', { body: { ...body, level: 'CATEGORY', levelRef: '不存在' } })).status).toBe(422)
    expect(prisma.replenishmentPolicy.create).not.toHaveBeenCalled()
  })
})

describe('重算与建议', () => {
  it('重算：按计算链产出批次，只保存建议量大于 0 的行，冻结输入与策略版本', async () => {
    const prisma = stubs(PLAN, { fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([{ ...record(), fulfillableQuantity: 200 }]) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/replenishment/recompute', { body: {} })
    expect(res.status).toBe(201)
    const batch = prisma.replenishmentBatch.create.mock.calls[0][0].data
    expect(batch).toMatchObject({ tenantId: 'tenant-1', batchNo: 'RB-20261022-001', skuTotal: 1, computedBy: 'user-1', storeIdsJson: ['s1'] })
    expect(batch.policyVersionsJson).toEqual([{ level: 'TENANT', levelRef: 'ALL', versionNo: 1 }])
    const created = prisma.replenishmentRecommendation.createMany.mock.calls[0][0].data
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ sku: 'SKU-1', batchId: 'b1' })
    expect(created[0].calcStepsJson.steps).toHaveLength(8)
    expect(created[0].recommendedQty).toBeGreaterThan(0)
    expect(res.json.data.snapshot).toMatchObject({ method: 'replenishment-chain@1', storeIds: ['s1'] })
  })

  it('上游仓储库存只用各店最近一次快照，抵减采购量而不改变补货量；没有上游仓储数据的 SKU 不当 0', async () => {
    const inventory = { fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([{ ...record(), fulfillableQuantity: 200 }]) } }
    const baseline = stubs(PLAN, inventory)
    harness = await createTestApp(baseline)
    await harness.call('POST', '/replenishment/recompute', { body: {} })
    const plain = baseline.replenishmentRecommendation.createMany.mock.calls[0][0].data[0]
    await harness.close()

    const latest = new Date('2026-10-22T00:00:00Z')
    const awdRows = [{ sellerAccountId: 's1', sku: 'SKU-1', availableQty: 300, inboundToAwdQty: 50 }]
    const prisma = stubs(PLAN, {
      ...inventory,
      awdInventory: {
        groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: latest } }]),
        findMany: vi.fn().mockResolvedValue(awdRows),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    })
    harness = await createTestApp(prisma)
    await harness.call('POST', '/replenishment/recompute', { body: {} })
    const withAwd = prisma.replenishmentRecommendation.createMany.mock.calls[0][0].data[0]
    expect(prisma.awdInventory.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', OR: [{ sellerAccountId: 's1', snapshotDate: latest }] })
    expect(withAwd.recommendedQty).toBe(plain.recommendedQty)
    expect(withAwd.purchaseQty).toBeLessThan(plain.purchaseQty)
    const supply = withAwd.calcStepsJson.steps.find((step: { key: string }) => step.key === 'SUPPLY')
    expect(supply.details.find((detail: { label: string }) => detail.label.startsWith('上游仓储')).value).toBe('350')
  })

  it('没有策略：不产出建议，批次快照按原因计数', async () => {
    const prisma = stubs(PLAN, { replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/replenishment/recompute', { body: {} })
    expect(res.status).toBe(201)
    expect(prisma.replenishmentRecommendation.createMany).not.toHaveBeenCalled()
    expect(res.json.data.snapshot.skipped).toEqual({ 尚未配置补货策略: 1 })
    expect(prisma.replenishmentBatch.create.mock.calls[0][0].data).toMatchObject({ recommendedCount: 0 })
  })

  it('指定店铺不在数据范围内：403；未知字段 422', async () => {
    harness = await createTestApp(stubs(PLAN, { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } }))
    expect((await harness.call('POST', '/replenishment/recompute', { body: { storeIds: ['other'] } })).status).toBe(403)
    expect((await harness.call('POST', '/replenishment/recompute', { body: { nope: 1 } })).status).toBe(422)
  })

  it('建议列表：返回批次、冻结快照、双源核对与资金“尚未接入”', async () => {
    const prisma = stubs(READ, {
      replenishmentRecommendation: {
        findMany: vi
          .fn()
          .mockImplementation((args: { select?: unknown }) =>
            Promise.resolve(
              args.select ? [{ id: 'r1', sku: 'SKU-1', sellerAccountId: 's1', riskLevel: 'HIGH', recommendedQty: 440, dueDate: day('2026-10-22'), arriveDate: day('2026-12-11') }] : [recRow()],
            ),
          ),
      },
    })
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', '/replenishment/recommendations?sort=risk:asc')).json
    expect(data.batch).toMatchObject({ batchNo: 'RB-20261022-001', status: 'PENDING_REVIEW' })
    expect(data.snapshot.method).toBe('replenishment-chain@1')
    expect(data.total).toBe(1)
    expect(data.items[0]).toMatchObject({
      sku: 'SKU-1',
      storeName: '店铺一',
      title: '示例商品',
      risk: 'HIGH',
      recommendedQty: 440,
      orderDate: '2026-10-22',
      amazon: { qty: 500, diffQty: -60, diffReason: '目标天数不同' },
      capital: { state: 'NOT_CONNECTED', amount: null },
    })
  })

  it('没有批次：返回空列表而不是报错；排序字段不在白名单 422', async () => {
    harness = await createTestApp(stubs(READ, { replenishmentBatch: { findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('GET', '/replenishment/recommendations')).json.data).toMatchObject({ batch: null, items: [], total: 0 })
    expect((await harness.call('GET', '/replenishment/recommendations?sort=hacker')).status).toBe(422)
  })

  it('批次详情：批次不存在 404；存在时给执行情况与结果回看（到仓核对尚未接入）', async () => {
    harness = await createTestApp(stubs(READ, { replenishmentBatch: { findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('GET', '/replenishment/batches/nope')).status).toBe(404)
    await harness.close()
    harness = await createTestApp(
      stubs(READ, {
        replenishmentRecommendation: {
          findMany: vi
            .fn()
            .mockImplementation((args: { select?: unknown }) =>
              Promise.resolve(args.select ? [{ id: 'r1', sku: 'SKU-1', sellerAccountId: 's1', riskLevel: 'HIGH', recommendedQty: 440, dueDate: day('2026-10-22'), arriveDate: null }] : [recRow()]),
            ),
        },
      }),
    )
    const { data } = (await harness.call('GET', '/replenishment/batches/b1')).json
    expect(data.execution).toMatchObject({ pendingTargets: 0, purchaseOrders: [] })
    expect(data.review.arrival.state).toBe('NOT_CONNECTED')
    expect(data.review.summary).toMatchObject({ evaluated: 0, meanAbsErrorPct: null })
  })
})

describe('采纳与草稿', () => {
  const recFound = vi.fn().mockResolvedValue([recRow()])

  it('采纳与忽略：写动作、刷新批次状态；调整缺数量、忽略缺原因 422；建议不存在 404', async () => {
    const prisma = stubs(PLAN, {
      replenishmentRecommendation: { findMany: recFound },
      replenishmentAction: { createMany: vi.fn().mockResolvedValue({ count: 1 }), findMany: vi.fn().mockResolvedValue([{ recommendationId: 'r1', action: 'ADOPT' }]) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/replenishment/batches/b1/decisions', { body: { items: [{ recommendationId: 'r1', action: 'ADOPT' }] } })
    expect(res.status).toBe(201)
    expect(prisma.replenishmentAction.createMany.mock.calls[0][0].data[0]).toMatchObject({ action: 'ADOPT', finalQty: 440, actorId: 'user-1', batchId: 'b1' })
    expect(prisma.replenishmentBatch.update.mock.calls[0][0].data).toEqual({ status: 'CLOSED' })
    expect(res.json.data).toMatchObject({ updated: 1, batchStatus: 'CLOSED' })
    expect((await harness.call('POST', '/replenishment/batches/b1/decisions', { body: { items: [{ recommendationId: 'r1', action: 'ADJUST' }] } })).status).toBe(422)
    expect((await harness.call('POST', '/replenishment/batches/b1/decisions', { body: { items: [{ recommendationId: 'r1', action: 'IGNORE' }] } })).status).toBe(422)
    expect(
      (
        await harness.call('POST', '/replenishment/batches/b1/decisions', {
          body: {
            items: [
              { recommendationId: 'r1', action: 'ADJUST', qty: 300 },
              { recommendationId: 'missing', action: 'ADOPT' },
            ],
          },
        })
      ).status,
    ).toBe(404)
  })

  it('采购单草稿：缺供应商 422；已生成过 409；成功时创建 DRAFT 采购单与行，登记动作', async () => {
    const prisma = stubs([...PLAN, 'purchase.order.write'], { replenishmentRecommendation: { findMany: recFound } })
    harness = await createTestApp(prisma)
    const body = { batchId: 'b1', items: [{ recommendationId: 'r1' }], supplierId: 'sup-1' }
    expect((await harness.call('POST', '/replenishment/to-purchase-draft', { body: { ...body, supplierId: undefined } })).status).toBe(422)
    const res = await harness.call('POST', '/replenishment/to-purchase-draft', { body })
    expect(res.status).toBe(201)
    const order = prisma.purchaseOrder.create.mock.calls[0][0].data
    expect(order).toMatchObject({ tenantId: 'tenant-1', supplierId: 'sup-1', status: 'DRAFT', number: 'PO-RB-20261022-001-01', createdById: 'user-1' })
    expect(order.lines.create).toEqual([{ sellerSku: 'SKU-1', asin: 'B0TEST0001', quantity: 440, currency: 'USD' }])
    expect(prisma.replenishmentAction.createMany.mock.calls[0][0].data[0]).toMatchObject({ action: 'PURCHASE_DRAFT', targetDocType: 'PURCHASE_ORDER', targetDocId: 'po-1', finalQty: 440 })
    expect(res.json.data).toMatchObject({ state: 'DONE', documents: [{ type: 'PURCHASE_ORDER', id: 'po-1', lineCount: 1 }] })

    await harness.close()
    harness = await createTestApp(
      stubs([...PLAN, 'purchase.order.write'], {
        replenishmentRecommendation: { findMany: recFound },
        replenishmentAction: { createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([{ recommendationId: 'r1' }]) },
      }),
    )
    expect((await harness.call('POST', '/replenishment/to-purchase-draft', { body })).status).toBe(409)
  })

  it('采购单草稿：缺少采购单权限 403；供应商不存在 404；采购量为 0 且未填数量 422', async () => {
    harness = await createTestApp(stubs(PLAN))
    expect((await harness.call('POST', '/replenishment/to-purchase-draft', { body: { batchId: 'b1', items: [{ recommendationId: 'r1' }], supplierId: 'sup-1' } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(stubs([...PLAN, 'purchase.order.write'], { replenishmentRecommendation: { findMany: vi.fn().mockResolvedValue([recRow({ purchaseQty: 0 })]) } }))
    expect((await harness.call('POST', '/replenishment/to-purchase-draft', { body: { batchId: 'b1', items: [{ recommendationId: 'r1' }], supplierId: 'sup-1' } })).status).toBe(422)
    await harness.close()
    harness = await createTestApp(stubs([...PLAN, 'purchase.order.write'], { supplier: { findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('POST', '/replenishment/to-purchase-draft', { body: { batchId: 'b1', items: [{ recommendationId: 'r1' }], supplierId: 'nope' } })).status).toBe(404)
  })

  it('上游仓储草稿：真实创建本地草稿订单（不调用亚马逊），登记动作并指向订单；缺订单写权限 403；已生成过 409', async () => {
    const created = { id: 'awd-1', externalReferenceId: 'NOVA-AAAA' }
    const prisma = stubs([...PLAN, 'awd.order.write'], { replenishmentRecommendation: { findMany: recFound }, awdInboundOrder: { create: vi.fn().mockResolvedValue(created) } })
    harness = await createTestApp(prisma)
    const body = { batchId: 'b1', items: [{ recommendationId: 'r1', qty: 120 }] }
    const res = await harness.call('POST', '/replenishment/to-awd-draft', { body })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ state: 'DONE', actions: 1, documents: [{ type: 'AWD_ORDER', id: 'awd-1', number: 'NOVA-AAAA', lineCount: 1 }] })
    expect(prisma.awdInboundOrder.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      status: 'LOCAL_DRAFT',
      expectedUnits: 120,
      createdBy: 'user-1',
      draftJson: { source: 'REPLENISHMENT', batchId: 'b1', batchNo: 'RB-20261022-001', items: [{ sku: 'SKU-1', qty: 120 }] },
    })
    expect(prisma.replenishmentAction.createMany.mock.calls[0][0].data[0]).toMatchObject({ action: 'AWD_DRAFT', targetDocType: 'AWD_ORDER', targetDocId: 'awd-1', finalQty: 120 })
    expect(harness.queue.add).not.toHaveBeenCalled()

    await harness.close()
    harness = await createTestApp(stubs(PLAN, { replenishmentRecommendation: { findMany: recFound } }))
    expect((await harness.call('POST', '/replenishment/to-awd-draft', { body })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(
      stubs([...PLAN, 'awd.order.write'], {
        replenishmentRecommendation: { findMany: recFound },
        replenishmentAction: { createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([{ recommendationId: 'r1' }]) },
      }),
    )
    expect((await harness.call('POST', '/replenishment/to-awd-draft', { body })).status).toBe(409)
  })
})

describe('模拟', () => {
  const trend = { kind: 'TREND', sellerAccountId: 's1', sku: 'SKU-1' }

  it('库存走势：三条曲线、断货区间与假设；自定义补货独立成线', async () => {
    harness = await createTestApp(stubs(READ))
    const { data } = (await harness.call('POST', '/replenishment/simulate', { body: { ...trend, customQty: 500, customArriveInDays: 20 } })).json
    expect(data).toMatchObject({ kind: 'TREND', state: 'OK' })
    expect(data.points).toHaveLength(91)
    expect(data.points[20].custom).not.toBeNull()
    expect(data.assumptions.length).toBe(3)
    expect(data.stockouts.none.length).toBeGreaterThan(0)
  })

  it('库存走势：SKU 不存在 404；店铺不在范围内 403；参数不合法 422', async () => {
    harness = await createTestApp(stubs(READ, { fbaInventoryRecord: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } }))
    expect((await harness.call('POST', '/replenishment/simulate', { body: trend })).status).toBe(404)
    expect((await harness.call('POST', '/replenishment/simulate', { body: { kind: 'TREND', sku: '' } })).status).toBe(422)
    await harness.close()
    harness = await createTestApp(
      stubs(READ, {
        sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's2', displayName: '店铺二' }]) },
        membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's2' }]) },
      }),
    )
    expect((await harness.call('POST', '/replenishment/simulate', { body: trend })).status).toBe(403)
  })

  it('上游仓储经济模拟：需要 plan.create；没有授权连接 409；成功创建运行与同步任务并入队', async () => {
    const awd = { kind: 'AWD', sellerAccountId: 's1', sku: 'SKU-1', quantity: 500, endInDays: 30 }
    harness = await createTestApp(stubs(READ))
    expect((await harness.call('POST', '/replenishment/simulate', { body: awd })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(stubs(PLAN, { platformConnection: { findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('POST', '/replenishment/simulate', { body: awd })).status).toBe(409)
    await harness.close()
    const prisma = stubs(PLAN, {
      platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1' }) },
      economicsSimulationRun: { create: vi.fn().mockResolvedValue({ id: 'run-1' }), update: vi.fn().mockResolvedValue({}) },
      syncJob: { create: vi.fn().mockResolvedValue({ id: 'job-1', priority: 1 }) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/replenishment/simulate', { body: awd })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ kind: 'AWD', runId: 'run-1', status: 'PENDING', result: null, input: { quantity: 500, sku: 'SKU-1', startDate: '2026-10-22', endDate: '2026-11-21' } })
    expect(prisma.syncJob.create.mock.calls[0][0].data).toMatchObject({
      type: 'DATA_KIOSK_QUERY',
      context: { dataset: 'dk.economics-simulation', params: { runId: 'run-1', sku: 'SKU-1', quantity: '500' } },
    })
    expect(harness.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ syncJobId: 'job-1' }), 'job-1', expect.objectContaining({ type: 'DATA_KIOSK_QUERY' }))
  })

  it('轮询：排队中、完成（带官方估算值）、失败三种状态；记录不存在 404', async () => {
    const run = (jobStatus: string, resultJson: unknown) => ({
      id: 'run-1',
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      syncJobId: 'job-1',
      startDate: day('2026-10-22'),
      endDate: day('2026-11-21'),
      inputJson: { quantity: 500, sku: 'SKU-1', startDate: '2026-10-22', endDate: '2026-11-21' },
      resultJson,
      _job: jobStatus,
    })
    for (const [status, expected] of [
      ['RUNNING', 'PENDING'],
      ['SUCCEEDED', 'DONE'],
      ['FAILED', 'FAILED'],
    ] as const) {
      const row = run(status, { currency: 'USD', sales: 100, fees: 30, netProceeds: 70, rows: 3 })
      harness = await createTestApp(stubs(READ, { economicsSimulationRun: { findFirst: vi.fn().mockResolvedValue(row) }, syncJob: { findFirst: vi.fn().mockResolvedValue({ status }) } }))
      const { data } = (await harness.call('GET', '/replenishment/simulations/run-1')).json
      expect(data.status).toBe(expected)
      expect(data.result).toEqual(expected === 'DONE' ? { currency: 'USD', sales: 100, fees: 30, netProceeds: 70, rows: 3 } : null)
      await harness.close()
    }
    harness = await createTestApp(stubs(READ, { economicsSimulationRun: { findFirst: vi.fn().mockResolvedValue(null) } }))
    expect((await harness.call('GET', '/replenishment/simulations/none')).status).toBe(404)
  })
})

describe('结果回看', () => {
  it('没有可评估的建议（到仓不足 7 天）：不写结果，如实说明', async () => {
    const prisma = stubs(PLAN, { replenishmentRecommendation: { findMany: vi.fn().mockResolvedValue([recRow()]) } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/replenishment/batches/b1/evaluate')
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ evaluated: 0, skipped: 1 })
    expect(res.json.data.note).toContain('没有可评估的建议')
  })

  it('已到仓的建议：用冻结日销对照实际销量，写入预测误差', async () => {
    const early = recRow({ shipmentsJson: [{ mode: 'SEA', qty: 440, orderDate: '2026-10-01', shipDate: null, arriveDate: '2026-10-05', leadDays: 4, lateDays: 0, unitCost: null }] })
    const summaries = Array.from({ length: 21 }, (_, index) => ({
      sellerAccountId: 's1',
      asin: 'B0TEST0001',
      summaryDate: day(`2026-10-${String(1 + index).padStart(2, '0')}`),
      units: 8,
      inventoryAvailable: index > 17 ? 0 : 100,
    }))
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = stubs(PLAN, {
      replenishmentBatch: { findFirst: vi.fn().mockResolvedValue(batchRow({ today: day('2026-10-01') })) },
      replenishmentRecommendation: { findMany: vi.fn().mockResolvedValue([early]) },
      asinDailySummary: { findMany: vi.fn().mockResolvedValue(summaries), groupBy: vi.fn() },
      fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', sellerSku: 'SKU-1', fulfillableQuantity: 500 }]) },
      replenishmentOutcome: { upsert },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/replenishment/batches/b1/evaluate')
    expect(res.json.data).toMatchObject({ evaluated: 1, skipped: 0 })
    const data = upsert.mock.calls[0][0].create
    // 窗口 10-01 至 10-21 共 21 天：预测 10 × 21 = 210，实际 8 × 21 = 168，误差 +25%
    expect(data).toMatchObject({ recommendationId: 'r1', forecastQty: 210, actualQty: 168, errorPct: '0.2500', stockoutDays: 3, excessUnits: 500 - Math.floor(8 * 60) })
  })
})
