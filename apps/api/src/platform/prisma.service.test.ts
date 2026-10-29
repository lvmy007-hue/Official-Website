import { describe, expect, it } from 'vitest'
import { DEFAULT_SLOW_QUERY_MS, slowQueryThreshold, toSlowQueryRecord } from './prisma.service'

describe('慢查询告警', () => {
  it('默认阈值 1 秒，可用环境变量调整，非法值回到默认', () => {
    expect(slowQueryThreshold({})).toBe(DEFAULT_SLOW_QUERY_MS)
    expect(slowQueryThreshold({ SLOW_QUERY_MS: '250' } as never)).toBe(250)
    expect(slowQueryThreshold({ SLOW_QUERY_MS: 'abc' } as never)).toBe(1000)
    expect(slowQueryThreshold({ SLOW_QUERY_MS: '-5' } as never)).toBe(1000)
  })

  it('未超阈值不告警；超过阈值记录耗时与语句', () => {
    const event = { query: 'SELECT  *\n FROM "Order" WHERE "tenantId" = $1', duration: 1200, target: 'quaint::connector::postgres' }
    expect(toSlowQueryRecord({ ...event, duration: 999 }, 1000)).toBeNull()
    expect(toSlowQueryRecord(event, 1000)).toEqual({
      durationMs: 1200,
      thresholdMs: 1000,
      target: 'quaint::connector::postgres',
      statement: 'SELECT * FROM "Order" WHERE "tenantId" = $1',
    })
  })

  it('过长的语句被截断；记录里没有参数字段', () => {
    const record = toSlowQueryRecord({ query: `SELECT ${'x, '.repeat(400)}1`, duration: 5000, target: 't', params: '["buyer@example.com"]' } as never, 1000)!
    expect(record.statement.length).toBeLessThanOrEqual(501)
    expect(Object.keys(record)).not.toContain('params')
    expect(JSON.stringify(record)).not.toContain('buyer@example.com')
  })
})
