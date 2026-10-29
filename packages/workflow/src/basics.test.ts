import { describe, expect, it } from 'vitest'
import { backoffDelayMs, classifyError, LockLostError, NonRetryableError, PRIORITY, priorityForTrigger, RetryableError } from './index'

describe('错误分类', () => {
  it('显式声明的可重试/不可重试错误按声明处理', () => {
    expect(classifyError(new RetryableError('X', 'x', 3000))).toEqual({ retryable: true, code: 'X', retryAfterMs: 3000 })
    expect(classifyError(new NonRetryableError('Y', 'y'))).toEqual({ retryable: false, code: 'Y', retryAfterMs: undefined })
    expect(classifyError(new LockLostError('k')).retryable).toBe(true)
  })

  it('限流与服务端错误可重试，其余客户端错误不可重试', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(classifyError({ status }).retryable, String(status)).toBe(true)
    for (const status of [400, 401, 403, 404, 409, 422]) expect(classifyError({ status }).retryable, String(status)).toBe(false)
    expect(classifyError({ response: { status: 503 } })).toMatchObject({ retryable: true, code: 'HTTP_503' })
  })

  it('读取 Retry-After（普通对象与 Headers 对象）', () => {
    expect(classifyError({ status: 429, headers: { 'retry-after': '7' } }).retryAfterMs).toBe(7000)
    expect(classifyError({ status: 429, response: { headers: new Headers({ 'Retry-After': '2' }) } }).retryAfterMs).toBe(2000)
  })

  it('网络错误、超时、数据库瞬时错误可重试；未知错误不重试', () => {
    expect(classifyError({ code: 'ECONNRESET' })).toMatchObject({ retryable: true, code: 'NETWORK_ECONNRESET' })
    expect(classifyError({ code: 'P2034' })).toMatchObject({ retryable: true, code: 'DB_P2034' })
    expect(classifyError({ code: 'P2002' }).retryable).toBe(false)
    expect(classifyError(Object.assign(new Error('t'), { name: 'AbortError' }))).toMatchObject({ retryable: true, code: 'TIMEOUT' })
    expect(classifyError(new TypeError('bug'))).toEqual({ retryable: false, code: 'UNEXPECTED_ERROR' })
    expect(classifyError('字符串')).toEqual({ retryable: false, code: 'UNEXPECTED_ERROR' })
  })
})

describe('指数退避与抖动', () => {
  it('不抖动时严格指数增长并封顶', () => {
    const options = { baseMs: 1000, factor: 2, maxMs: 10_000, jitter: 0 }
    expect([1, 2, 3, 4, 5, 6].map(attempt => backoffDelayMs(attempt, options))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000])
  })

  it('抖动让延迟落在 [50%, 100%] 区间，且可注入随机源保证可测', () => {
    const base = { baseMs: 1000, jitter: 0.5, maxMs: 60_000 }
    expect(backoffDelayMs(3, { ...base, rng: () => 0 })).toBe(2000)
    expect(backoffDelayMs(3, { ...base, rng: () => 1 })).toBe(4000)
    for (let i = 0; i < 200; i++) {
      const delay = backoffDelayMs(3, base)
      expect(delay).toBeGreaterThanOrEqual(2000)
      expect(delay).toBeLessThanOrEqual(4000)
    }
  })

  it('尊重亚马逊要求的最短等待', () => {
    expect(backoffDelayMs(1, { baseMs: 1000, jitter: 0 }, 9000)).toBe(9000)
  })
})

describe('优先级', () => {
  it('用户触发 > 推送增量 > 定时 > 历史回补', () => {
    expect(PRIORITY.USER_TRIGGERED).toBeLessThan(PRIORITY.PUSH_INCREMENT)
    expect(PRIORITY.PUSH_INCREMENT).toBeLessThan(PRIORITY.SCHEDULED)
    expect(PRIORITY.SCHEDULED).toBeLessThan(PRIORITY.BACKFILL)
    expect(priorityForTrigger('manual')).toBe(1)
    expect(priorityForTrigger('push')).toBe(2)
    expect(priorityForTrigger(undefined)).toBe(3)
    expect(priorityForTrigger('backfill')).toBe(4)
  })
})
