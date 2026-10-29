import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 词级中心接口（P3-10）：未登录、权限、参数校验顺序、筛选与页签组合、固定页签接口、没有写接口。数据读取与数据范围的真实行为见 testing/ad-terms.db.test.ts（真实数据库）。

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

const PATHS = ['/ads/terms', '/ads/terms/roots', '/ads/terms/detail?term=yoga', '/ads/negatives']

describe('词级中心接口：登录与权限', () => {
  it('未登录 401；没有 ads.read 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    for (const path of PATHS) {
      expect((await harness.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await harness.call('GET', path)).status, path).toBe(403)
    }
  })

  it('权限先于参数校验：没有权限的人带着不合法参数也只拿 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/terms?tab=nope&sort=profit:desc')).status).toBe(403)
    expect((await harness.call('GET', '/ads/terms/roots?sort=nope:asc')).status).toBe(403)
    expect((await harness.call('GET', '/ads/terms/detail')).status).toBe(403)
  })
})

describe('词级中心接口：参数校验', () => {
  it('有权限时不合法的页签、排序、筛选与未声明的参数是 422', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    const paths = [
      '/ads/terms?tab=nope',
      '/ads/terms?sort=profit:desc',
      '/ads/terms?anomaly=NOPE',
      '/ads/terms?unknown=1',
      '/ads/terms/roots?sort=nope:asc',
      '/ads/terms/roots?tab=targets',
      '/ads/terms/detail',
      '/ads/terms/detail?term=',
    ]
    for (const path of paths) {
      expect((await harness.call('GET', path)).status, path).toBe(422)
    }
  })

  it('不适用于当前页签的筛选直接拒绝（不静默忽略）', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    const bad = [
      '/ads/terms?tab=targets&anomaly=ADD_KEYWORD',
      '/ads/terms?tab=targets&status=TARGETED',
      '/ads/terms?tab=search-terms&level=CAMPAIGN',
      '/ads/terms?tab=search-terms&matchType=EXACT',
      '/ads/terms?tab=targets&subject=targets',
      '/ads/terms?tab=quadrant&anomaly=HIGH_SPEND_NO_ORDER',
      '/ads/negatives?anomaly=SCALE_UP',
    ]
    for (const path of bad) {
      const res = await harness.call('GET', path)
      expect(res.status, path).toBe(422)
      expect(res.json.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('固定页签的接口不接受别的 tab', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', '/ads/negatives?tab=targets')).status).toBe(422)
  })
})

describe('词级中心接口：写动作在 P3-17 接入', () => {
  it('添加否定投放、添加关键词：没有各自的写权限 403（先于参数校验），有权限但参数不合法 422；旧的词级下钻接口仍然不存在', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('POST', '/ads/negatives', { body: { entityId: 'g1', text: 'x', level: 'AD_GROUP', matchType: 'NEGATIVE_EXACT' } })).status).toBe(403)
    expect((await harness.call('POST', '/ads/keywords', { body: { entityId: 'g1', text: 'x', matchType: 'EXACT' } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['ads.read', 'ads.negative.write', 'ads.keyword.write']))
    expect((await harness.call('POST', '/ads/negatives', { body: { expression: 'x' } })).status).toBe(422)
    expect((await harness.call('POST', '/ads/keywords', { body: { text: 'x' } })).status).toBe(422)
    expect((await harness.call('GET', '/analytics/ad-terms')).status).toBe(404)
  })
})
