import { describe, expect, it } from 'vitest'
import {
  adsStoreCheck,
  compareDays,
  DATASET_FRESHNESS_SOURCES,
  EconomicsCompareQuerySchema,
  EconomicsPreviewQuerySchema,
  EconomicsSimulateBodySchema,
  freshnessSourceOfDataset,
  previewImpact,
  summarizeCompare,
  verdictOf,
  type CompareCandidate,
  type EconomicsOfficialView,
  type OursRecord,
} from './index.js'

// 官方经济数据对账（P2b-11）的纯函数与请求校验。符号约定：影响 = 官方净收益 − 我方可比净收益，正数表示官方更高。

const official = (over: Partial<EconomicsOfficialView> = {}): EconomicsOfficialView => ({
  sales: 100,
  orderedSales: 100,
  refundedSales: 0,
  units: 5,
  fees: 30,
  ads: 0,
  costPerUnit: null,
  cost: null,
  netProceeds: 70,
  currency: 'USD',
  ...over,
})
const ours = (over: Partial<OursRecord> = {}): OursRecord => ({ sales: 100, fees: 30, ads: null, cost: null, units: 5, profit: 70, ...over })
const day = (date: string, o: EconomicsOfficialView | null, c: OursRecord | null, msku = 'SKU-A'): CompareCandidate => ({ sellerAccountId: 'sa1', msku, date, asin: 'B0A', official: o, ours: c })

