import { BA_REPORT_TYPES } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { reportImporterFor } from '../../connectors/report-import'
import { jsonArrayRows } from '../../streaming/json-array'
import type { Row } from '../../streaming/rows'
import { fakeContext } from '../inventory/fake-context.test-helper'
import { brandImporterFor } from './registry'
import { readPeriod } from './parse'
import { readSqpRow } from './search-query'

// 品牌分析五份报告（P4-04，R-35 至 R-39）的导入：周期（行内起止日或申请窗口）、字段映射、官方没给的值是 null、非法值不入库、
// 同一个搜索词的多行按点击份额排名合并、排名超过上限的热门搜索词不导入。字段名对照官方样例整理，没有对真实店铺核对。

const NOW = new Date('2026-10-22T08:00:00Z')
const WEEK = { from: new Date('2026-10-11T00:00:00Z'), to: new Date('2026-10-17T00:00:00Z') }
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const usd = (amount: number) => ({ amount, currencyCode: 'USD' })

async function* rows(...items: Row[]) {
  for (const item of items) yield item
}
const run = (type: string, items: Row[], options: { from?: Date | null; to?: Date | null } = WEEK) => {
  const fake = fakeContext()
  const importer = brandImporterFor(type, scope, { reportJobId: 'rj1', now: NOW, ...options })!
  return { fake, done: importer(fake.ctx, rows(...items)) }
}

