import { describe, expect, it, vi } from 'vitest'
import { buildDeclineHits, buildStatusHits, healthDeclineEvaluator, statusChangedEvaluator, type MetricDay, type StatusDay } from './account-evaluators'

// 账户健康类预警（P5-02）：状态变化只认“有之前状态、变化后仍是当前状态、在回看天数内、在提醒的状态里”；指标未达标只看最近一份快照。

const day = (text: string) => new Date(`${text}T00:00:00Z`)
const now = new Date('2026-10-25T08:00:00Z')
const names = new Map([
  ['s1', '一店'],
  ['s2', '二店'],
])
const status = (store: string, text: string, accountStatus: string): StatusDay => ({ sellerAccountId: store, snapshotDate: day(text), accountStatus })
const params = { lookbackDays: 7, statuses: ['AT_RISK', 'DEACTIVATED'] as const }

describe('buildStatusHits', () => {
  it('正常→有风险且仍是当前状态：命中，证据里带之前与之后的状态和变化日期', () => {
    const hits = buildStatusHits([status('s1', '2026-10-22', 'NORMAL'), status('s1', '2026-10-23', 'AT_RISK'), status('s1', '2026-10-24', 'AT_RISK')], names, params, now)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'STORE', entityId: 's1', sellerAccountId: 's1', entityLabel: '一店' })
    expect(hits[0]?.title).toBe('一店 的账户状态从“正常”变为“有风险”')
    expect(hits[0]?.evidence).toMatchObject({ from: 'NORMAL', to: 'AT_RISK', changedOn: '2026-10-23', hasWorsened: true })
  })

  it('已经恢复正常、变化早于回看天数、第一次出现的状态、不在提醒状态里：都不命中', () => {
    expect(buildStatusHits([status('s1', '2026-10-22', 'NORMAL'), status('s1', '2026-10-23', 'AT_RISK'), status('s1', '2026-10-24', 'NORMAL')], names, params, now)).toEqual([])
    expect(buildStatusHits([status('s1', '2026-10-01', 'NORMAL'), status('s1', '2026-10-02', 'AT_RISK'), status('s1', '2026-10-24', 'AT_RISK')], names, params, now)).toEqual([])
    expect(buildStatusHits([status('s1', '2026-10-24', 'AT_RISK')], names, params, now)).toEqual([])
    expect(buildStatusHits([status('s1', '2026-10-22', 'NORMAL'), status('s1', '2026-10-23', 'AT_RISK')], names, { ...params, statuses: ['DEACTIVATED'] }, now)).toEqual([])
    expect(buildStatusHits([status('s1', '2026-10-22', 'WEIRD'), status('s1', '2026-10-23', 'NORMAL')], names, params, now)).toEqual([])
  })

  it('按店铺各自判断，最近发生变化的店铺排在前面', () => {
    const hits = buildStatusHits(
      [status('s1', '2026-10-20', 'NORMAL'), status('s1', '2026-10-21', 'DEACTIVATED'), status('s2', '2026-10-23', 'NORMAL'), status('s2', '2026-10-24', 'AT_RISK')],
      names,
      params,
      now,
    )
    expect(hits.map(hit => hit.entityId)).toEqual(['s2', 's1'])
  })
})

const metric = (store: string, text: string, key: string, statusValue: string, value: number | null = 0.02): MetricDay => ({
  sellerAccountId: store,
  snapshotDate: day(text),
  metricKey: key,
  metricGroup: 'ORDER_DEFECT',
  status: statusValue,
  value,
  target: 0.01,
  targetCondition: 'LT',
  unit: 'RATIO',
  windowDays: 60,
})

describe('buildDeclineHits', () => {
  it('只看每个店铺最近一份快照：未达标的指标合成一个命中，标题列出前三项，目标与当前值用百分比写', () => {
    const hits = buildDeclineHits(
      [
        metric('s1', '2026-10-24', 'orderDefectRate.afn', 'NOT_MET'),
        metric('s1', '2026-10-24', 'orderDefectRate.mfn', 'MET', 0.002),
        metric('s1', '2026-10-24', 'lateShipmentRate', 'NOT_MET', 0.05),
        metric('s1', '2026-10-23', 'cancelRate', 'NOT_MET', 0.09),
      ],
      names,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('一店 有 2 项账户健康指标未达标：迟发率、订单缺陷率（亚马逊配送）')
    expect(hits[0]?.evidence).toMatchObject({ snapshotDate: '2026-10-24' })
    const metrics = (hits[0]?.evidence as { metrics: { key: string; valueText: string; targetText: string }[] }).metrics
    expect(metrics.map(item => item.key)).toEqual(['lateShipmentRate', 'orderDefectRate.afn'])
    expect(metrics[1]).toMatchObject({ valueText: '2%', targetText: '低于 1%' })
  })

  it('最近一份快照全部达标（或没给目标）：不命中，更早的未达标不再算', () => {
    expect(buildDeclineHits([metric('s1', '2026-10-24', 'orderDefectRate.afn', 'MET', 0.001), metric('s1', '2026-10-23', 'orderDefectRate.afn', 'NOT_MET')], names)).toEqual([])
    expect(buildDeclineHits([metric('s1', '2026-10-24', 'x', 'UNKNOWN')], names)).toEqual([])
  })
})

describe('评估器', () => {
  const rule = (type: string, params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'X',
    domain: 'SYSTEM',
    name: 'x',
    severity: 'WARNING',
    cooldownMinutes: 1440,
    currentVersion: 1,
    condition: { type, params },
    scope,
  })
  const db = (rows: unknown[]) => ({
    accountHealthSnapshot: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => rows) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })

  it('状态变化：读最近 90 天的状态行，按店铺范围过滤；没有任何记录返回空，不读店铺', async () => {
    const data = db([status('s1', '2026-10-23', 'NORMAL'), status('s1', '2026-10-24', 'AT_RISK')])
    const hits = await statusChangedEvaluator.evaluate({ db: data as never, tenantId: 't1', rule: rule('account.status-changed', {}, { sellerAccountIds: ['s1'] }), now })
    expect(hits).toHaveLength(1)
    const where = data.accountHealthSnapshot.findMany.mock.calls[0]?.[0].where
    expect(where).toMatchObject({ tenantId: 't1', metricKey: 'ACCOUNT_STATUS', sellerAccountId: { in: ['s1'] } })
    const empty = db([])
    expect(await statusChangedEvaluator.evaluate({ db: empty as never, tenantId: 't1', rule: rule('account.status-changed'), now })).toEqual([])
    expect(empty.sellerAccount.findMany).not.toHaveBeenCalled()
  })

  it('指标未达标：按关注分组和最长天数读快照', async () => {
    const data = db([metric('s1', '2026-10-24', 'orderDefectRate.afn', 'NOT_MET')])
    const hits = await healthDeclineEvaluator.evaluate({ db: data as never, tenantId: 't1', rule: rule('account.health-decline', { maxAgeDays: 2, groups: ['POLICY'] }), now })
    expect(hits).toHaveLength(1)
    const where = data.accountHealthSnapshot.findMany.mock.calls[0]?.[0].where as { metricGroup: { in: string[] }; snapshotDate: { gte: Date } }
    expect(where.metricGroup.in).toEqual(['POLICY'])
    expect(where.snapshotDate.gte.toISOString().slice(0, 10)).toBe('2026-10-23')
  })
})
