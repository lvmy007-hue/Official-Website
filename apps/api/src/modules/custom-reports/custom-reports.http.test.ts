import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 自定义报表（P6-32）：没有 reports.read 时先 403，不因请求体不合法而先返回 422。

let harness: Awaited<ReturnType<typeof createTestApp>>
afterEach(async () => {
  await harness?.close()
})

describe('自定义报表权限', () => {
  it('没有 reports.read 时，查询、校验、创建都是 403', async () => {
    harness = await createTestApp(sessionStub(['orders.read']))
    const bad = { dimension: '', metrics: [] }
    expect((await harness.call('POST', '/report-sources/product-performance/query', { body: bad })).status).toBe(403)
    expect((await harness.call('POST', '/custom-metrics/validate', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/custom-metrics', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/custom-reports', { body: {} })).status).toBe(403)
    expect((await harness.call('GET', '/report-sources')).status).toBe(403)
  })

  it('有 reports.read 但没有数据源权限时，查询在校验请求体之前 403', async () => {
    harness = await createTestApp(sessionStub(['reports.read']))
    const res = await harness.call('POST', '/report-sources/product-performance/query', { body: { dimension: '' } })
    expect(res.status).toBe(403)
  })

  it('未知数据源在有 reports.read 时是 404', async () => {
    harness = await createTestApp(sessionStub(['reports.read', 'analytics.read']))
    const res = await harness.call('POST', '/report-sources/missing/query', { body: { dimension: 'asin', metrics: ['sales'] } })
    expect(res.status).toBe(404)
  })
})