describe('周期', () => {
  it('行内起止日优先；没有则取申请窗口；不是对齐的周、月、季为空', () => {
    expect(readPeriod({ startDate: '2026-10-04', endDate: '2026-10-10' }, WEEK)).toEqual({ kind: 'WEEK', start: '2026-10-04', end: '2026-10-10' })
    expect(readPeriod({}, WEEK)).toEqual({ kind: 'WEEK', start: '2026-10-11', end: '2026-10-17' })
    expect(readPeriod({}, { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') })?.kind).toBe('MONTH')
    expect(readPeriod({}, { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') })?.kind).toBe('QUARTER')
    expect(readPeriod({}, { from: new Date('2026-10-12T00:00:00Z'), to: new Date('2026-10-18T00:00:00Z') })).toBeNull() // 周一起算的周
    expect(readPeriod({}, {})).toBeNull()
  })
})

describe('注册与分发', () => {
  it('五种报告类型都有导入器，其他类型返回空；分发层能按类型选到', () => {
    for (const type of BA_REPORT_TYPES) {
      expect(brandImporterFor(type, scope, {}), type).toBeTypeOf('function')
      expect(
        reportImporterFor({ id: 'rj', reportType: type, documentId: 'd', sellerAccountId: 'sa1', ...WEEK }, { tenantId: 't1', sellerAccountId: 'sa1', marketplaceId: 'ATVPDKIKX0DER' }),
      ).toBeTypeOf('function')
    }
    expect(brandImporterFor('GET_SALES_AND_TRAFFIC_REPORT', scope, {})).toBeNull()
  })
})

const sqpRow = (over: Row = {}): Row => ({
  startDate: '2026-10-11',
  endDate: '2026-10-17',
  asin: 'b0abcdef12',
  searchQueryData: { searchQuery: 'Yoga Mat', searchQueryScore: 3, searchQueryVolume: 12000 },
  impressionData: { totalQueryImpressionCount: 1000, asinImpressionCount: 250, asinImpressionShare: 0.25 },
  clickData: { totalClickCount: 400, asinClickCount: 80, asinClickShare: 0.2, totalMedianClickPrice: usd(20), asinMedianClickPrice: usd(22) },
  cartAddData: { totalCartAddCount: 100, asinCartAddCount: 15, asinCartAddShare: 0.15, totalMedianCartAddPrice: usd(21), asinMedianCartAddPrice: usd(22) },
  purchaseData: {
    totalPurchaseCount: 50,
    asinPurchaseCount: 5,
    asinPurchaseShare: 0.1,
    totalMedianPurchasePrice: usd(20.5),
    asinMedianPurchasePrice: usd(22),
    totalSameDayShippingPurchaseCount: 5,
    asinSameDayShippingPurchaseCount: 1,
    totalOneDayShippingPurchaseCount: 20,
    asinOneDayShippingPurchaseCount: 2,
    totalTwoDayShippingPurchaseCount: 25,
    asinTwoDayShippingPurchaseCount: 2,
  },
  ...over,
})

describe('R-35 搜索查询表现', () => {
  it('字段映射：搜索词统一小写、ASIN 大写；总量与我方两套次数、份额、价格、配送速度各归其列', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', [sqpRow()])
    expect(await done).toEqual({ imported: 1, read: 1, skipped: 0 })
    const [call] = fake.of('brandSearchQueryPerformance')
    expect(call.args.where.tenantId_sellerAccountId_reportPeriod_periodStart_asin_searchQuery).toMatchObject({ reportPeriod: 'WEEK', asin: 'B0ABCDEF12', searchQuery: 'yoga mat' })
    expect(call.args.create).toMatchObject({
      searchQueryScore: 3,
      searchVolume: 12000,
      impressionsTotal: 1000,
      impressionsOwn: 250,
      impressionShare: 0.25,
      clicksOwn: 80,
      cartAddsTotal: 100,
      purchasesTotal: 50,
      purchaseShare: 0.1,
      clickPriceOwn: 22,
      purchasePriceTotal: 20.5,
      currency: 'USD',
      purchasesSameDayOwn: 1,
      purchasesTwoDayTotal: 25,
      sourceReportJobId: 'rj1',
      sourceUpdatedAt: NOW,
    })
    expect(call.args.create.periodEnd.toISOString()).toBe('2026-10-17T00:00:00.000Z')
    expect(call.args.update.asin).toBeUndefined() // 更新不改身份列
  })

  it('官方没给的值是 null 不是 0；越界的份额、负数与超过整型上限的次数当作没给', () => {
    const parsed = readSqpRow(
      sqpRow({ impressionData: { totalQueryImpressionCount: -5, asinImpressionCount: 3_000_000_000, asinImpressionShare: 1.5 }, clickData: {}, purchaseData: { asinPurchaseShare: '0.3' } }),
      WEEK,
    )!
    expect(parsed.values).toMatchObject({
      impressionsTotal: null,
      impressionsOwn: null,
      impressionShare: null,
      clicksTotal: null,
      clickShare: null,
      purchasesTotal: null,
      purchaseShare: 0.3,
      clickPriceOwn: null,
    })
    expect(parsed.values.currency).toBe('USD') // 取自还在的购物车价格
  })

  it('缺周期、ASIN 或搜索词的行跳过；全部读到但一行没写会让分发层报失败（这里只检查计数）', async () => {
    const bad = [sqpRow({ asin: 'short' }), sqpRow({ searchQueryData: {} }), sqpRow({ startDate: '2026-10-12', endDate: '2026-10-18' })]
    const { fake, done } = run('GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', bad)
    expect(await done).toEqual({ imported: 0, read: 3, skipped: 3 })
    expect(fake.of('brandSearchQueryPerformance')).toHaveLength(0)
    expect(fake.warn).toHaveBeenCalled()
  })

  it('整份 JSON 文档流式读入：说明与数组外的内容不当成记录', async () => {
    const text = JSON.stringify({ reportSpecification: { marketplaceIds: ['ATVPDKIKX0DER'] }, dataByAsin: [sqpRow(), sqpRow({ asin: 'B0ABCDEF13' })] })
    const fake = fakeContext()
    async function* chunks() {
      for (let index = 0; index < text.length; index += 37) yield text.slice(index, index + 37)
    }
    const importer = brandImporterFor('GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT', scope, { now: NOW })!
    expect(await importer(fake.ctx, jsonArrayRows(chunks()))).toMatchObject({ imported: 2, read: 2 })
  })
})

describe('R-36 目录表现', () => {
  it('漏斗计数、官方点击率与转化率、搜索流量销售额与价格中位数', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT', [
      {
        asin: 'B0ABCDEF12',
        impressionData: { impressionCount: 10000, impressionMedianPrice: usd(19) },
        clickData: { clickCount: 400, clickRate: 0.04, clickedMedianPrice: usd(20) },
        cartAddData: { cartAddCount: 60, cartAddedMedianPrice: usd(21) },
        purchaseData: { purchaseCount: 30, searchTrafficSales: usd(660), conversionRate: 0.075, purchasedMedianPrice: usd(22) },
      },
      { asin: 'B0ABCDEF13' }, // 只有 ASIN：写入全空指标，不是 0
    ])
    expect(await done).toEqual({ imported: 2, read: 2, skipped: 0 })
    const [first, second] = fake.of('brandSearchCatalogPerformance')
    expect(first.args.create).toMatchObject({
      reportPeriod: 'WEEK',
      impressions: 10000,
      clicks: 400,
      cartAdds: 60,
      purchases: 30,
      clickRate: 0.04,
      conversionRate: 0.075,
      searchTrafficSales: 660,
      purchaseMedianPrice: 22,
      currency: 'USD',
    })
    expect(second.args.create).toMatchObject({ impressions: null, clickRate: null, searchTrafficSales: null, currency: null })
  })
})

describe('R-37 热门搜索词', () => {
  const term = (over: Row): Row => ({
    departmentName: 'Sports',
    searchTerm: 'Yoga Mat',
    searchFrequencyRank: 120,
    clickedAsin: 'B0ABCDEF12',
    clickedItemName: 'Mat A',
    clickShareRank: 1,
    clickShare: 0.3,
    conversionShare: 0.2,
    ...over,
  })

  it('同一个词的多行按点击份额排名合并进同一行的三组列；更新只写这一组，不抹掉别的组', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [
      term({}),
      term({ clickShareRank: 2, clickedAsin: 'B0ABCDEF13', clickedItemName: 'Mat B', clickShare: 0.2, conversionShare: 0.1 }),
    ])
    expect(await done).toEqual({ imported: 2, read: 2, skipped: 0 })
    const [first, second] = fake.of('brandSearchTerm')
    expect(first.args.where.tenantId_sellerAccountId_reportPeriod_periodStart_department_searchTerm).toMatchObject({ department: 'Sports', searchTerm: 'yoga mat' })
    expect(first.args.create).toMatchObject({ searchFrequencyRank: 120, clickedAsin1: 'B0ABCDEF12', clickedTitle1: 'Mat A', clickShare1: 0.3, conversionShare1: 0.2 })
    expect(second.args.update).toMatchObject({ clickedAsin2: 'B0ABCDEF13', clickShare2: 0.2 })
    expect(second.args.update.clickedAsin1).toBeUndefined()
    expect(second.args.where).toEqual(first.args.where)
  })

  it('排名超过上限或点击份额排名不在 1 至 3 的行不导入（忽略，不是跳过）；没有搜索频率排名的行跳过', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [
      term({ searchFrequencyRank: 20_001 }),
      term({ clickShareRank: 4 }),
      term({ searchFrequencyRank: null }),
      term({ searchFrequencyRank: 20_000 }),
    ])
    expect(await done).toEqual({ imported: 1, read: 4, skipped: 1 })
    expect(fake.of('brandSearchTerm')).toHaveLength(1)
  })

  it('部门缺失存空串（唯一键用）', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [term({ departmentName: undefined })])
    await done
    expect(fake.of('brandSearchTerm')[0].args.create.department).toBe('')
  })
})