describe('双源核对', () => {
  it('两边一致：结论是一致，各类差异为 0', () => {
    const rows = compareDays([day('2026-10-20', official(), ours())], { withCost: true })
    expect(rows[0]).toMatchObject({ verdict: 'MATCH', impact: { sales: 0, fees: 0, ads: 0, cost: null, net: 0 } })
  })

  it('官方有广告扣款而我方没分摊：全部归广告口径，符号为负（官方净收益更低）', () => {
    const [row] = compareDays([day('2026-10-20', official({ ads: 8 }), ours())], { withCost: true })
    expect(row?.verdict).toBe('ADS')
    expect(row?.parts).toMatchObject({ ADS: -8, COST: 0, TIME: 0, UNEXPLAINED: 0 })
    expect(row?.impact?.net).toBe(-8)
    expect(row?.notes.join()).toContain('广告尚未分摊')
  })

  it('两边都有成本：差额归成本口径；官方没填成本时不核对成本；没有成本字段权限也不核对', () => {
    const withCost = compareDays([day('2026-10-20', official({ cost: 20, costPerUnit: 4 }), ours({ cost: 15 }))], { withCost: true })[0]
    expect(withCost).toMatchObject({ verdict: 'COST', impact: { cost: -5, net: -5 } })
    const noOfficialCost = compareDays([day('2026-10-20', official({ cost: null }), ours({ cost: 15 }))], { withCost: true })[0]
    expect(noOfficialCost).toMatchObject({ verdict: 'MATCH', impact: { cost: null } })
    expect(noOfficialCost?.notes.join()).toContain('官方未提供成本')
    const noPermission = compareDays([day('2026-10-20', official({ cost: 20 }), ours({ cost: 15 }))], { withCost: false })[0]
    expect(noPermission?.impact?.cost).toBeNull()
  })

  it('时间口径：同一 SKU 两天的销售额差额在区间内互相抵消，每天都归时间口径', () => {
    const rows = compareDays([day('2026-10-20', official({ sales: 120 }), ours({ sales: 100 })), day('2026-10-21', official({ sales: 80 }), ours({ sales: 100 }))], { withCost: false })
    expect(rows.map(row => row.verdict)).toEqual(['TIME', 'TIME'])
    expect(rows.map(row => row.parts?.TIME)).toEqual([20, -20])
    expect(rows.every(row => row.parts?.UNEXPLAINED === 0)).toBe(true)
  })

  it('未解释：区间合计后仍有差额，超出容差的部分按各行差额绝对值占比分摊，合计等于净差异', () => {
    const rows = compareDays([day('2026-10-20', official({ sales: 130 }), ours({ sales: 100 })), day('2026-10-21', official({ sales: 90 }), ours({ sales: 100 }))], { withCost: false })
    const unexplained = rows.map(row => row.parts?.UNEXPLAINED ?? 0)
    expect(unexplained[0]).toBeCloseTo(15, 6) // 区间合计差 20，按 30:10 分摊
    expect(unexplained[1]).toBeCloseTo(5, 6)
    expect(rows[0]?.verdict).toBe('TIME') // 第一天：时间口径 15（30−15）与未解释 15 并列，取靠前的时间口径
    for (const row of rows) {
      const sum = Object.values(row.parts ?? {}).reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(row.impact?.net ?? NaN, 6)
    }
  })

  it('容差内的小差额算一致', () => {
    expect(compareDays([day('2026-10-20', official({ sales: 100.03 }), ours())], { withCost: false })[0]?.verdict).toBe('MATCH')
  })

  it('无法核对：我方一天都没有记录、官方一天都没有记录、官方币种不是美元；不当作全部差异', () => {
    const noOurs = compareDays([day('2026-10-20', official(), null)], { withCost: false })[0]
    expect(noOurs).toMatchObject({ verdict: 'NOT_COMPARABLE', notComparable: 'OURS_NO_RECORD', impact: null, parts: null, ours: { state: 'NO_RECORD', sales: null } })
    const noOfficial = compareDays([day('2026-10-20', null, ours())], { withCost: false })[0]
    expect(noOfficial).toMatchObject({ verdict: 'NOT_COMPARABLE', notComparable: 'OFFICIAL_NO_RECORD' })
    const cad = compareDays([day('2026-10-20', official({ currency: 'CAD' }), ours())], { withCost: false })[0]
    expect(cad).toMatchObject({ verdict: 'NOT_COMPARABLE', notComparable: 'CURRENCY_MISMATCH' })
  })

  it('同一 SKU 某天只有一边有记录：按 0 核对并写明，不整体判为无法核对', () => {
    const rows = compareDays([day('2026-10-20', official(), ours()), day('2026-10-21', official(), null)], { withCost: false })
    expect(rows[1]?.verdict).not.toBe('NOT_COMPARABLE')
    expect(rows[1]?.notes.join()).toContain('我方这一天没有记录')
  })

  it('结论取绝对值最大的一类；并列取成本、广告、时间、未解释中靠前的', () => {
    expect(verdictOf({ COST: -5, ADS: 3, TIME: 1, UNEXPLAINED: 0 })).toBe('COST')
    expect(verdictOf({ COST: 0, ADS: -4, TIME: 4, UNEXPLAINED: 0 })).toBe('ADS')
    expect(verdictOf({ COST: 0.01, ADS: -0.04, TIME: 0, UNEXPLAINED: 0.05 })).toBe('MATCH')
  })
})

describe('汇总', () => {
  const rows = compareDays([day('2026-10-20', official({ ads: 8 }), ours()), day('2026-10-20', official(), null, 'SKU-B'), day('2026-10-21', official(), ours(), 'SKU-C')], { withCost: false })

  it('只汇总可核对的行；无法核对的另计；差异按来源合计', () => {
    const summary = summarizeCompare(rows)
    expect(summary).toMatchObject({ rows: 3, comparable: 2, matched: 1, notComparable: 1, netDiff: -8 })
    expect(summary.byClass.ADS).toEqual({ amount: -8, rows: 1 })
    expect(summary.official.sales).toBe(200)
    expect(summary.ours.ads).toBeNull() // 我方广告没有分摊：没有值，不是 0
  })

  it('没有任何可核对的行：净差异与合计为 null', () => {
    const none = summarizeCompare(compareDays([day('2026-10-20', official(), null)], { withCost: false }))
    expect(none).toMatchObject({ comparable: 0, netDiff: null, official: { sales: null }, ours: { sales: null } })
  })
})

