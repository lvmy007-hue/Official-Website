import { describe, expect, it, vi } from 'vitest'
import { abnormalReturnRateEvaluator, abnormalReturnRows, topReasons, type ReturnRateRow } from './returns-evaluator'

// 异常退货率预警（P2b-16）：退货率与两个最小样本都要达到、没有销售件数不判断（不当 0%）、高的排前面、原因合并空值、SKU 范围换成 ASIN、窗口写进查询。

const limits = { rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 30 }
const row = (over: Partial<ReturnRateRow> = {}): ReturnRateRow => ({ sellerAccountId: 's1', asin: 'B0A', returnedUnits: 10, soldUnits: 50, topReason: null, ...over })

describe('abnormalReturnRows', () => {
  it('退货率不小于阈值（含等于）、退货与销售样本都够才算；高的排前面', () => {
    const out = abnormalReturnRows(
      [
        row({ asin: 'LOW', returnedUnits: 5, soldUnits: 100 }),
        row({ asin: 'EQ', returnedUnits: 15, soldUnits: 100 }),
        row({ asin: 'HIGH', returnedUnits: 30, soldUnits: 60 }),
        row({ asin: 'FEWRET', returnedUnits: 4, soldUnits: 10 }),
        row({ asin: 'FEWSOLD', returnedUnits: 6, soldUnits: 20 }),
      ],
      limits,
    )
    expect(out.map(item => item.row.asin)).toEqual(['HIGH', 'EQ'])
    expect(out[0].rate).toBe(0.5)
  })

  it('没有销售件数（为 0）不判断，不当 0% 也不当无穷大', () => {
    expect(abnormalReturnRows([row({ soldUnits: 0 })], limits)).toEqual([])
  })

  it('退货率相同按退货件数多的排前面', () => {
    const out = abnormalReturnRows([row({ asin: 'A', returnedUnits: 10, soldUnits: 50 }), row({ asin: 'B', returnedUnits: 20, soldUnits: 100 })], limits)
    expect(out.map(item => item.row.asin)).toEqual(['B', 'A'])
  })
})

