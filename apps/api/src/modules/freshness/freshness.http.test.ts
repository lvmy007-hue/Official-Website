import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const NOW = Date.now()
const fresh = (over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  sourceKey: 'orders.api',
  lastAttemptAt: new Date(NOW - 60_000),
  lastSuccessAt: new Date(NOW - 60_000),
  dataThrough: new Date(NOW - 60_000),
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})

function prismaFor(over: Record<string, any> = {}) {
  return {
    ...sessionStub([]),
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  }
}

describe('数据新鲜度接口', () => {
  it('登录成员即可查看（不需要任何权限点）；没有记录时如实返回“尚无记录”', async () => {
    harness = await createTestApp(prismaFor())
    const res = await harness.call('GET', '/freshness')
    expect(res.status).toBe(200)
    expect(res.json.data.storeCount).toBe(2)
    expect(res.json.data.sources.map((item: { sourceKey: string }) => item.sourceKey)).toEqual(['orders.api', 'finance.transactions', 'inventory.api', 'inbound.plan'])
    expect(res.json.data.sources[0]).toMatchObject({ status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null, lagMinutes: null })
    expect(res.json.data.summary).toEqual({ completeness: 0, attention: 4 })
  })

  it('按范围聚合：返回最近成功时间、覆盖店铺数与失败原因（中文，不含内部错误）', async () => {
    const prisma = prismaFor()
    prisma.dataFreshness.findMany.mockResolvedValue([fresh(), fresh({ sellerAccountId: 's2', status: 'UNAUTHORIZED', lastErrorCode: 'AUTH_EXPIRED' })])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/freshness')
    expect(res.json.data.sources[0]).toMatchObject({ status: 'UNAUTHORIZED', coverage: { total: 2, fresh: 1 }, errorCode: 'AUTH_EXPIRED', errorMessage: '亚马逊授权已失效，请重新授权' })
    expect(prisma.dataFreshness.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1' })
  })

  it('受限成员只看到被授权店铺：店铺列表与新鲜度记录都按范围收窄', async () => {
    const prisma = prismaFor({ membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } })
    prisma.sellerAccount.findMany.mockResolvedValue([{ id: 's1' }])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/freshness')
    expect(res.status).toBe(200)
    expect(res.json.data.storeCount).toBe(1)
    expect(prisma.dataFreshness.findMany.mock.calls[0][0].where.sellerAccountId).toEqual({ in: ['s1'] })
  })

  it('没有任何数据授权返回 403；站点不是美国站返回 422；未登录 401', async () => {
    harness = await createTestApp(prismaFor({ membershipScope: { findMany: vi.fn().mockResolvedValue([]) } }))
    expect((await harness.call('GET', '/freshness')).status).toBe(403)
    expect((await harness.call('GET', '/freshness', { auth: false })).status).toBe(401)
    await harness.close()
    harness = await createTestApp(prismaFor())
    expect((await harness.call('GET', '/freshness?marketplaceId=A1F83G8C2ARO7P')).status).toBe(422)
  })
})

describe('指标口径接口', () => {
  it('登录成员即可查看；返回定义、公式、来源、刷新频率、版本与使用页面；变更历史为空而不是编造', async () => {
    harness = await createTestApp(prismaFor())
    const res = await harness.call('GET', '/metrics/definitions?q=M-001')
    expect(res.status).toBe(200)
    expect(res.json.data.items[0]).toMatchObject({ id: 'M-001', name: '销售额（订购口径）', type: '官方', version: 1, history: [] })
    expect(res.json.data.items[0].pages).toContain('经营控制台')
    expect(res.json.data.groups.length).toBeGreaterThan(5)
    expect(res.json.data.types).toEqual(['官方', '我方计算', '模型估算', '导入', '无官方来源', '自定义'])
  })

  it('按类型、板块、关键词筛选并分页；多个关键词为“并且”；参数不合法 422', async () => {
    harness = await createTestApp(prismaFor())
    const all = await harness.call('GET', '/metrics/definitions?pageSize=100')
    expect(all.json.data.total).toBeGreaterThanOrEqual(200)
    expect(all.json.data.items).toHaveLength(100)
    const modelOnly = await harness.call('GET', '/metrics/definitions?type=模型估算&pageSize=100')
    expect(modelOnly.json.data.items.every((item: { type: string }) => item.type === '模型估算')).toBe(true)
    const page2 = await harness.call('GET', '/metrics/definitions?pageSize=10&page=2')
    expect(page2.json.data).toMatchObject({ page: 2, pageSize: 10 })
    expect(page2.json.data.items[0].id).toBe(all.json.data.items[10].id)
    const none = await harness.call('GET', '/metrics/definitions?q=销售额 不存在的词语abc')
    expect(none.json.data.total).toBe(0)
    expect((await harness.call('GET', '/metrics/definitions?type=乱写')).status).toBe(422)
    expect((await harness.call('GET', '/metrics/definitions?pageSize=500')).status).toBe(422)
    expect((await harness.call('GET', '/metrics/definitions', { auth: false })).status).toBe(401)
  })
})
