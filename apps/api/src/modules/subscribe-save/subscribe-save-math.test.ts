import { describe, expect, it } from 'vitest'
import { snsReplenishmentGate } from '@nova/api-contracts'
import { demand } from '../inventory/inventory-fixtures.test-helper'
import { adjustDemand } from '../replenishment/replenishment-math'
import { asinRowsOf, buildCards, forecastTotals, latestActive, mainCurrency, matchesOffer, monthsOf, offerRowOf, trendOf, windowTotals, type MetricRow, type OfferRecord } from './subscribe-save-math'
import { compareText, decodeOffset, pageOf, sortByNumber } from './subscribe-save-page'

// 订阅省纯计算（P4-06）：合计与币种、活跃订阅、趋势与月度、预计出货（含快照过期）、指标卡的各种状态、ASIN 合并与报价行、与补货计算的一致性。

const TODAY = '2026-10-24'
const day = (metricDate: string, over: Partial<MetricRow> = {}): MetricRow => ({
  sellerAccountId: 's1',
  granularity: 'DAY',
  metricDate,
  activeSubscribers: 40,
  shippedUnits: 10,
  revenue: 100,
  currency: 'USD',
  ...over,
})
const offer = (over: Partial<OfferRecord> = {}): OfferRecord => ({
  id: 'o1',
  sellerAccountId: 's1',
  storeName: '美国主店',
  snapshotDate: '2026-10-23',
  sku: 'SKU-A',
  asin: 'B0AAAAAAA1',
  eligibility: 'ELIGIBLE',
  fulfillment: 'AMAZON',
  sellerFundedBasePct: 10,
  price: 19.99,
  currency: 'USD',
  inventory: 120,
  stockRisk: null,
  subscriptions: 30,
  forecastNext30: 90,
  forecastNext60: 170,
  forecastNext90: 240,
  shippedUnitsPrevMonth: 60,
  prevMonthDays: 30,
  ...over,
})

describe('指标合计与币种', () => {
  it('范围内日级行：件数相加、金额按币种分别相加，范围外与月度行不算；没有记录是 null', () => {
    const rows = [day('2026-10-20'), day('2026-10-21', { shippedUnits: 5, revenue: 50 }), day('2026-10-19'), day('2026-10-01', { granularity: 'MONTH', shippedUnits: 999 })]
    expect(windowTotals(rows, '2026-10-20', '2026-10-24')).toEqual({ shippedUnits: 15, revenue: [{ currency: 'USD', amount: 150 }], unknownCurrencyRows: 0, dataDays: 2 })
    expect(windowTotals(rows, '2026-11-01', '2026-11-05')).toEqual({ shippedUnits: null, revenue: [], unknownCurrencyRows: 0, dataDays: 0 })
  })

  it('亚马逊没给的值保持 null，不当 0；给了 0 就是 0', () => {
    expect(windowTotals([day('2026-10-20', { shippedUnits: null, revenue: null })], '2026-10-20', '2026-10-20').shippedUnits).toBeNull()
    expect(windowTotals([day('2026-10-20', { shippedUnits: 0, revenue: 0 })], '2026-10-20', '2026-10-20')).toMatchObject({ shippedUnits: 0, revenue: [{ currency: 'USD', amount: 0 }] })
  })

  it('不同币种不相加；没有币种的销售额不计入任何币种并计数', () => {
    const rows = [day('2026-10-20'), day('2026-10-21', { currency: 'CAD', revenue: 300 }), day('2026-10-22', { currency: null, revenue: 77 })]
    const totals = windowTotals(rows, '2026-10-20', '2026-10-24')
    expect(totals.revenue).toEqual([
      { currency: 'CAD', amount: 300 },
      { currency: 'USD', amount: 100 },
    ])
    expect(totals.unknownCurrencyRows).toBe(1)
    expect(mainCurrency(totals.revenue)).toBe('CAD')
    expect(mainCurrency([])).toBeNull()
    expect(
      mainCurrency([
        { currency: 'USD', amount: 5 },
        { currency: 'CAD', amount: 5 },
      ]),
    ).toBe('CAD')
  })

  it('金额合计按两位小数取整，避免浮点尾巴', () => {
    const rows = [day('2026-10-20', { revenue: 0.1 }), day('2026-10-21', { revenue: 0.2 })]
    expect(windowTotals(rows, '2026-10-20', '2026-10-21').revenue).toEqual([{ currency: 'USD', amount: 0.3 }])
  })
})

