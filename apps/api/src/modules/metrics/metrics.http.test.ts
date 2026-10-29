import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('指标口径接口', () => {
  it('登录成员即可查看（不需要权限点）：返回分页、板块与类型；变更历史如实为空', async () => {
    harness = await createTestApp(sessionStub([]))
    const res = await harness.call('GET', '/metrics/definitions?pageSize=5')
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data.total).toBe(217)
    expect(data.items).toHaveLength(5)
    expect(data.pageSize).toBe(5)
    expect(data.groups.length).toBeGreaterThan(0)
    expect(data.items.every((item: { history: unknown[] }) => Array.isArray(item.history) && item.history.length === 0)).toBe(true)
  })

  it('关键字搜索缩小范围；没有匹配时返回空列表而不是报错', async () => {
    harness = await createTestApp(sessionStub([]))
    const all = (await harness.call('GET', '/metrics/definitions')).json.data.total
    const some = (await harness.call('GET', '/metrics/definitions?q=ACOS')).json.data
    expect(some.total).toBeGreaterThan(0)
    expect(some.total).toBeLessThan(all)
    const none = (await harness.call('GET', '/metrics/definitions?q=zzzz-不存在的指标')).json.data
    expect(none).toMatchObject({ total: 0, items: [] })
  })

  it('每条口径都带三个字段：对账页面、数字对不上的原因、可配置位置（P6-03）', async () => {
    harness = await createTestApp(sessionStub([]))
    const items = (await harness.call('GET', '/metrics/definitions?pageSize=100')).json.data.items as Array<{
      reconcileWith: Array<{ label: string; route: string }>
      mismatchReasons: string[]
      configurableAt: { label: string; route: string } | null
    }>
    expect(items.length).toBe(100)
    for (const item of items) {
      expect(Array.isArray(item.reconcileWith)).toBe(true)
      expect(Array.isArray(item.mismatchReasons)).toBe(true)
      expect(item.configurableAt === null || item.configurableAt.route.startsWith('/app/')).toBe(true)
    }
    expect(items.some(item => item.reconcileWith.length > 0 && item.mismatchReasons.length > 0)).toBe(true)
  })

  it('按编号取：列头问号只取自己要的几条；超过 50 个只取前 50 个', async () => {
    harness = await createTestApp(sessionStub([]))
    const some = (await harness.call('GET', '/metrics/definitions?ids=M-001,M-002')).json.data
    expect(some.items.map((item: { id: string }) => item.id).sort()).toEqual(['M-001', 'M-002'])
    const none = (await harness.call('GET', '/metrics/definitions?ids=M-9999')).json.data
    expect(none).toMatchObject({ total: 0, items: [] })
  })

  it('可用于规则的指标（P6-07）：每条口径带 ruleUse；ruleUsable=true 只返回登记过的，五个域都有；写错取值返回 422', async () => {
    harness = await createTestApp(sessionStub([]))
    const all = (await harness.call('GET', '/metrics/definitions?pageSize=100')).json.data.items as Array<{ ruleUse: unknown }>
    expect(all.every(item => item.ruleUse === null || typeof item.ruleUse === 'object')).toBe(true)
    const usable = (await harness.call('GET', '/metrics/definitions?ruleUsable=true&pageSize=100')).json.data
    expect(usable.total).toBe(20)
    const items = usable.items as Array<{ id: string; ruleUse: { domain: string; unit: string; aggs: string[] } }>
    expect(new Set(items.map(item => item.ruleUse.domain))).toEqual(new Set(['sales', 'ads', 'inventory', 'profit', 'aftersales']))
    expect(items.find(item => item.id === 'M-501')?.ruleUse).toEqual({ domain: 'ads', unit: 'percent', aggs: ['avg', 'last', 'min', 'max'] })
    expect(items.every(item => item.ruleUse.unit !== 'percent' || !item.ruleUse.aggs.includes('sum'))).toBe(true)
    expect((await harness.call('GET', '/metrics/definitions?ruleUsable=false')).status).toBe(422)
  })

  it('每页条数超过上限返回 422；未登录返回 401', async () => {
    harness = await createTestApp(sessionStub([]))
    expect((await harness.call('GET', '/metrics/definitions?pageSize=1000')).status).toBe(422)
    expect((await harness.call('GET', '/metrics/definitions', { auth: false })).status).toBe(401)
  })
})
