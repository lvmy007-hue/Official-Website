import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHARE_TREND_DISCLAIMER } from '@nova/api-contracts'
import { createTestApp, sessionStub } from '../../testing/harness'

// 关键词份额趋势（P6-29）：analytics.read 先于参数；没有品牌分析权限时 200 且 RESTRICTED，不查表。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const brandSearchQueryPerformance = { findMany: vi.fn().mockResolvedValue([]) }
  harness = await createTestApp({ ...sessionStub(permissions), brandSearchQueryPerformance })
  return { app: harness, brandSearchQueryPerformance }
}

describe('关键词份额趋势', () => {
  it('没有 analytics.read 时 403，而且先于参数校验', async () => {
    const { app, brandSearchQueryPerformance } = await open(['tools.read'])
    expect((await app.call('GET', '/analytics/brand/share-trend?asin=not-an-asin')).status).toBe(403)
    expect(brandSearchQueryPerformance.findMany).not.toHaveBeenCalled()
  })

  it('只有 analytics.read、没有品牌分析权限：200，写明需要品牌分析权限，不查表', async () => {
    const { app, brandSearchQueryPerformance } = await open(['analytics.read'])
    const res = await app.call('GET', '/analytics/brand/share-trend?asin=B0SHARE001')
    expect(res.status).toBe(200)
    expect(res.json.data.state).toBe('RESTRICTED')
    expect(res.json.data.disclaimer).toBe(SHARE_TREND_DISCLAIMER)
    expect(brandSearchQueryPerformance.findMany).not.toHaveBeenCalled()
  })

  it('ASIN 不合格时 422', async () => {
    const { app } = await open(['analytics.read', 'analytics.brand.read'])
    expect((await app.call('GET', '/analytics/brand/share-trend?asin=short')).status).toBe(422)
  })
})
