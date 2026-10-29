import { describe, expect, it } from 'vitest'
import { foldLedgerSummary, latestMonthKeys, type LedgerSummaryInput } from './ledger-math'

// 台账汇总折叠：月内变动相加，月初取每个（库位、处置状态）最早一行的期初，月末取最晚一行的期末。

const row = (over: Partial<LedgerSummaryInput> = {}): LedgerSummaryInput => ({
  sellerAccountId: 's1',
  date: new Date('2026-10-01T00:00:00Z'),
  fnsku: 'X1',
  sku: 'SKU-1',
  asin: 'B0TEST',
  fulfillmentCenter: 'ONT8',
  disposition: 'SELLABLE',
  aggregation: 'DAILY',
  startingQty: 0,
  receipts: 0,
  customerShipments: 0,
  customerReturns: 0,
  vendorReturns: 0,
  transfers: 0,
  found: 0,
  lost: 0,
  damaged: 0,
  disposed: 0,
  other: 0,
  unknownEvents: 0,
  endingQty: 0,
  ...over,
})
const day = (d: string) => new Date(`${d}T00:00:00Z`)

describe('台账汇总折叠', () => {
  it('逐日行折成月：期初取第一天、期末取最后一天、变动相加；平衡', () => {
    const [month] = foldLedgerSummary([
      row({ date: day('2026-10-01'), startingQty: 100, receipts: 50, customerShipments: -10, endingQty: 140 }),
      row({ date: day('2026-10-02'), startingQty: 140, customerShipments: -5, lost: -1, endingQty: 134 }),
    ])
    expect(month).toMatchObject({
      month: '2026-10',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-02',
      startingQty: 100,
      endingQty: 134,
      receipts: 50,
      customerShipments: -15,
      lost: -1,
      expectedEnding: 134,
      difference: 0,
      balanced: true,
    })
  })

  it('期末与计算值不符：标记不平衡并给出差额，数据原样保留', () => {
    const [month] = foldLedgerSummary([row({ startingQty: 10, receipts: 5, endingQty: 20 })])
    expect(month).toMatchObject({ expectedEnding: 15, difference: 5, balanced: false, endingQty: 20 })
  })

  it('多个库位与处置状态：期初与期末各自取边界后相加；仓间转运在合计里相互抵消', () => {
    const [month] = foldLedgerSummary([row({ fulfillmentCenter: 'A', startingQty: 10, transfers: -4, endingQty: 6 }), row({ fulfillmentCenter: 'B', startingQty: 0, transfers: 4, endingQty: 4 })])
    expect(month).toMatchObject({ startingQty: 10, endingQty: 10, transfers: 0, balanced: true })
  })

  it('一个库位只在月中出现：期初取它出现的第一行（它的余额从那天起算）', () => {
    const [month] = foldLedgerSummary([
      row({ date: day('2026-10-01'), startingQty: 5, endingQty: 5 }),
      row({ date: day('2026-10-10'), fulfillmentCenter: 'B', startingQty: 0, receipts: 7, endingQty: 7 }),
    ])
    expect(month).toMatchObject({ startingQty: 5, endingQty: 12, receipts: 7, balanced: true })
  })

  it('同月既有逐日又有逐周的行：只取最细的逐日，变动不重复计算', () => {
    const [month] = foldLedgerSummary([row({ startingQty: 0, receipts: 10, endingQty: 10 }), row({ aggregation: 'WEEKLY', startingQty: 0, receipts: 10, endingQty: 10 })])
    expect(month.receipts).toBe(10)
    expect(month.balanced).toBe(true)
  })

  it('不同月、不同 SKU、不同店铺分成不同行；SKU 名取最近一个有名字的行', () => {
    const rows = foldLedgerSummary([
      row({ date: day('2026-09-30'), sku: '' }),
      row({ date: day('2026-09-29'), sku: 'OLD-NAME' }),
      row({ date: day('2026-10-01') }),
      row({ fnsku: 'X2', date: day('2026-10-01') }),
      row({ sellerAccountId: 's2', date: day('2026-10-01') }),
    ])
    expect(rows).toHaveLength(4)
    expect(rows.find(item => item.month === '2026-09')?.sku).toBe('OLD-NAME')
  })

  it('最近一个月的行集合：每个店铺与 FNSKU 各一个', () => {
    const rows = foldLedgerSummary([row({ date: day('2026-09-10') }), row({ date: day('2026-10-10') }), row({ fnsku: 'X2', date: day('2026-09-10') })])
    const latest = latestMonthKeys(rows)
    expect(latest.size).toBe(2)
    expect(latest.has('s1|X1|2026-10')).toBe(true)
    expect(latest.has('s1|X1|2026-09')).toBe(false)
    expect(latest.has('s1|X2|2026-09')).toBe(true)
  })

  it('没有数据：空结果', () => {
    expect(foldLedgerSummary([])).toEqual([])
  })
})
