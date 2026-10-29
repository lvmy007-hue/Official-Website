import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import * as metrics from '../../platform/observability/metrics'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
  vi.restoreAllMocks()
})

describe('前端性能埋点上报', () => {
  it('登录即可上报；指标名、耗时与归一后的路由模板写入指标，不含具体编号', async () => {
    const spy = vi.spyOn(metrics, 'recordWebVital').mockImplementation(() => undefined)
    harness = await createTestApp({ ...sessionStub([]) })
    const res = await harness.call('POST', '/telemetry/web-vitals', {
      body: {
        items: [
          { name: 'LCP', valueMs: 1800, route: '/app/orders/ckabcdefghij1234567890' },
          { name: 'API', valueMs: 42, route: '/orders' },
        ],
      },
    })
    expect(res.status).toBe(201)
    expect(res.json.data).toEqual({ accepted: 2 })
    expect(spy.mock.calls).toEqual([
      ['LCP', 1800, '/app/orders/:id'],
      ['API', 42, '/orders'],
    ])
  })

  it('没有登录凭证返回 401', async () => {
    harness = await createTestApp({})
    const res = await harness.call('POST', '/telemetry/web-vitals', { auth: false, body: { items: [{ name: 'FCP', valueMs: 1, route: '/app' }] } })
    expect(res.status).toBe(401)
  })

  it.each([
    ['未知指标名', { items: [{ name: 'CLS', valueMs: 1, route: '/app' }] }],
    ['耗时为负数', { items: [{ name: 'LCP', valueMs: -1, route: '/app' }] }],
    ['路由含空格与中文（可能夹带个人信息）', { items: [{ name: 'LCP', valueMs: 1, route: '/app/张三 的店' }] }],
    ['多出未约定的字段（如用户邮箱）', { items: [{ name: 'LCP', valueMs: 1, route: '/app', email: 'a@b.cn' }] }],
    ['空列表', { items: [] }],
    ['超过 30 条', { items: Array.from({ length: 31 }, () => ({ name: 'API', valueMs: 1, route: '/a' })) }],
  ])('拒绝：%s', async (_name, body) => {
    const spy = vi.spyOn(metrics, 'recordWebVital').mockImplementation(() => undefined)
    harness = await createTestApp({ ...sessionStub([]) })
    const res = await harness.call('POST', '/telemetry/web-vitals', { body })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(spy).not.toHaveBeenCalled()
  })
})