describe('店铺广告核对', () => {
  it('官方没有记录、我方没接入、两边都有：三种状态分别如实表达', () => {
    expect(adsStoreCheck({ officialRows: 0, official: 0, oursRows: 3, ours: 5 })).toMatchObject({ state: 'NO_DATA', official: null, diff: null })
    expect(adsStoreCheck({ officialRows: 3, official: 12, oursRows: 0, ours: null })).toMatchObject({ state: 'NOT_CONNECTED', official: 12, ours: null, diff: null })
    expect(adsStoreCheck({ officialRows: 3, official: 12, oursRows: 3, ours: 10 })).toMatchObject({ state: 'OK', diff: 2 })
  })
})

describe('费用预览的利润影响', () => {
  it('单件费用上涨对利润是负影响；没有调整、没有预估数量时不编造数', () => {
    expect(previewImpact(0.6, 100)).toEqual({ impact: -60, state: 'OK' })
    expect(previewImpact(-0.2, 50)).toEqual({ impact: 10, state: 'OK' })
    expect(previewImpact(null, 100)).toEqual({ impact: null, state: 'NO_CHANGE' })
    expect(previewImpact(0, 100)).toEqual({ impact: null, state: 'NO_CHANGE' })
    expect(previewImpact(0.6, null)).toEqual({ impact: null, state: 'UNKNOWN_QUANTITY' })
  })
})

describe('请求校验', () => {
  it('核对查询：默认口径与过滤；非法值拒绝', () => {
    expect(EconomicsCompareQuerySchema.parse({})).toMatchObject({ recognition: 'ORDERED', verdict: 'ALL' })
    expect(EconomicsCompareQuerySchema.parse({ verdict: 'ADS', recognition: 'SETTLED' })).toMatchObject({ verdict: 'ADS', recognition: 'SETTLED' })
    expect(() => EconomicsCompareQuerySchema.parse({ verdict: 'BAD' })).toThrow()
    expect(() => EconomicsCompareQuerySchema.parse({ recognition: 'X' })).toThrow()
  })

  it('预览查询：只看有调整的行转成布尔', () => {
    expect(EconomicsPreviewQuerySchema.parse({ changedOnly: 'true' }).changedOnly).toBe(true)
    expect(EconomicsPreviewQuerySchema.parse({}).changedOnly).toBe(false)
    expect(() => EconomicsPreviewQuerySchema.parse({ changedOnly: 'yes' })).toThrow()
  })

  it('模拟请求：发往上游仓储必须给数量，原包装发货不能给数量；单价最多两位小数', () => {
    const base = { sellerAccountId: 'sa1', sku: 'SKU-A' }
    expect(EconomicsSimulateBodySchema.parse({ ...base, actionType: 'AWD', quantity: 500 })).toMatchObject({ endInDays: 30 })
    expect(EconomicsSimulateBodySchema.parse({ ...base, actionType: 'SIPP', itemPrice: 19.99 })).toMatchObject({ itemPrice: 19.99 })
    expect(() => EconomicsSimulateBodySchema.parse({ ...base, actionType: 'AWD' })).toThrow('数量')
    expect(() => EconomicsSimulateBodySchema.parse({ ...base, actionType: 'SIPP', quantity: 5 })).toThrow('不需要数量')
    expect(() => EconomicsSimulateBodySchema.parse({ ...base, actionType: 'SIPP', itemPrice: 1.234 })).toThrow('两位小数')
    expect(() => EconomicsSimulateBodySchema.parse({ ...base, actionType: 'FBA' })).toThrow()
    expect(() => EconomicsSimulateBodySchema.parse({ ...base, actionType: 'AWD', quantity: 1, extra: 1 })).toThrow()
  })
})

describe('数据集新鲜度来源', () => {
  it('官方单品经济与费用预览各有一个键，按数据集标识查找；情景模拟不登记', () => {
    expect(DATASET_FRESHNESS_SOURCES.map(source => source.key)).toEqual(expect.arrayContaining(['dk.economics', 'dk.economics.preview']))
    expect(freshnessSourceOfDataset('dk.economics-preview')?.key).toBe('dk.economics.preview')
    expect(freshnessSourceOfDataset('dk.economics-simulation')).toBeUndefined()
    expect(freshnessSourceOfDataset(null)).toBeUndefined()
  })
})
