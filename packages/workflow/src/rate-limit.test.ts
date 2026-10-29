import { describe, expect, it } from 'vitest'
import { MemoryConcurrencyGate, MemoryRateLimiter, rateSignalFromResponse, RateLimitWaitExceeded, waitForToken } from './index'

const defaults = { ratePerSecond: 2, burst: 2, minRatePerSecond: 0.1, maxRatePerSecond: 10 }

describe('店铺级令牌桶', () => {
  it('突发量用完后需要等待，时间推进后恢复', async () => {
    let now = 1_000_000
    const limiter = new MemoryRateLimiter(defaults, () => now)
    expect(await limiter.acquire('shop-a')).toBe(0)
    expect(await limiter.acquire('shop-a')).toBe(0)
    expect(await limiter.acquire('shop-a')).toBe(500) // 速率 2/秒 → 补一个令牌需要 500 毫秒
    now += 500
    expect(await limiter.acquire('shop-a')).toBe(0)
  })

  it('不同店铺互不影响', async () => {
    const limiter = new MemoryRateLimiter(defaults, () => 1)
    await limiter.acquire('shop-a')
    await limiter.acquire('shop-a')
    expect(await limiter.acquire('shop-a')).toBeGreaterThan(0)
    expect(await limiter.acquire('shop-b')).toBe(0)
  })

  it('按亚马逊响应头动态调整速率', async () => {
    const limiter = new MemoryRateLimiter(defaults, () => 1)
    await limiter.report('shop-a', rateSignalFromResponse(200, { 'x-amzn-RateLimit-Limit': '0.5' }))
    expect(limiter.snapshot('shop-a').rate).toBe(0.5)
    await limiter.report('shop-a', rateSignalFromResponse(200, new Headers({ 'x-amzn-ratelimit-limit': '50' })))
    expect(limiter.snapshot('shop-a').rate).toBe(10) // 不超过自身保护上限
  })

  it('收到 429 立刻降速一半并冻结，冻结期内一律等待', async () => {
    let now = 5_000
    const limiter = new MemoryRateLimiter(defaults, () => now)
    await limiter.report('shop-a', { status: 429, retryAfterMs: 3000 })
    expect(limiter.snapshot('shop-a').rate).toBe(1)
    expect(await limiter.acquire('shop-a')).toBe(3000)
    now += 3000
    expect(await limiter.acquire('shop-a')).toBeGreaterThanOrEqual(0)
  })

  it('等待超过上限时抛出可重试错误，不无限阻塞', async () => {
    const limiter = new MemoryRateLimiter({ ...defaults, ratePerSecond: 0.1, burst: 1 }, () => 1)
    await limiter.acquire('shop-a')
    const slept: number[] = []
    await expect(
      waitForToken(limiter, 'shop-a', {
        maxWaitMs: 1000,
        sleep: async ms => {
          slept.push(ms)
        },
      }),
    ).rejects.toBeInstanceOf(RateLimitWaitExceeded)
    expect(slept).toEqual([])
  })

  it('响应头解析大小写不敏感，缺失时无信号', () => {
    expect(rateSignalFromResponse(200, { 'X-Amzn-RateLimit-Limit': '1.5', 'Retry-After': '4' })).toEqual({ status: 200, limitPerSecond: 1.5, retryAfterMs: 4000 })
    expect(rateSignalFromResponse(200, {})).toEqual({ status: 200, limitPerSecond: undefined, retryAfterMs: undefined })
    expect(rateSignalFromResponse(undefined, undefined).limitPerSecond).toBeUndefined()
  })
})

describe('租户公平并发门', () => {
  it('同一租户超过上限被拒绝，释放后可再占；其他租户不受影响', async () => {
    const gate = new MemoryConcurrencyGate(2)
    const a1 = await gate.tryAcquire('t1')
    const a2 = await gate.tryAcquire('t1')
    expect(a1).not.toBeNull()
    expect(a2).not.toBeNull()
    expect(await gate.tryAcquire('t1')).toBeNull()
    expect(await gate.tryAcquire('t2')).not.toBeNull()
    await a1!()
    await a1!() // 重复释放无副作用
    expect(gate.active('t1')).toBe(1)
    expect(await gate.tryAcquire('t1')).not.toBeNull()
  })
})