describe('topReasons', () => {
  it('空原因与未提供合并后取件数最多的；并列取代码靠前的', () => {
    const out = topReasons([
      { key: 's1|A', reason: null, units: 3 },
      { key: 's1|A', reason: '', units: 4 },
      { key: 's1|A', reason: 'DEFECTIVE', units: 6 },
      { key: 's1|B', reason: 'WRONG_ITEM', units: 2 },
      { key: 's1|B', reason: 'DEFECTIVE', units: 2 },
    ])
    expect(out.get('s1|A')).toEqual({ code: 'UNSPECIFIED', units: 7 })
    expect(out.get('s1|B')).toEqual({ code: 'DEFECTIVE', units: 2 })
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'RET_RATE_ABNORMAL',
    domain: 'AFTER_SALES',
    name: '异常退货率',
    severity: 'WARNING',
    cooldownMinutes: 10_080,
    currentVersion: 1,
    condition: { type: 'returns.abnormal-rate', params },
    scope,
  })
  const now = new Date('2026-10-23T08:00:00Z')
  const makeDb = (over: Record<string, unknown> = {}) => {
    const returnedGroups = vi.fn(async (args: { by: string[]; where: Record<string, any> }) =>
      args.by.includes('reason')
        ? [
            { sellerAccountId: 's1', asin: 'B0A', reason: 'DEFECTIVE', _sum: { quantity: 8 } },
            { sellerAccountId: 's1', asin: 'B0A', reason: 'NO_REASON_GIVEN', _sum: { quantity: 2 } },
          ]
        : [
            { sellerAccountId: 's1', asin: 'B0A', _sum: { quantity: 10 } },
            { sellerAccountId: 's1', asin: 'B0B', _sum: { quantity: 9 } },
            { sellerAccountId: 's1', asin: 'B0C', _sum: { quantity: 2 } },
          ],
    )
    return {
      fbaReturnCase: { groupBy: returnedGroups },
      asinDailySummary: {
        groupBy: vi.fn(async (_args: { where: Record<string, any> }) => [
          { sellerAccountId: 's1', asin: 'B0A', _sum: { units: 50 } },
          { sellerAccountId: 's1', asin: 'B0B', _sum: { units: 900 } },
        ]),
      },
      fbaProduct: { findMany: vi.fn(async (_args: { where: Record<string, any> }) => [{ id: 'prod-A', sellerAccountId: 's1', asin: 'B0A', title: '示例商品' }]) },
      sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
      ...over,
    }
  }

  it('命中：高退货率且样本够的 ASIN（B0B 退货率只有 1%、B0C 退货样本不够都不报）；有商品记录链到商品全景；证据带最多的原因', async () => {
    const db = makeDb()
    const hits = await abnormalReturnRateEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A', sellerAccountId: 's1', entityLabel: 'B0A（一店）' })
    expect(hits[0].title).toBe('ASIN B0A 近 30 天退货率 20%（退 10 件 ÷ 卖 50 件）')
    expect(hits[0].evidence).toMatchObject({ returnedUnits: 10, soldUnits: 50, rate: 0.2, threshold: 0.15, title: '示例商品', topReason: { code: 'DEFECTIVE', units: 8 } })
    expect(hits[0].impact).toBeUndefined()
  })

  it('窗口是含今天的 N 天（默认 30）；销售汇总只查有退货的 ASIN；没有商品记录时按店铺 × ASIN 登记', async () => {
    const db = makeDb({ fbaProduct: { findMany: vi.fn(async () => []) } })
    const hits = await abnormalReturnRateEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits[0]).toMatchObject({ entityType: 'RETURN_ASIN', entityId: 's1|B0A' })
    const returnedWhere = db.fbaReturnCase.groupBy.mock.calls[0][0].where
    expect(returnedWhere.returnDate.gte.toISOString().slice(0, 10)).toBe('2026-09-24')
    expect(returnedWhere.returnDate.lt.toISOString().slice(0, 10)).toBe('2026-10-24')
    expect(db.asinDailySummary.groupBy.mock.calls[0][0].where.asin).toEqual({ in: ['B0A', 'B0B'] })
  })

  it('阈值与窗口夹在允许范围内；调高阈值后不再命中；SKU 范围换成对应 ASIN；没有候选时不查销售汇总', async () => {
    const strict = makeDb()
    expect(await abnormalReturnRateEvaluator.evaluate({ db: strict as never, tenantId: 't1', rule: rule({ rateThreshold: 0.5, windowDays: 1 }), now })).toEqual([])
    expect(strict.fbaReturnCase.groupBy.mock.calls[0][0].where.returnDate.gte.toISOString().slice(0, 10)).toBe('2026-10-17')
    const scoped = makeDb({ fbaProduct: { findMany: vi.fn(async () => [{ asin: 'B0A' }]) } })
    await abnormalReturnRateEvaluator.evaluate({ db: scoped as never, tenantId: 't1', rule: rule({}, { sellerAccountIds: ['s1'], skus: ['SKU-A'] }), now })
    expect(scoped.fbaProduct.findMany.mock.calls[0][0].where).toMatchObject({ sellerSku: { in: ['SKU-A'] }, sellerAccountId: { in: ['s1'] } })
    expect(scoped.fbaReturnCase.groupBy.mock.calls[0][0].where).toMatchObject({ asin: { in: ['B0A'] }, sellerAccountId: { in: ['s1'] } })
    const none = makeDb({ fbaReturnCase: { groupBy: vi.fn(async () => [{ sellerAccountId: 's1', asin: 'B0A', _sum: { quantity: 1 } }]) } })
    expect(await abnormalReturnRateEvaluator.evaluate({ db: none as never, tenantId: 't1', rule: rule(), now })).toEqual([])
    expect(none.asinDailySummary.groupBy).not.toHaveBeenCalled()
  })
})
