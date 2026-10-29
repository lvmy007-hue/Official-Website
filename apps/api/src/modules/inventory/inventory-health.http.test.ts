import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { policyRow, prismaFor, SELLABLE } from './inventory-http.test-helper'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const READ = ['inventory.read']

describe('库存健康接口：权限与参数', () => {
  it('未登录 401；没有 inventory.read 时所有读接口 403，且 403 先于参数校验', async () => {
    harness = await createTestApp(prismaFor(['orders.read']))
    expect((await harness.call('GET', '/inventory', { auth: false })).status).toBe(401)
    for (const path of ['/inventory', '/inventory/summary', '/inventory/rules', '/inventory/inv-1', '/inventory/inv-1/structure', '/inventory/inv-1/ledger', '/inventory?sort=bogus:asc']) {
      expect((await harness.call('GET', path)).status, path).toBe(403)
    }
  })

  it('有权限但参数不合法：422（排序字段、页签不在白名单）', async () => {
    harness = await createTestApp(prismaFor(READ))
    expect((await harness.call('GET', '/inventory?sort=bogus:asc')).status).toBe(422)
    expect((await harness.call('GET', '/inventory?tab=nope')).status).toBe(422)
    expect((await harness.call('GET', '/inventory/inv-1/snapshots?a=oops')).status).toBe(422)
  })

  it('awd 需要 awd.read，replenishment 需要 replenishment.read，仅有 inventory.read 时 403', async () => {
    harness = await createTestApp(prismaFor(READ))
    expect((await harness.call('GET', '/inventory/inv-1/awd')).status).toBe(403)
    expect((await harness.call('GET', '/inventory/inv-1/replenishment')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor([...READ, 'awd.read', 'replenishment.read'], { awdShipmentItem: { findMany: vi.fn().mockResolvedValue([]) } }))
    expect((await harness.call('GET', '/inventory/inv-1/awd')).json.data).toMatchObject({ state: 'NOT_CONNECTED', stock: null, inboundShipments: [] })
    expect((await harness.call('GET', '/inventory/inv-1/replenishment')).status).toBe(200)
  })
})

describe('库存健康：没有配置规则时不判定', () => {
  it('列表有记录但风险为空，并给出“尚未配置库存规则”；没有销量之外的数字不被补成 0', async () => {
    harness = await createTestApp(prismaFor(READ))
    const res = await harness.call('GET', '/inventory')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ total: 1, policyState: 'NOT_CONNECTED', truncated: false })
    expect(res.json.data.policyNote).toContain('尚未配置库存规则')
    const item = res.json.data.items[0]
    expect(item).toMatchObject({ sku: 'SKU-1', storeName: '店铺一', quantity: { sellable: SELLABLE, inboundTotal: 30, inboundCounted: 0 } })
    expect(item.assessment).toMatchObject({ state: 'NOT_CONNECTED', reason: 'NO_POLICY', risk: null, daysOfCover: null })
    expect(item.fees.nextMonthStorage).toBeNull()
    expect(item.age.granularity).toBeNull()
  })

  it('汇总：低库存与冗余卡片“未接入”，不是 0；费用、库龄“尚无记录”', async () => {
    harness = await createTestApp(prismaFor(READ))
    const { data } = (await harness.call('GET', '/inventory/summary')).json
    expect(data.cards.lowSkuCount).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(data.cards.excessSkuCount).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(data.cards.sellableTotal.value).toBe(SELLABLE)
    expect(data.cards.nextMonthStorageFee).toMatchObject({ state: 'NO_DATA', value: null })
    expect(data.cards.ageSurchargeEstimate).toMatchObject({ state: 'NO_DATA', value: null })
  })

  it('规则接口：没有版本时 NOT_CONNECTED', async () => {
    harness = await createTestApp(prismaFor(READ))
    expect((await harness.call('GET', '/inventory/rules')).json.data).toMatchObject({ state: 'NOT_CONNECTED', current: null, history: [] })
  })
})

