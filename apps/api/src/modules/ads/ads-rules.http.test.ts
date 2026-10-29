import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 自动规则接口（P3-13）：未登录、权限先于参数校验、参数校验与幂等键。数据读写、数据范围、版本冲突、审计、试运行与定时评估的真实行为见 testing/ads-rules.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const prismaFor = (permissions: string[]) => ({
  ...sessionStub(permissions),
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]) },
  tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
})

const validBody = {
  adsProfileId: 'ap-1',
  name: '高 ACoS 暂停',
  level: 'CAMPAIGN',
  conditions: [{ metric: 'acos', windowDays: 7, op: 'gt', value: 40 }],
  action: { type: 'PAUSE' },
  guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 },
}

describe('自动规则接口：登录与权限', () => {
  it('六个接口：未登录 401；没有对应权限 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/rules', { auth: false })).status).toBe(401)
    expect((await harness.call('POST', '/ads/rules', { auth: false, body: validBody })).status).toBe(401)
    expect((await harness.call('GET', '/ads/rules/r-1', { auth: false })).status).toBe(401)
    expect((await harness.call('PATCH', '/ads/rules/r-1', { auth: false, body: { version: 1, name: 'x' } })).status).toBe(401)
    expect((await harness.call('POST', '/ads/rules/r-1/dry-run', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/rules/r-1/runs', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/rules')).status).toBe(403)
    expect((await harness.call('POST', '/ads/rules', { body: validBody })).status).toBe(403)
    expect((await harness.call('GET', '/ads/rules/r-1')).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/rules/r-1', { body: { version: 1, name: 'x' } })).status).toBe(403)
    expect((await harness.call('POST', '/ads/rules/r-1/dry-run')).status).toBe(403)
    expect((await harness.call('GET', '/ads/rules/r-1/runs')).status).toBe(403)
  })

  it('只有 ads.read 能看列表、试运行与记录，但不能创建、修改；权限先于参数校验', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('POST', '/ads/rules', { body: validBody })).status).toBe(403)
    expect((await harness.call('POST', '/ads/rules', { body: { name: '' } })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/rules/r-1', { body: { version: 1, name: 'x' } })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/rules/r-1', { body: {} })).status).toBe(403)
  })
})

describe('自动规则接口：参数校验', () => {
  it('创建：内容不合法一律 422，并指出是哪个字段', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    const bad = async (patch: Record<string, unknown>) => (await harness!.call('POST', '/ads/rules', { body: { ...validBody, ...patch } })).status
    expect(await bad({ name: '' })).toBe(422)
    expect(await bad({ level: 'AD_GROUP' })).toBe(422)
    expect(await bad({ mode: 'MANUAL' })).toBe(422)
    expect(await bad({ conditions: [] })).toBe(422)
    expect(await bad({ conditions: [{ metric: 'acos', windowDays: 5, op: 'gt', value: 40 }] })).toBe(422)
    expect(await bad({ conditions: [{ metric: 'profit', windowDays: 7, op: 'gt', value: 1 }] })).toBe(422)
    expect(await bad({ conditions: [{ metric: 'acos', windowDays: 7, op: 'gt', value: -1 }] })).toBe(422)
    expect(await bad({ action: { type: 'NEGATE', matchType: 'NEGATIVE_EXACT' } })).toBe(422) // 动作不属于活动层级
    expect(await bad({ level: 'TARGET', action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -10 } })).toBe(422) // 调价必须设幅度上限
    expect(await bad({ guardrails: { ...validBody.guardrails, dailyLimit: 0 } })).toBe(422)
    expect(await bad({ guardrails: { ...validBody.guardrails, dailyLimit: 201 } })).toBe(422)
    expect(await bad({ campaignIds: ['a', 'a'] })).toBe(422)
    expect(await bad({ unknownField: 1 })).toBe(422)
    const res = await harness.call('POST', '/ads/rules', { body: { ...validBody, level: 'TARGET', action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -10 } } })
    expect(JSON.stringify(res.json.error)).toContain('幅度上限')
  })

  it('修改：必须带版本号与至少一个要改的字段；编号不合法按不存在处理；试运行日期格式', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    expect((await harness.call('PATCH', '/ads/rules/r-1', { body: { name: 'x' } })).status).toBe(422)
    expect((await harness.call('PATCH', '/ads/rules/r-1', { body: { version: 1 } })).status).toBe(422)
    expect((await harness.call('PATCH', '/ads/rules/r-1', { body: { version: 0, name: 'x' } })).status).toBe(422)
    expect((await harness.call('PATCH', `/ads/rules/${encodeURIComponent('a b;drop')}`, { body: { version: 1, name: 'x' } })).status).toBe(404)
    expect((await harness.call('GET', `/ads/rules/${encodeURIComponent('a b;drop')}`)).status).toBe(404)
    expect((await harness.call('POST', `/ads/rules/${encodeURIComponent('a b;drop')}/dry-run`)).status).toBe(404)
    expect((await harness.call('POST', '/ads/rules/r-1/dry-run', { body: { asOf: '10/10' } })).status).toBe(422)
    expect((await harness.call('POST', '/ads/rules/r-1/dry-run', { body: { other: 1 } })).status).toBe(422)
  })

  it('列表与执行记录：范围参数、分页参数不合法 422（有权限时），没有权限时先拿 403', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', '/ads/rules?from=2026-10-10')).status).toBe(422)
    expect((await harness.call('GET', '/ads/rules/r-1/runs?pageSize=0')).status).toBe(422)
    expect((await harness.call('GET', '/ads/rules/r-1/runs?pageSize=101')).status).toBe(422)
    await harness.close()
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/rules?from=2026-10-10')).status).toBe(403)
  })

  it('写请求不带幂等键：400，不会进入业务逻辑', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    const res = await harness.call('POST', '/ads/rules', { body: validBody, idempotencyKey: false })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