describe('活跃订阅数', () => {
  it('每个店铺取最近一个有值的日级行，店铺相加；asOf 取最早的一天', () => {
    const rows = [
      day('2026-10-20', { activeSubscribers: 10 }),
      day('2026-10-22', { activeSubscribers: 12 }),
      day('2026-10-23', { activeSubscribers: null }),
      day('2026-10-21', { sellerAccountId: 's2', activeSubscribers: 5 }),
    ]
    expect(latestActive(rows, '2026-10-24')).toEqual({ value: 17, asOf: '2026-10-21' })
  })

  it('晚于范围终点的行不算；都没有值是 null', () => {
    expect(latestActive([day('2026-10-25', { activeSubscribers: 9 })], '2026-10-24')).toBeNull()
    expect(latestActive([day('2026-10-20', { activeSubscribers: null })], '2026-10-24')).toBeNull()
  })
})

describe('趋势与月度', () => {
  it('逐日点：没有记录的日期是 null（图上断开）；同一天多个店铺相加；金额只取趋势币种', () => {
    const rows = [day('2026-10-21'), day('2026-10-21', { sellerAccountId: 's2', shippedUnits: 4, revenue: 40 }), day('2026-10-23', { currency: 'CAD', revenue: 9 })]
    const points = trendOf(rows, '2026-10-20', '2026-10-23', 'USD')
    expect(points.map(point => point.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'])
    expect(points[0]).toEqual({ date: '2026-10-20', activeSubscribers: null, shippedUnits: null, revenue: null })
    expect(points[1]).toEqual({ date: '2026-10-21', activeSubscribers: 80, shippedUnits: 14, revenue: 140 })
    expect(points[3]).toMatchObject({ shippedUnits: 10, revenue: null })
    expect(trendOf(rows, '2026-10-21', '2026-10-21', null)[0]?.revenue).toBeNull()
  })

  it('月度：按月份从早到晚、只取最近几个月、各店铺相加', () => {
    const month = (metricDate: string, over: Partial<MetricRow> = {}) => day(metricDate, { granularity: 'MONTH', ...over })
    const rows = [
      month('2026-09-01', { shippedUnits: 300 }),
      month('2026-07-01', { shippedUnits: 100 }),
      month('2026-08-01', { shippedUnits: 200 }),
      month('2026-09-01', { sellerAccountId: 's2', shippedUnits: 50 }),
      day('2026-10-20'),
    ]
    const months = monthsOf(rows, 'USD', 2)
    expect(months.map(item => item.month)).toEqual(['2026-08', '2026-09'])
    expect(months[1]).toMatchObject({ shippedUnits: 350, revenue: 200 })
  })
})

describe('报价汇总与预计出货', () => {
  it('预计出货只加快照在 7 天内的店铺；过期店铺列名不计入', () => {
    const offers = [
      offer(),
      offer({ id: 'o2', sku: 'SKU-B', forecastNext30: 10, forecastNext60: null }),
      offer({ id: 'o3', sellerAccountId: 's2', storeName: '老店', snapshotDate: '2026-10-10', forecastNext30: 1000 }),
    ]
    const totals = forecastTotals(offers, TODAY)
    expect(totals).toMatchObject({ offers: 3, freshOffers: 2, forecast30: 100, forecast60: 170, forecast90: 480, staleStores: ['老店'], snapshotDate: '2026-10-23', offersWithForecast: 3 })
  })

  it('快照正好差 7 天仍有效；全部过期时没有预测；没有报价时为空', () => {
    expect(forecastTotals([offer({ snapshotDate: '2026-10-17' })], TODAY).freshOffers).toBe(1)
    const stale = forecastTotals([offer({ snapshotDate: '2026-10-16' })], TODAY)
    expect(stale).toMatchObject({ freshOffers: 0, forecast30: null, staleStores: ['美国主店'] })
    expect(forecastTotals([], TODAY)).toMatchObject({ offers: 0, snapshotDate: null, forecast30: null })
  })

  it('可订阅状态分组：可订阅、不可订阅或已暂停、未提供', () => {
    const totals = forecastTotals([offer(), offer({ id: 'b', eligibility: 'INELIGIBLE' }), offer({ id: 'c', eligibility: 'SUSPENDED' }), offer({ id: 'd', eligibility: null })], TODAY)
    expect(totals).toMatchObject({ eligible: 1, blocked: 2, unknownEligibility: 1 })
  })
})

describe('指标卡', () => {
  const empty = { shippedUnits: null, revenue: [], unknownCurrencyRows: 0, dataDays: 0 }
  const byKey = (cards: ReturnType<typeof buildCards>, key: string) => cards.find(card => card.key === key)!

  it('什么都没有：除“取消数”写尚未接入外全部是尚无记录，没有一张写 0', () => {
    const cards = buildCards({ current: empty, previous: null, rangeDays: 30, active: null, forecast: forecastTotals([], TODAY) })
    expect(cards).toHaveLength(8)
    for (const card of cards) expect(card.value, card.key).toBeNull()
    expect(byKey(cards, 'cancellations')).toMatchObject({ state: 'NOT_CONNECTED' })
    expect(cards.filter(card => card.key !== 'cancellations').every(card => card.state === 'NO_DATA')).toBe(true)
  })

  it('有数据：数字、对比期、币种与其他币种、覆盖天数、依据的快照日期', () => {
    const current = windowTotals([day('2026-10-20'), day('2026-10-21', { currency: 'CAD', revenue: 20 })], '2026-10-20', '2026-10-24')
    const previous = windowTotals([day('2026-10-10', { shippedUnits: 5, revenue: 50 })], '2026-10-10', '2026-10-14')
    const cards = buildCards({ current, previous, rangeDays: 5, active: { value: 41, asOf: '2026-10-21' }, forecast: forecastTotals([offer()], TODAY) })
    expect(byKey(cards, 'activeSubscribers')).toMatchObject({ value: 41, note: '截至 2026-10-21' })
    expect(byKey(cards, 'shippedUnits')).toMatchObject({ value: 20, previous: 5, note: '范围内 2 / 5 天有日级记录' })
    expect(byKey(cards, 'revenue')).toMatchObject({ value: 100, currency: 'USD', previous: 50, others: [{ currency: 'CAD', amount: 20 }] })
    expect(byKey(cards, 'forecast30')).toMatchObject({ state: 'OK', value: 90, note: '依据 2026-10-23 的报价快照' })
    expect(byKey(cards, 'offers')).toMatchObject({ value: 1, note: '可订阅 1' })
  })

  it('预测：快照全部过期写“数据已过期”；有报价但亚马逊没给这个时间段的预测写尚无记录；部分店铺过期会说明', () => {
    const stale = buildCards({ current: empty, previous: null, rangeDays: 30, active: null, forecast: forecastTotals([offer({ snapshotDate: '2026-10-01' })], TODAY) })
    expect(byKey(stale, 'forecast30')).toMatchObject({ state: 'STALE', value: null })
    const none = buildCards({ current: empty, previous: null, rangeDays: 30, active: null, forecast: forecastTotals([offer({ forecastNext60: null })], TODAY) })
    expect(byKey(none, 'forecast60')).toMatchObject({ state: 'NO_DATA', value: null })
    const mixed = buildCards({
      current: empty,
      previous: null,
      rangeDays: 30,
      active: null,
      forecast: forecastTotals([offer(), offer({ id: 'x', sellerAccountId: 's2', storeName: '老店', snapshotDate: '2026-10-01' })], TODAY),
    })
    expect(byKey(mixed, 'forecast30').note).toContain('老店 的快照已过期，未计入')
  })

  it('销售额没有币种：不计入并说明', () => {
    const current = windowTotals([day('2026-10-20', { currency: null })], '2026-10-20', '2026-10-20')
    const card = byKey(buildCards({ current, previous: null, rangeDays: 1, active: null, forecast: forecastTotals([], TODAY) }), 'revenue')
    expect(card).toMatchObject({ state: 'NO_DATA', value: null, note: '1 条记录没有币种，未计入' })
  })
})

describe('明细行', () => {
  it('同店铺同 ASIN 的多个 SKU 合并：件数相加、没有一条给值就是 null；SKU 列表排序；没有 ASIN 的按 SKU 单独成行；其他店铺不合并', () => {
    const rows = asinRowsOf(
      [
        offer({ id: '1', sku: 'SKU-B', subscriptions: 5, forecastNext30: 10, forecastNext60: null }),
        offer({ id: '2', sku: 'SKU-A', subscriptions: null, forecastNext30: 20, forecastNext60: null }),
        offer({ id: '3', sku: 'SKU-C', asin: '' }),
        offer({ id: '4', sellerAccountId: 's2', storeName: '另一家', sku: 'SKU-A' }),
      ],
      TODAY,
    )
    expect(rows).toHaveLength(3)
    const merged = rows.find(row => row.asin === 'B0AAAAAAA1' && row.sellerAccountId === 's1')!
    expect(merged).toMatchObject({ skus: ['SKU-A', 'SKU-B'], subscriptions: 5, forecastNext30: 30, forecastNext60: null, productId: null })
    expect(rows.find(row => row.asin === '')?.skus).toEqual(['SKU-C'])
  })

  it('补货采用：任一报价被采用就算采用，否则写第一条的原因', () => {
    const [usedRow] = asinRowsOf([offer({ id: '1', sku: 'A', forecastNext30: null }), offer({ id: '2', sku: 'B' })], TODAY)
    expect(usedRow?.replenishment).toEqual({ used: true, reason: null })
    const [blocked] = asinRowsOf([offer({ id: '1', sku: 'A', eligibility: 'SUSPENDED' })], TODAY)
    expect(blocked?.replenishment).toEqual({ used: false, reason: 'INELIGIBLE' })
  })

  it('报价行：状态中文、折扣、补货原因', () => {
    const row = offerRowOf(offer({ eligibility: 'INELIGIBLE', stockRisk: 'HIGH' }), TODAY)
    expect(row).toMatchObject({ key: 's1|SKU-A', eligibilityLabel: '不可订阅', discountPct: 10, price: 19.99, stockRisk: 'HIGH', replenishment: { used: false, reason: 'INELIGIBLE' } })
    expect(offerRowOf(offer({ eligibility: null }), TODAY).eligibilityLabel).toBe('未提供')
  })

  it('搜索匹配 SKU 或 ASIN，包含、不区分大小写', () => {
    expect(matchesOffer(offer(), 'sku-a')).toBe(true)
    expect(matchesOffer(offer(), 'b0aaa')).toBe(true)
    expect(matchesOffer(offer(), 'nope')).toBe(false)
    expect(matchesOffer(offer(), undefined)).toBe(true)
  })
})

describe('与补货计算的一致性', () => {
  const cases: Array<[string, Partial<OfferRecord>]> = [
    ['满足全部条件', {}],
    ['快照超过 7 天', { snapshotDate: '2026-10-10' }],
    ['快照正好 7 天', { snapshotDate: '2026-10-17' }],
    ['不可订阅', { eligibility: 'INELIGIBLE' }],
    ['已暂停', { eligibility: 'SUSPENDED' }],
    ['没有可订阅状态', { eligibility: null }],
    ['没有未来预测', { forecastNext30: null }],
    ['没有上月出货', { shippedUnitsPrevMonth: null }],
    ['没有上月天数', { prevMonthDays: null }],
    ['预测与上月出货都是 0', { forecastNext30: 0, shippedUnitsPrevMonth: 0 }],
  ]
  it.each(cases)('订阅省页面与补货第 1 步对“是否叠加”的判断相同：%s', (_name, over) => {
    const record = offer(over)
    const engine = adjustDemand(
      demand(),
      {
        forecastNext30: record.forecastNext30,
        shippedUnitsPrevMonth: record.shippedUnitsPrevMonth,
        prevMonthDays: record.prevMonthDays,
        snapshotDate: record.snapshotDate,
        eligibility: record.eligibility,
      },
      TODAY,
    )
    expect(snsReplenishmentGate(record, TODAY).used).toBe(engine?.subscribe.used)
  })
})

// 游标要签名密钥：测试里给一个固定值（接口服务启动时由环境变量提供）
process.env.CURSOR_SIGNING_KEY ??= 'x'.repeat(40)

describe('分页与排序（位置游标）', () => {
  it('按数值排序：没有值的排最后（升降序都一样），并列按键稳定', () => {
    const rows = [
      { key: 'c', v: null },
      { key: 'b', v: 5 },
      { key: 'a', v: 5 },
      { key: 'd', v: 9 },
    ]
    expect(sortByNumber(rows, row => row.v, 'desc').map(row => row.key)).toEqual(['d', 'a', 'b', 'c'])
    expect(sortByNumber(rows, row => row.v, 'asc').map(row => row.key)).toEqual(['a', 'b', 'd', 'c'])
    expect(compareText('a', 'b')).toBe(-1)
  })

  it('切页：第一页有下一页游标，用游标取第二页不重不漏；条件变了游标失效', () => {
    const items = ['1', '2', '3', '4', '5']
    const first = pageOf(items, 0, 2, 'bind')
    expect(first.page).toEqual(['1', '2'])
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 5 })
    const offset = decodeOffset(first.pageInfo.nextCursor ?? undefined, 'bind')
    expect(offset).toBe(2)
    const last = pageOf(items, 4, 2, 'bind')
    expect(last).toMatchObject({ page: ['5'], pageInfo: { hasMore: false, nextCursor: null } })
    expect(() => decodeOffset(first.pageInfo.nextCursor ?? undefined, 'other')).toThrow()
    expect(decodeOffset(undefined, 'bind')).toBe(0)
  })
})
