import { describe, expect, it } from 'vitest'
import {
  attributionFactors,
  bucketize,
  changeRatio,
  consecutiveDecliners,
  dailySeries,
  driverWaterfall,
  nullableSum,
  pointsChange,
  safeDivide,
  storeWaterfall,
  sumDays,
  ZERO_DAY,
  type DayValues,
} from './aggregate'

const day = (patch: Partial<DayValues>): DayValues => ({ ...ZERO_DAY, ...patch })

describe('经营控制台的纯计算', () => {
  it('可空值求和：全部为空是 null，不是 0；有一个值就按有值的求和', () => {
    expect(nullableSum([null, null])).toBeNull()
    expect(nullableSum([])).toBeNull()
    expect(nullableSum([null, 3, 4])).toBe(7)
    expect(nullableSum([0, null])).toBe(0)
    const total = sumDays([day({ sales: 10, adsSpend: null }), day({ sales: 5, adsSpend: null })])
    expect(total).toMatchObject({ sales: 15, adsSpend: null, profit: null, sessions: null })
    expect(sumDays([day({ adsSpend: 2 }), day({ adsSpend: null })]).adsSpend).toBe(2)
  })

  it('变化比率：对比期为 0 或缺失无法计算；下降为负；除零保护', () => {
    expect(changeRatio(120, 100)).toBeCloseTo(0.2)
    expect(changeRatio(50, 100)).toBeCloseTo(-0.5)
    expect(changeRatio(10, 0)).toBeNull()
    expect(changeRatio(null, 5)).toBeNull()
    expect(changeRatio(5, null)).toBeNull()
    expect(changeRatio(-50, -100)).toBeCloseTo(0.5)
    expect(safeDivide(1, 0)).toBeNull()
    expect(safeDivide(null, 2)).toBeNull()
    expect(safeDivide(1, 4)).toBe(0.25)
    expect(pointsChange(0.3, 0.25)).toBeCloseTo(0.05)
    expect(pointsChange(null, 0.25)).toBeNull()
  })

  it('逐日走势：缺行的日子按指定值补（销售额补 0，利润保持空）', () => {
    const map = new Map([['2026-10-02', day({ sales: 7, profit: 2 })]])
    const days = ['2026-10-01', '2026-10-02', '2026-10-03']
    expect(dailySeries(days, map, d => d.sales, 0)).toEqual([0, 7, 0])
    expect(dailySeries(days, map, d => d.profit, null)).toEqual([null, 2, null])
  })

  it('分桶：周按周一合并，空值不当作 0；整个桶都没有值时保持空', () => {
    const days = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-26']
    expect(bucketize(days, [1, 2, 3, 4], 'week')).toEqual([
      { key: '2026-10-12', value: 1 },
      { key: '2026-10-19', value: 5 },
      { key: '2026-10-26', value: 4 },
    ])
    expect(bucketize(days, [null, null, 3, null], 'week')).toEqual([
      { key: '2026-10-12', value: null },
      { key: '2026-10-19', value: 3 },
      { key: '2026-10-26', value: null },
    ])
    expect(bucketize(['2026-09-30', '2026-10-01'], [1, 2], 'month')).toEqual([
      { key: '2026-09-01', value: 1 },
      { key: '2026-10-01', value: 2 },
    ])
  })

  it('归因因子：有会话时三因子；没有会话退化为 件数 × 件单价，并写明原因', () => {
    const three = attributionFactors({ units: 120, sales: 2400, sessions: 1000 }, { units: 100, sales: 1800, sessions: 800 })
    expect(three.mode).toBe('THREE_FACTOR')
    expect(three.factors.map(f => f.key)).toEqual(['sessions', 'conversion', 'unitPrice'])
    // 三个因子相乘等于销售额
    const product = (pick: 'before' | 'after') => three.factors.reduce((p, f) => p * f[pick], 1)
    expect(product('after')).toBeCloseTo(2400)
    expect(product('before')).toBeCloseTo(1800)

    const two = attributionFactors({ units: 120, sales: 2400, sessions: null }, { units: 100, sales: 1800, sessions: null })
    expect(two.mode).toBe('TWO_FACTOR')
    expect(two.factors.map(f => f.key)).toEqual(['units', 'unitPrice'])
    expect(two.unavailable.map(item => item.key)).toEqual(['sessions', 'conversion'])
    expect(two.unavailable[0]?.reason).toContain('尚未接入')
    // 只有一期有会话也不能三因子
    expect(attributionFactors({ units: 1, sales: 1, sessions: 5 }, { units: 1, sales: 1, sessions: null }).mode).toBe('TWO_FACTOR')
    // 没有件数时件单价为 0，由前端按“无法归因”处理
    expect(attributionFactors({ units: 0, sales: 0, sessions: null }, { units: 3, sales: 9, sessions: null }).factors[1]).toMatchObject({ after: 0, before: 3 })
  })

  it('增长瀑布（按驱动因素）：新品、增长与下滑最多的老 ASIN、其余、未归属相加等于总变化；断货损失未接入为空不计入', () => {
    const candidates = [
      { asin: 'A', current: 500, previous: 100 },
      { asin: 'B', current: 90, previous: 400 },
      { asin: 'C', current: 130, previous: 100 },
      { asin: 'D', current: 20, previous: 50 },
      { asin: 'N', current: 300, previous: 0 },
    ]
    const asinTotalChange = 500 + 90 + 130 + 20 + 300 - (100 + 400 + 100 + 50)
    const totalChange = asinTotalChange + 40 + 25 // 40 来自候选之外的其余 ASIN，25 来自没有 ASIN 的订单行
    const items = driverWaterfall({ totalChange, asinTotalChange: asinTotalChange + 40, candidates, newAsins: new Set(['N']), topCount: 1 })
    const byKey = Object.fromEntries(items.map(item => [item.key, item]))
    expect(byKey['asin:A']?.amount).toBe(400)
    expect(byKey['asin:B']?.amount).toBe(-310)
    expect(byKey.new?.amount).toBe(300)
    expect(byKey.stockout).toMatchObject({ amount: null, estimate: true })
    expect(byKey.unattributed?.amount).toBe(25)
    // C、D 与候选之外的 40 合并到“其余 ASIN”
    expect(byKey.other?.amount).toBe(30 - 30 + 40)
    expect(items.reduce((total, item) => total + (item.amount ?? 0), 0)).toBe(totalChange)
  })

  it('增长瀑布（按店铺）：按变化绝对值从大到小，合计等于各店总变化', () => {
    const items = storeWaterfall([
      { storeId: 's1', storeName: 'A 店', current: 100, previous: 90 },
      { storeId: 's2', storeName: 'B 店', current: 20, previous: 120 },
    ])
    expect(items.map(item => [item.label, item.amount])).toEqual([
      ['B 店', -100],
      ['A 店', 10],
    ])
  })

  it('波动异常：只留连续两期下降的 ASIN，按累计下降金额排序，没有上上期销售的不算', () => {
    const rows = consecutiveDecliners(
      [
        { asin: 'A', sku: 'a', earlier: 100, previous: 80, current: 40 },
        { asin: 'B', sku: null, earlier: 300, previous: 200, current: 150 },
        { asin: 'C', sku: null, earlier: 100, previous: 80, current: 90 },
        { asin: 'D', sku: null, earlier: 100, previous: 100, current: 50 },
        { asin: 'E', sku: null, earlier: 0, previous: 0, current: 0 },
      ],
      10,
    )
    expect(rows.map(row => row.asin)).toEqual(['B', 'A'])
    expect(rows[1]).toMatchObject({ totalDrop: 60, salesChange: -0.5, previousChange: -0.2 })
    expect(
      consecutiveDecliners(
        [
          { asin: 'A', sku: null, earlier: 9, previous: 5, current: 1 },
          { asin: 'B', sku: null, earlier: 9, previous: 5, current: 1 },
        ],
        1,
      ),
    ).toHaveLength(1)
  })
})
