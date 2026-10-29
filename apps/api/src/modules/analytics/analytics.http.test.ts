import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('利润与广告词级接口的权限', () => {
  it('利润需要财务读取权限，词级中心需要广告读取权限；旧的词级下钻接口已下线', async () => {
    harness = await createTestApp({ ...sessionStub(['seller.read']) })
    expect((await harness.call('GET', '/profit/overview')).status).toBe(403)
    await harness.close()
    harness = await createTestApp({ ...sessionStub(['finance.read']) })
    expect((await harness.call('GET', '/ads/terms')).status).toBe(403)
    expect((await harness.call('GET', '/analytics/ad-terms')).status).toBe(404)
  })
})
