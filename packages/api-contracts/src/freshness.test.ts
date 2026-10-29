import { describe, expect, it } from 'vitest'
import { aggregateFreshness, effectiveFreshnessStatus, freshnessErrorMessage, freshnessSourceOfDomain, freshnessStatusForFailure, FRESHNESS_SOURCES, type FreshnessRow } from './freshness.js'

const NOW = new Date('2026-10-22T08:00:00Z')
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
const row = (over: Partial<FreshnessRow> = {}): FreshnessRow => ({
  sellerAccountId: 's1',
  sourceKey: 'orders.api',
  lastAttemptAt: minutesAgo(5),
  lastSuccessAt: minutesAgo(5),
  dataThrough: minutesAgo(5),
  status: 'NORMAL',
  lastErrorCode: null,
  ...over,
})
const only = (key: string) => [{ key, label: key, intervalMinutes: 15 }]

describe('新鲜度状态', () => {
  it('记录为正常但数据覆盖时间落后超过同步间隔的 2 倍，按延迟处理；刚好 2 倍以内仍正常', () => {
    expect(effectiveFreshnessStatus(row({ dataThrough: minutesAgo(30) }), 15, NOW)).toBe('NORMAL')
    expect(effectiveFreshnessStatus(row({ dataThrough: minutesAgo(31) }), 15, NOW)).toBe('DELAYED')
    expect(effectiveFreshnessStatus(row({ dataThrough: null, lastSuccessAt: minutesAgo(31) }), 15, NOW)).toBe('DELAYED')
    expect(effectiveFreshnessStatus(row({ dataThrough: null, lastSuccessAt: null }), 15, NOW)).toBe('DELAYED')
  })

  it('非正常状态原样保留，不认识的状态当作失败（不会被误报为正常）', () => {
    expect(effectiveFreshnessStatus(row({ status: 'UNAUTHORIZED' }), 15, NOW)).toBe('UNAUTHORIZED')
    expect(effectiveFreshnessStatus(row({ status: 'WEIRD' }), 15, NOW)).toBe('FAILED')
  })

  it('失败码 → 状态：授权类未授权、前提不满足不适用、依赖等待、限流与上游错误延迟，其余失败', () => {
    expect(['AUTH_EXPIRED', 'ROLE_MISSING', 'SCOPE_UNAVAILABLE', 'DEPENDENCY_MISSING', 'THROTTLE_EXHAUSTED', 'UPSTREAM_ERROR', 'PARSE_HEADER', 'whatever'].map(freshnessStatusForFailure)).toEqual([
      'UNAUTHORIZED',
      'UNAUTHORIZED',
      'NOT_APPLICABLE',
      'WAITING_DEPENDENCY',
      'DELAYED',
      'DELAYED',
      'FAILED',
      'FAILED',
    ])
  })

  it('失败码翻译成中文；没有失败码为空；未登记的给通用说明，不暴露内部文本', () => {
    expect(freshnessErrorMessage('AUTH_EXPIRED')).toBe('亚马逊授权已失效，请重新授权')
    expect(freshnessErrorMessage(null)).toBeNull()
    expect(freshnessErrorMessage('ECONNRESET 10.0.0.1')).toBe('同步失败，请稍后重试或查看同步中心')
  })

  it('同步域 → 来源：只有登记过的域有来源', () => {
    expect(freshnessSourceOfDomain('orders')?.key).toBe('orders.api')
    expect(freshnessSourceOfDomain('ads')).toBeUndefined()
    expect(new Set(FRESHNESS_SOURCES.map(item => item.key)).size).toBe(FRESHNESS_SOURCES.length)
  })
})

describe('按范围聚合', () => {
  it('没有任何记录：显示“尚无记录”，没有时间，也不编造延迟', () => {
    const result = aggregateFreshness([], ['s1', 's2'], NOW, only('orders.api'))
    expect(result.sources[0]).toMatchObject({ status: 'NO_RECORD', statusLabel: '尚无记录', lastSuccessAt: null, dataThrough: null, lagMinutes: null, coverage: { total: 2, fresh: 0 } })
    expect(result.summary).toEqual({ completeness: 0, attention: 1 })
  })

  it('多个店铺取最差状态；覆盖时间取最早的；最近成功时间取最晚的；覆盖数只数正常的店铺', () => {
    const rows = [
      row({ sellerAccountId: 's1' }),
      row({ sellerAccountId: 's2', status: 'FAILED', lastErrorCode: 'PARSE_HEADER', dataThrough: minutesAgo(600), lastSuccessAt: minutesAgo(600), lastAttemptAt: minutesAgo(1) }),
    ]
    const view = aggregateFreshness(rows, ['s1', 's2'], NOW, only('orders.api')).sources[0]
    expect(view).toMatchObject({ status: 'FAILED', coverage: { total: 2, fresh: 1 }, errorCode: 'PARSE_HEADER', lagMinutes: 600 })
    expect(view.errorMessage).toContain('格式发生变化')
    expect(view.dataThrough).toEqual(minutesAgo(600))
    expect(view.lastSuccessAt).toEqual(minutesAgo(5))
    expect(view.lastAttemptAt).toEqual(minutesAgo(1))
  })

  it('范围里有店铺从没同步过：整体不是“正常”，覆盖时间为空（不能用其余店铺的时间冒充）', () => {
    const view = aggregateFreshness([row({ sellerAccountId: 's1' })], ['s1', 's2'], NOW, only('orders.api')).sources[0]
    expect(view).toMatchObject({ status: 'NO_RECORD', dataThrough: null, lagMinutes: null, coverage: { total: 2, fresh: 1 } })
  })

  it('不适用的店铺不计入覆盖；全部不适用则整体不适用；只统计范围内的店铺', () => {
    const na = row({ sellerAccountId: 's2', status: 'NOT_APPLICABLE' })
    expect(aggregateFreshness([row(), na], ['s1', 's2'], NOW, only('orders.api')).sources[0]).toMatchObject({ status: 'NORMAL', coverage: { total: 1, fresh: 1 } })
    expect(aggregateFreshness([na], ['s2'], NOW, only('orders.api')).sources[0].status).toBe('NOT_APPLICABLE')
    expect(aggregateFreshness([row({ sellerAccountId: 'other', status: 'FAILED' })], ['s1'], NOW, only('orders.api')).sources[0].status).toBe('NO_RECORD')
  })

  it('完整度（M-011）：正常来源数 ÷ 应同步来源数；不适用与未接入不进分母；没有应同步来源时为空', () => {
    const sources = [
      { key: 'a', label: 'a', intervalMinutes: 15 },
      { key: 'b', label: 'b', intervalMinutes: 15 },
      { key: 'c', label: 'c', intervalMinutes: 15 },
    ]
    const rows = [row({ sourceKey: 'a' }), row({ sourceKey: 'b', status: 'FAILED' }), row({ sourceKey: 'c', status: 'NOT_APPLICABLE' })]
    expect(aggregateFreshness(rows, ['s1'], NOW, sources).summary).toEqual({ completeness: 0.5, attention: 1 })
    expect(aggregateFreshness([], [], NOW, []).summary.completeness).toBeNull()
  })

  it('没有任何店铺时：来源显示“尚无记录”而不是“正常”', () => {
    expect(aggregateFreshness([], [], NOW, only('orders.api')).sources[0]).toMatchObject({ status: 'NO_RECORD', coverage: { total: 0, fresh: 0 } })
  })
})