describe('库存健康：按规则版本计算风险', () => {
  const withPolicy = (permissions = READ) =>
    prismaFor(permissions, { replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(policyRow()), findMany: vi.fn().mockResolvedValue([policyRow()]), create: vi.fn() } })

  it('可售 + 计入在途 130，日销 10：可售天数 13 小于提前期 30 → 高风险，带规则版本', async () => {
    harness = await createTestApp(withPolicy())
    const { data } = (await harness.call('GET', '/inventory')).json
    expect(data.policyState).toBe('OK')
    expect(data.items[0].assessment).toMatchObject({ state: 'OK', risk: 'HIGH', daysOfCover: 13, policyVersion: 1, fastestLeadDays: 30 })
    expect(data.items[0].demand).toMatchObject({ source: 'ORDERS', mid: 10 })
    expect((await harness.call('GET', '/inventory?tab=low')).json.data.total).toBe(1)
    expect((await harness.call('GET', '/inventory?tab=excess')).json.data.total).toBe(0)
    expect((await harness.call('GET', '/inventory?risk=HIGH&q=sku-1')).json.data.total).toBe(1)
    expect((await harness.call('GET', '/inventory?q=没有这个')).json.data.total).toBe(0)
  })

  it('批量搜索 qs：精确匹配 SKU / ASIN / FNSKU，不区分大小写；超过 500 个词、含超长词 422', async () => {
    harness = await createTestApp(withPolicy())
    const total = async (query: string) => (await harness!.call('GET', `/inventory?${query}`)).json.data.total
    expect(await total('qs=SKU-1,另一个,sku-1')).toBe(1)
    expect(await total('qs=SKU,另一个')).toBe(0) // 精确，不是包含
    const tooMany = Array.from({ length: 501 }, (_, index) => `T${index}`).join(',')
    expect((await harness.call('GET', `/inventory?qs=${tooMany}`)).status).toBe(422)
    expect((await harness.call('GET', `/inventory?qs=${'x'.repeat(81)}`)).status).toBe(422)
  })

  it('汇总的低库存卡片按同一份结果计数', async () => {
    harness = await createTestApp(withPolicy())
    const { data } = (await harness.call('GET', '/inventory/summary')).json
    expect(data).toMatchObject({ policyState: 'OK', policyVersion: 1, skuCount: 1 })
    expect(data.cards.lowSkuCount.value).toBe(1)
    expect(data.cards.excessSkuCount.value).toBe(0)
  })

  it('范围收窄到别的店铺时，读取条件带上店铺范围', async () => {
    const prisma = withPolicy()
    prisma.membershipScope.findMany.mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's2' }])
    prisma.sellerAccount.findMany.mockResolvedValue([{ id: 's2', displayName: '店铺二' }])
    harness = await createTestApp(prisma)
    await harness.call('GET', '/inventory')
    expect(prisma.fbaInventoryRecord.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: { in: ['s2'] } })
  })
})

describe('库存规则写入', () => {
  const body = {
    expectedVersionNo: 0,
    leadTimeDays: 30,
    awdLeadTimeDays: null,
    safetyDays: 14,
    coverageDays: 60,
    redundancyMultiplier: 1.5,
    inboundCounted: ['WORKING', 'SHIPPED'],
    agingFromDays: 271,
    changeReason: '首次设置',
  }

  it('没有 replenishment.policy.write：403', async () => {
    harness = await createTestApp(prismaFor(READ))
    expect((await harness.call('PUT', '/inventory/rules', { body })).status).toBe(403)
  })

  it('参数不合法 422：覆盖天数 × 倍数不大于提前期 + 安全库存', async () => {
    harness = await createTestApp(prismaFor(['replenishment.policy.write']))
    expect((await harness.call('PUT', '/inventory/rules', { body: { ...body, coverageDays: 20, redundancyMultiplier: 1 } })).status).toBe(422)
  })

  it('首次保存：版本号 1，写审计与时间线，返回最新版本', async () => {
    const created = policyRow({ versionNo: 1, inboundCounted: ['WORKING', 'SHIPPED'], changeReason: '首次设置', effectiveFrom: new Date() })
    const prisma = prismaFor(['replenishment.policy.write'], {
      replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([created]), create: vi.fn().mockResolvedValue(created) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/inventory/rules', { body })
    expect(res.status).toBe(200)
    expect(prisma.replenishmentPolicy.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 'tenant-1',
      level: 'TENANT',
      levelRef: 'ALL',
      versionNo: 1,
      redundancyMultiplier: '1.50',
      createdBy: 'user-1',
    })
    expect(prisma.entityEvent.create.mock.calls[0][0].data).toMatchObject({ entityType: 'REPLENISHMENT_POLICY', entityId: 'TENANT:ALL', kind: 'rule' })
    expect(prisma.auditEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'REPLENISHMENT_POLICY_VERSIONED' })
    expect(res.json.data.history).toHaveLength(1)
  })

  it('提交时的版本号落后于最新版本：409，不写入', async () => {
    const prisma = prismaFor(['replenishment.policy.write'], {
      replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(policyRow({ versionNo: 2 })), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/inventory/rules', { body })
    expect(res.status).toBe(409)
    expect(prisma.replenishmentPolicy.create).not.toHaveBeenCalled()
  })

  it('生效日期早于今天：422', async () => {
    harness = await createTestApp(prismaFor(['replenishment.policy.write']))
    expect((await harness.call('PUT', '/inventory/rules', { body: { ...body, effectiveFrom: '2020-01-01' } })).status).toBe(422)
  })
})
