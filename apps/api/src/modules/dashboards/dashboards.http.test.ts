import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 自定义仪表盘（P6-33）：没有 dashboard.write 时先 403，不因请求体不合法而先返回 422。

let harness: Awaited<ReturnType<typeof createTestApp>>
afterEach(async () => {
  await harness?.close()
})

describe('自定义仪表盘权限', () => {
  it('没有 dashboard.write 时，创建仪表盘、文件夹和组件都是 403', async () => {
    harness = await createTestApp(sessionStub(['orders.read']))
    expect((await harness.call('POST', '/dashboards', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/dashboards', { body: { shared: true } })).status).toBe(403)
    expect((await harness.call('POST', '/dashboards/folders', { body: {} })).status).toBe(403)
    expect((await harness.call('POST', '/dashboards/x/widgets', { body: {} })).status).toBe(403)
    expect((await harness.call('PUT', '/dashboards/x', { body: { name: '' } })).status).toBe(403)
    expect((await harness.call('DELETE', '/dashboards/x')).status).toBe(403)
  })

  it('有写入权限但没有共享权限时，把仪表盘标成共享在校验请求体之前 403', async () => {
    harness = await createTestApp(sessionStub(['dashboard.write']))
    const res = await harness.call('POST', '/dashboards', { body: { shared: true } })
    expect(res.status).toBe(403)
  })
})
