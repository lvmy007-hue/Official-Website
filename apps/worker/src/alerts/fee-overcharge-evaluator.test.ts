import { describe, expect, it, vi } from 'vitest'
import { buildOverchargeHits, feeOverchargeEvaluator, type OverchargeRow } from './fee-overcharge-evaluator'

// 费用多收预警（P2b-16）：按店铺 × 费用类别 × 币种合计、合计达到阈值才提醒、币种不混加、每个店铺只看最新核查日、范围与类别写进查询。

const row = (over: Partial<OverchargeRow> = {}): OverchargeRow => ({
  sellerAccountId: 's1',
  feeKind: 'FULFILLMENT',
  subjectKey: 'SKU-1',
  sku: 'SKU-1',
  currency: 'USD',
  overchargeAmount: { toString: () => '3.00' },
  snapshotDate: new Date('2026-10-22T00:00:00Z'),
  ...over,
})
const names = new Map([['s1', '一店']])
const amount = (value: string) => ({ toString: () => value })

describe('buildOverchargeHits', () => {
  it('同店铺同类别同币种合计；合计不到阈值的不报；币种不同分开合计；金额大的排前面', () => {
    const hits = buildOverchargeHits(
      [
        row({ subjectKey: 'A', sku: 'A', overchargeAmount: amount('3.00') }),
        row({ subjectKey: 'B', sku: 'B', overchargeAmount: amount('4.50') }),
        row({ feeKind: 'COMMISSION', subjectKey: 'C', sku: 'C', overchargeAmount: amount('2.00') }),
        row({ currency: 'CAD', subjectKey: 'D', sku: 'D', overchargeAmount: amount('9.00') }),
      ],
      names,
      5,
    )
    expect(hits.map(hit => hit.entityId)).toEqual(['s1|FULFILLMENT|CAD', 's1|FULFILLMENT|USD'])
    expect(hits[1].evidence).toMatchObject({ overchargeTotal: 7.5, itemCount: 2, currency: 'USD', feeKindLabel: '配送费', checkedOn: '2026-10-22' })
    expect(hits[1].impact).toEqual({ min: 7.5, max: 7.5, currency: 'USD' })
    expect(hits[1].title).toBe('一店 配送费疑似多收 USD 7.5（2 项）')
  })

  it('证据只列金额最大的 5 项；没有 SKU 的（入仓配置费）用对象键；零与负数不计', () => {
    const rows = Array.from({ length: 8 }, (_, index) => row({ subjectKey: `K${index}`, sku: `S${index}`, overchargeAmount: amount(String(index + 1)) }))
    const [hit] = buildOverchargeHits([...rows, row({ feeKind: 'FULFILLMENT', subjectKey: 'Z', sku: null, overchargeAmount: amount('0') })], names, 1)
    const top = (hit.evidence as { top: Array<{ subject: string; amount: number }> }).top
    expect(top).toHaveLength(5)
    expect(top[0]).toEqual({ subject: 'S7', amount: 8 })
    const [placement] = buildOverchargeHits([row({ feeKind: 'INBOUND_PLACEMENT', subjectKey: 'FBA15X', sku: null, overchargeAmount: amount('20') })], names, 1)
    expect((placement.evidence as { top: Array<{ subject: string }> }).top[0].subject).toBe('FBA15X')
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'FIN_FEE_OVERCHARGE',
    domain: 'FINANCE',
    name: '费用多收',
    severity: 'WARNING',
    cooldownMinutes: 4320,
    currentVersion: 1,
    condition: { type: 'fee.overcharge', params },
    scope,
  })
  const now = new Date('2026-10-23T08:00:00Z')
  const makeDb = (latest: Array<{ sellerAccountId: string; _max: { snapshotDate: Date | null } }>, rows: OverchargeRow[]) => ({
    feeAudit: { groupBy: vi.fn(async (_args: { where: Record<string, any> }) => latest), findMany: vi.fn(async (_args: { where: Record<string, any> }) => rows) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
  })
  const latest = [{ sellerAccountId: 's1', _max: { snapshotDate: new Date('2026-10-22T00:00:00Z') } }]

  it('每个店铺只取最新核查日的“疑似多收”行；默认阈值 5、四类费用都看', async () => {
    const db = makeDb(latest, [row({ overchargeAmount: amount('6') })])
    const hits = await feeOverchargeEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    const where = db.feeAudit.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', status: 'SUSPECTED', feeKind: { in: ['FULFILLMENT', 'COMMISSION', 'STORAGE', 'INBOUND_PLACEMENT'] } })
    expect(where.AND[0].OR).toEqual([{ sellerAccountId: 's1', snapshotDate: new Date('2026-10-22T00:00:00Z') }])
    expect(where.AND).toHaveLength(1)
  })

  it('没有核查记录不再读明细；范围与类别写进查询，SKU 范围放过没有 SKU 的行；阈值不够不报', async () => {
    const empty = makeDb([], [])
    expect(await feeOverchargeEvaluator.evaluate({ db: empty as never, tenantId: 't1', rule: rule(), now })).toEqual([])
    expect(empty.feeAudit.findMany).not.toHaveBeenCalled()
    const db = makeDb(latest, [row({ overchargeAmount: amount('2') })])
    const hits = await feeOverchargeEvaluator.evaluate({
      db: db as never,
      tenantId: 't1',
      rule: rule({ kinds: ['STORAGE', 'bogus'] }, { sellerAccountIds: ['s1'], skus: ['SKU-1'] }),
      now,
    })
    expect(hits).toEqual([])
    expect(db.feeAudit.groupBy.mock.calls[0][0].where).toMatchObject({ sellerAccountId: { in: ['s1'] } })
    const where = db.feeAudit.findMany.mock.calls[0][0].where
    expect(where.feeKind).toEqual({ in: ['STORAGE'] })
    expect(where.AND[1]).toEqual({ OR: [{ sku: { in: ['SKU-1'] } }, { sku: null }] })
  })
})
