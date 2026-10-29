import { describe, expect, it, vi } from 'vitest'
import { buildPiiBulkHits, piiBulkViewEvaluator, type PiiViewEvent } from './pii-bulk-view-evaluator'
import type { AlertRuleView } from '../platform/alert-evaluate'

// 大量查看买家信息明文预警（P5-09）：按人统计窗口内成功看到明文的次数，达到上限才命中。

const NOW = new Date('2026-10-25T10:00:00Z')
const views = (actorId: string | null, count: number, objects = count): PiiViewEvent[] =>
  Array.from({ length: count }, (_, i) => ({ actorId, occurredAt: new Date(NOW.getTime() - (i + 1) * 60_000), resourceId: `o${i % objects}` }))
const names = new Map([['u1', '林客服']])
const rule = (params: Record<string, unknown> = {}): AlertRuleView => ({
  id: 'r',
  code: 'SYS_PII_BULK_VIEW',
  domain: 'SYSTEM',
  name: '大量查看买家信息明文',
  severity: 'CRITICAL',
  cooldownMinutes: 1440,
  currentVersion: 1,
  condition: { type: 'audit.pii-bulk-view', params },
  scope: {},
})

describe('按人统计命中', () => {
  it('达到上限才命中，差一次不命中；每个人各一个命中，看得多的排前面', () => {
    const events = [...views('u1', 20), ...views('u2', 19), ...views('u3', 30)]
    const hits = buildPiiBulkHits(events, names, { windowMinutes: 60, maxViews: 20 })
    expect(hits.map(hit => hit.entityId)).toEqual(['u3', 'u1'])
    expect(hits[1]).toMatchObject({ entityType: 'PII_VIEWER', entityLabel: '林客服' })
  })

  it('证据只有人、次数、涉及的订单个数与时间，不含买家信息；已离开的成员用固定文案', () => {
    const [hit] = buildPiiBulkHits(views('gone', 25, 5), names, { windowMinutes: 30, maxViews: 20 })
    expect(hit.evidence).toMatchObject({ actorName: '已离开的成员', views: 25, distinctObjects: 5, windowMinutes: 30, threshold: 20 })
    expect(hit.title).toContain('30 分钟内查看了 25 次')
    expect(Object.keys(hit.evidence).sort()).toEqual(['actorName', 'distinctObjects', 'firstViewedAt', 'lastViewedAt', 'threshold', 'views', 'windowMinutes'])
  })

  it('没有操作人的记录不计入任何人', () => {
    expect(buildPiiBulkHits(views(null, 50), names, { windowMinutes: 60, maxViews: 20 })).toEqual([])
  })
})

describe('评估器', () => {
  const db = (events: PiiViewEvent[]) => ({
    auditEvent: { findMany: vi.fn().mockResolvedValue(events) },
    membership: { findMany: vi.fn().mockResolvedValue([{ userId: 'u1', user: { displayName: '林客服', email: 'lin@example.com' } }]) },
  })

  it('只数成功且确实看到了内容的查看，窗口与阈值取规则参数（有上下限）', async () => {
    const client = db(views('u1', 8))
    const hits = await piiBulkViewEvaluator.evaluate({ db: client as never, tenantId: 't1', rule: rule({ windowMinutes: 10, maxViews: 5 }), now: NOW })
    expect(hits).toHaveLength(1)
    const args = client.auditEvent.findMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ tenantId: 't1', result: 'SUCCEEDED', detail: { path: ['outcome'], equals: 'OK' }, actorId: { not: null } })
    expect(args.where.occurredAt.gte).toEqual(new Date(NOW.getTime() - 10 * 60_000))
    expect(args.where.action.in).toContain('ORDER_BUYER_PII_VIEWED')
  })

  it('次数不够时不再查成员；没有参数用默认值（60 分钟、20 次）；参数越界被夹到允许范围', async () => {
    const few = db(views('u1', 3))
    expect(await piiBulkViewEvaluator.evaluate({ db: few as never, tenantId: 't1', rule: rule(), now: NOW })).toEqual([])
    expect(few.membership.findMany).not.toHaveBeenCalled()
    expect(few.auditEvent.findMany.mock.calls[0][0].where.occurredAt.gte).toEqual(new Date(NOW.getTime() - 60 * 60_000))
    const wide = db([])
    await piiBulkViewEvaluator.evaluate({ db: wide as never, tenantId: 't1', rule: rule({ windowMinutes: 99_999 }), now: NOW })
    expect(wide.auditEvent.findMany.mock.calls[0][0].where.occurredAt.gte).toEqual(new Date(NOW.getTime() - 1440 * 60_000))
  })
})