describe('R-38 购物篮', () => {
  it('同篮率与排名；自己和自己配对、非法 ASIN 的行跳过；兼容 pairedAsin 写法', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT', [
      { asin: 'B0ABCDEF12', purchasedAsin: 'B0ZZZZZZ01', combinationPct: 0.12, purchasedRank: 1 },
      { asin: 'B0ABCDEF12', pairedAsin: 'B0ZZZZZZ02', combinationPct: 0.06, purchaseRank: 2 },
      { asin: 'B0ABCDEF12', purchasedAsin: 'B0ABCDEF12', combinationPct: 0.5 },
      { asin: 'B0ABCDEF12', purchasedAsin: 'bad', combinationPct: 0.5 },
    ])
    expect(await done).toEqual({ imported: 2, read: 4, skipped: 2 })
    const [a, b] = fake.of('brandMarketBasket')
    expect(a.args.create).toMatchObject({ asin: 'B0ABCDEF12', pairedAsin: 'B0ZZZZZZ01', combinationPct: 0.12, purchaseRank: 1 })
    expect(b.args.create).toMatchObject({ pairedAsin: 'B0ZZZZZZ02', combinationPct: 0.06, purchaseRank: 2 })
  })
})

describe('R-39 重复购买', () => {
  it('订单数、买家数、复购买家占比、复购金额与币种；没给的是 null', async () => {
    const { fake, done } = run('GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT', [
      { asin: 'B0ABCDEF12', orders: 120, uniqueCustomers: 100, repeatCustomersPctTotal: 0.18, repeatPurchaseRevenue: usd(900), repeatPurchaseRevenuePctTotal: 0.22 },
      { asin: 'B0ABCDEF13', orders: 10 },
    ])
    expect(await done).toEqual({ imported: 2, read: 2, skipped: 0 })
    const [a, b] = fake.of('brandRepeatPurchase')
    expect(a.args.create).toMatchObject({ orders: 120, uniqueCustomers: 100, repeatCustomersPct: 0.18, repeatRevenue: 900, repeatRevenuePct: 0.22, currency: 'USD' })
    expect(b.args.create).toMatchObject({ orders: 10, uniqueCustomers: null, repeatCustomersPct: null, repeatRevenue: null, currency: null })
  })
})
