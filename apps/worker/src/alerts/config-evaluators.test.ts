import { describe, expect, it, vi } from 'vitest'
import type { AlertRuleView } from '../platform/alert-evaluate'
import { buildFxHits, buildSwitchHits, fxFailedEvaluator, writeSwitchClosedEvaluator, type ClosedSwitchRow, type FxSourceRow } from './config-evaluators'

const NOW = new Date('2026-10-25T08:00:00Z')
const fx = (over: Partial<FxSourceRow> = {}): FxSourceRow => ({
  provider: 'FRANKFURTER_BLENDED',
  lastStatus: 'FAILED',
  lastErrorCode: 'HTTP_503',
  consecutiveFailures: 3,
  lastAttemptAt: new Date('2026-10-25T06:00:00Z'),
  lastSuccessAt: new Date('2026-10-22T06:00:00Z'),
  ...over,
})
const ruleOf = (params: Record<string, unknown> = {}): AlertRuleView => ({
  id: 'r1',
  code: 'SYS_FX_FETCH_FAILED',
  domain: 'SYSTEM',
  name: '汇率获取失败',
  severity: 'WARNING',
  cooldownMinutes: 1440,
  currentVersion: 1,
  condition: { type: 'system.fx-failed', params },
  scope: {},
})

describe('汇率获取失败', () => {
  it('主来源最近一次失败且连续失败达到阈值才命中；证据写清失败次数、阈值与上次成功时间', () => {
    const [hit] = buildFxHits(fx(), 3, NOW)
    expect(hit).toMatchObject({ entityType: 'FX_SOURCE', entityId: 'PRIMARY', title: '汇率已连续 3 次获取失败' })
    expect(hit.sellerAccountId).toBeUndefined()
    expect(hit.evidence).toMatchObject({ consecutiveFailures: 3, failureThreshold: 3, errorCode: 'HTTP_503', hoursSinceSuccess: 74, provider: 'Frankfurter 混合汇率' })
  })

  it('次数不足、最近一次成功、没有主来源记录都不命中；从没成功过时不写“多少小时前成功”', () => {
    expect(buildFxHits(fx({ consecutiveFailures: 2 }), 3, NOW)).toEqual([])
    expect(buildFxHits(fx({ lastStatus: 'OK', consecutiveFailures: 0 }), 3, NOW)).toEqual([])
    expect(buildFxHits(null, 3, NOW)).toEqual([])
    expect(buildFxHits(fx({ lastSuccessAt: null }), 3, NOW)[0].evidence).toMatchObject({ lastSuccessAt: null, hoursSinceSuccess: null })
  })

  it('评估器读主来源与规则阈值（阈值不合法回落到默认 3 次）', async () => {
    const findFirst = vi.fn(async () => fx({ consecutiveFailures: 4 }))
    const db = { fxSourceConfig: { findFirst } } as never
    const hits = await fxFailedEvaluator.evaluate({ db, tenantId: 't1', rule: ruleOf({ minFailures: 5 }), now: NOW })
    expect(hits).toEqual([])
    expect(await fxFailedEvaluator.evaluate({ db, tenantId: 't1', rule: ruleOf({ minFailures: 'x' }), now: NOW })).toHaveLength(1)
    expect(findFirst).toHaveBeenCalledWith({ where: { tenantId: 't1', role: 'PRIMARY' } })
  })
})

const closed = (over: Partial<ClosedSwitchRow> = {}): ClosedSwitchRow => ({
  switchKey: 'sw.listing.write',
  autoDisabledReason: '连续失败 5 次（HTTP_500）',
  calls7d: 12,
  failures7d: 6,
  consecutiveFailures: 5,
  updatedAt: new Date('2026-10-24T01:00:00Z'),
  ...over,
})

describe('写入开关被自动关闭', () => {
  it('每个处于自动关闭状态的开关一个命中，按关闭时间从早到晚；没有自动关闭原因的（人工关闭）不算', () => {
    const hits = buildSwitchHits([closed({ switchKey: 'b', updatedAt: new Date('2026-10-25T01:00:00Z') }), closed({ switchKey: 'a' }), closed({ switchKey: 'c', autoDisabledReason: null })])
    expect(hits.map(hit => hit.entityId)).toEqual(['a', 'b'])
    expect(hits[0]).toMatchObject({ entityType: 'INTEGRATION_SWITCH' })
    expect(hits[0].evidence).toMatchObject({ autoDisabledReason: '连续失败 5 次（HTTP_500）', calls7d: 12, failures7d: 6, consecutiveFailures: 5 })
  })

  it('评估器只读企业级开关（不含店铺级）、已关闭且带自动关闭原因的', async () => {
    const findMany = vi.fn(async () => [closed()])
    const db = { integrationSwitch: { findMany } } as never
    const hits = await writeSwitchClosedEvaluator.evaluate({ db, tenantId: 't1', rule: ruleOf(), now: NOW })
    expect(hits).toHaveLength(1)
    expect(findMany.mock.calls[0][0].where).toEqual({ tenantId: 't1', sellerAccountId: null, enabled: false, autoDisabledReason: { not: null } })
  })
})
