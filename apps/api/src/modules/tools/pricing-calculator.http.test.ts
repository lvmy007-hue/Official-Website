import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 新品定价试算（P6-29）：未登录与权限先于参数；超频 429；同样参数不打数据库计数。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const body = { purchaseCost: 5, firstMile: { method: 'NONE', unitPrice: 0 }, lengthCm: 20, widthCm: 15, heightCm: 2, weightG: 200, category: 'STANDARD', prices: [20] }

const open = async (permissions: string[], count = 0) => {
  const pricingCalcRecord = {
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(count),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'r1', name: null, saved: false, createdBy: 'user-1', estimatedAt: new Date('2026-10-29T00:00:00Z'), ...data })),
    update: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  }
  harness = await createTestApp({ ...sessionStub(permissions), pricingCalcRecord, dataFreshness: { findFirst: vi.fn() }, platformConnection: { findFirst: vi.fn() }, syncJob: { create: vi.fn() } })
  return { app: harness, pricingCalcRecord }
}

describe('新品定价试算接口', () => {
  it('未登录 401；没有 tools.read 时 403 且先于参数校验', async () => {
    const { app, pricingCalcRecord } = await open(['products.read'])
    expect((await app.call('POST', '/tools/pricing-calculator/estimate', { auth: false, body })).status).toBe(401)
    expect((await app.call('POST', '/tools/pricing-calculator/estimate', { body: { prices: 'nope' } })).status).toBe(403)
    expect((await app.call('GET', '/tools/pricing-calculator/records?page=0')).status).toBe(403)
    expect(pricingCalcRecord.findFirst).not.toHaveBeenCalled()
    expect(pricingCalcRecord.count).not.toHaveBeenCalled()
  })

  it('新参数超过每分钟 10 次返回 429，不落库', async () => {
    const { app, pricingCalcRecord } = await open(['tools.read'], 10)
    const res = await app.call('POST', '/tools/pricing-calculator/estimate', { body })
    expect(res.status).toBe(429)
    expect(res.json.error.code).toBe('RATE_LIMITED')
    expect(pricingCalcRecord.create).not.toHaveBeenCalled()
  })

  it('没有店铺时按费率表估算，并写明未调用费用预估接口', async () => {
    const { app } = await open(['tools.read'])
    const res = await app.call('POST', '/tools/pricing-calculator/estimate', { body })
    expect(res.status).toBe(200)
    expect(res.json.data.result.amazon.state).toBe('NOT_REQUESTED')
    expect(res.json.data.result.amazon.message).toContain('未选择店铺')
    expect(res.json.data.result.scenarios[0].profit).toBe(7.92)
    expect(res.json.data.result.estimateNote).toContain('模型估算')
  })
})
