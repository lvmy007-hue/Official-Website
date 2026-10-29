import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('健康检查', () => {
  it('数据库与队列都可用时返回 ok，无需登录', async () => {
    harness = await createTestApp({ $queryRaw: vi.fn().mockResolvedValue([1]) })
    const res = await harness.call('GET', '/health', { auth: false })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ status: 'ok', service: 'nova-api', checks: { database: 'ok', redis: 'ok' } })
  })

  it('依赖不可用时返回 503 且标记可重试', async () => {
    harness = await createTestApp({ $queryRaw: vi.fn().mockRejectedValue(new Error('down')) })
    const res = await harness.call('GET', '/health', { auth: false })
    expect(res.status).toBe(503)
    expect(res.json.error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true })
  })
})
