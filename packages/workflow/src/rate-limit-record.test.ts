import { describe, expect, it } from 'vitest'
import { RATE_BUCKET_PREFIX, RedisRateLimiter, TENANT_SLOT_PREFIX, type RedisLike } from './index'

// 令牌桶在 Redis 里的记录（同步中心的限速状态页按这些键与字段读取）：429 时多记“最近一次限速”的时间。

function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>()
  const redis: RedisLike = {
    eval: async () => 0,
    hmget: async (key, ...fields) => fields.map(field => hashes.get(key)?.get(field) ?? null),
    hset: async (key, ...pairs) => {
      const hash = hashes.get(key) ?? new Map<string, string>()
      for (let index = 0; index < pairs.length; index += 2) hash.set(String(pairs[index]), String(pairs[index + 1]))
      hashes.set(key, hash)
      return 1
    },
    pexpire: async () => 1,
  }
  return { redis, hashes }
}

describe('令牌桶的 Redis 记录', () => {
  it('键前缀是同步中心读取用的常量', () => {
    expect(RATE_BUCKET_PREFIX).toBe('ratelimit')
    expect(TENANT_SLOT_PREFIX).toBe('tenant-slots')
  })

  it('收到 429 记下最近一次限速时间；普通响应不写这个字段，也不清掉已有的', async () => {
    const { redis, hashes } = fakeRedis()
    let now = 5_000_000
    const limiter = new RedisRateLimiter(redis, { now: () => now })
    await limiter.report('t:c:orders', { status: 200, limitPerSecond: 2 })
    expect(hashes.get('ratelimit:t:c:orders')?.has('limitedAt')).toBe(false)
    await limiter.report('t:c:orders', { status: 429, retryAfterMs: 2000 })
    const hash = hashes.get('ratelimit:t:c:orders')
    expect(hash?.get('limitedAt')).toBe('5000000')
    expect(Number(hash?.get('blocked'))).toBe(5_002_000)
    now += 60_000
    await limiter.report('t:c:orders', { status: 200, limitPerSecond: 2 })
    expect(hashes.get('ratelimit:t:c:orders')?.get('limitedAt')).toBe('5000000')
  })
})
