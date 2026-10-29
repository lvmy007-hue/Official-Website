import { describe, expect, it, vi } from 'vitest'
import { buildDeadlineHits, reimbursementDeadlineEvaluator, type DeadlineRow } from './reimbursement-deadline-evaluator'

// 赔付机会到期预警（P2b-16）：只看待处理且未过期、距期限近的排前面、剩余天数按 UTC 日历日、没有估算金额不写影响金额、范围与窗口写进查询。

const now = new Date('2026-10-23T08:00:00Z')
const row = (over: Partial<DeadlineRow> = {}): DeadlineRow => ({
  id: 'op-1',
  sellerAccountId: 's1',
  ruleCode: 'INBOUND_DISCREPANCY',
  sku: 'SKU-1',
  qty: 3,
  deadlineAt: new Date('2026-11-02T00:00:00Z'),
  estimatedAmount: { toString: () => '45.5' },
  currency: 'USD',
  ...over,
})
const names = new Map([['s1', '一店']])

describe('buildDeadlineHits', () => {
  it('剩余天数按日历日算，期限近的排前面；当天到期的标题写“今天到期”', () => {
    const hits = buildDeadlineHits(
      [row({ id: 'late' }), row({ id: 'today', deadlineAt: new Date('2026-10-23T00:00:00Z') }), row({ id: 'soon', deadlineAt: new Date('2026-10-25T00:00:00Z') })],
      names,
      now,
    )
    expect(hits.map(hit => hit.entityId)).toEqual(['today', 'soon', 'late'])
    expect(hits[0].title).toBe('赔付机会“入仓差异 SKU-1”今天到期')
    expect(hits[1].title).toBe('赔付机会“入仓差异 SKU-1”还剩 2 天到期')
    expect(hits[2].evidence).toMatchObject({ daysLeft: 10, deadline: '2026-11-02', ruleCode: 'INBOUND_DISCREPANCY', qty: 3, storeName: '一店' })
  })

  it('有估算金额与币种才给影响金额；没有成本无法估算时不给，更不是 0', () => {
    const [withAmount] = buildDeadlineHits([row()], names, now)
    expect(withAmount).toMatchObject({ entityType: 'REIMBURSEMENT_OPPORTUNITY', entityId: 'op-1', impact: { min: 45.5, max: 45.5, currency: 'USD' } })
    const [without] = buildDeadlineHits([row({ estimatedAmount: null, currency: null })], names, now)
    expect(without.impact).toBeUndefined()
    expect(without.evidence).toMatchObject({ estimatedAmount: null })
    const [noCurrency] = buildDeadlineHits([row({ currency: null })], names, now)
    expect(noCurrency.impact).toBeUndefined()
  })

  it('没有 SKU 的机会标题里不带 SKU', () => {
    const [hit] = buildDeadlineHits([row({ sku: null, ruleCode: 'REMOVAL_LOST' })], names, now)
    expect(hit.entityLabel).toBe('移除丢失（一店）')
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'FIN_REIMBURSEMENT_DEADLINE',
    domain: 'FINANCE',
    name: '赔付机会即将到期',
    severity: 'WARNING',
    cooldownMinutes: 4320,
    currentVersion: 1,
    condition: { type: 'reimbursement.deadline', params },
    scope,
  })
  const makeDb = (rows: Array<Record<string, unknown>>) => ({
    reimbursementOpportunity: { findMany: vi.fn(async (_args: { where: Record<string, any> }) => rows) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })

  it('只查待处理且期限在今天到预警天数之间的机会，默认 30 天', async () => {
    const db = makeDb([row()])
    const hits = await reimbursementDeadlineEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    const where = db.reimbursementOpportunity.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', status: 'PENDING' })
    expect(where.deadlineAt.gte.toISOString().slice(0, 10)).toBe('2026-10-23')
    expect(where.deadlineAt.lte.toISOString().slice(0, 10)).toBe('2026-11-22')
  })

  it('预警天数夹在 1 到 365；范围写进查询；没有期限的行不报；没有结果不查店铺', async () => {
    const db = makeDb([{ ...row(), deadlineAt: null }])
    expect(await reimbursementDeadlineEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ warnDays: 0 }, { sellerAccountIds: ['s1'], skus: ['SKU-1'] }), now })).toEqual([])
    const where = db.reimbursementOpportunity.findMany.mock.calls[0][0].where
    expect(where.deadlineAt.lte.toISOString().slice(0, 10)).toBe('2026-10-24')
    expect(where).toMatchObject({ sellerAccountId: { in: ['s1'] }, sku: { in: ['SKU-1'] } })
    expect(db.sellerAccount.findMany).not.toHaveBeenCalled()
    await reimbursementDeadlineEvaluator.evaluate({ db: makeDb([]) as never, tenantId: 't1', rule: rule({ warnDays: 9999 }), now })
  })
})
