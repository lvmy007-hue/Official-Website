import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OFFERS_PAGE_SIZE, ReplenishmentApi, isNotEnrolled } from '../../connectors/replenishment-api'
import type { AmazonSpApiClient } from '../../connectors/amazon-sp-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import { fakeContext } from '../inventory/fake-context.test-helper'
import { parseOfferUnits, parseOffers, parseSellerMetrics } from './parse'
import { previousMonth, syncSubscribeSave } from './subscribe-save'

// 订阅省同步器（I-19）：官方格式的响应样例（apps/worker/fixtures/replenishment）→ 写入的表、幂等键与关键字段；
// 不适用与缺角色的区分；分页；缺失的字段保持 null，不补 0。

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, '../../../fixtures/replenishment', name), 'utf8')) as Record<string, unknown>
const TODAY = new Date('2026-10-22T00:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const http = (status: number, message = '') => new UpstreamHttpError(`SP_API_${status}_${message}`, status, undefined, 'api')

type Stub = { listOffers: ReturnType<typeof vi.fn>; listOfferMetrics: ReturnType<typeof vi.fn>; sellerMetrics: ReturnType<typeof vi.fn> }
const stubApi = (overrides: Partial<Stub> = {}) => {
  const api: Stub = {
    listOffers: vi.fn(async () => fixture('offers.json')),
    listOfferMetrics: vi.fn(async () => fixture('offer-metrics.json')),
    sellerMetrics: vi.fn(async () => fixture('seller-metrics.json')),
    ...overrides,
  }
  return { api, as: api as unknown as ReplenishmentApi }
}

describe('响应解析', () => {
  it('报价：字段搬运；没给的是 null（不补 0）；没有 SKU 的报价计入跳过', () => {
    const page = parseOffers(fixture('offers.json'))
    expect(page.skipped).toBe(1)
    expect(page.total).toBe(3)
    expect(page.offers[0]).toEqual({
      sku: 'SKU-A',
      asin: 'B0AAAAAAA1',
      eligibility: 'ELIGIBLE',
      fulfillment: 'AMAZON',
      sellerFundedBasePct: 5,
      price: 19.99,
      currency: 'USD',
      inventory: 320,
      stockRisk: 'NEXT_30_DAYS_DELIVERIES_AT_LOW_INVENTORY_RISK',
      subscriptions: 41,
      forecastNext15: 18,
      forecastNext30: 36,
      forecastNext60: 70,
      forecastNext90: 101,
    })
    expect(page.offers[1]).toMatchObject({ sku: 'SKU-B', sellerFundedBasePct: null, forecastNext30: null, forecastNext90: null, fulfillment: null, inventory: 0, subscriptions: 0 })
  })

  it('报价指标：按 SKU 取订阅出货件数；没有 SKU 或没给出货件数的行不进结果', () => {
    const page = parseOfferUnits(fixture('offer-metrics.json'))
    expect(page.count).toBe(3)
    expect([...page.units]).toEqual([
      ['SKU-A', 30],
      ['SKU-Z', 5],
    ])
    expect(parseOfferUnits({ offers: [{ sku: 'X' }] }).units.size).toBe(0)
  })

  it('卖家指标：取时间区间起点作为日期；没有时间区间的元素计入跳过；未给的指标是 null，给出的 0 保持 0', () => {
    const parsed = parseSellerMetrics(fixture('seller-metrics.json'))
    expect(parsed.skipped).toBe(1)
    expect(parsed.metrics[0]).toEqual({ metricDate: new Date('2026-10-20T00:00:00Z'), activeSubscribers: 41, shippedUnits: 12, revenue: 239.88, currency: 'USD' })
    expect(parsed.metrics[1]).toMatchObject({ shippedUnits: 0, revenue: null, currency: null, activeSubscribers: 40 })
  })
})

describe('上一个自然月', () => {
  it('跨年与大小月', () => {
    expect(previousMonth(new Date('2026-10-22T00:00:00Z'))).toEqual({ start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-30T00:00:00Z'), days: 30 })
    expect(previousMonth(new Date('2027-01-03T00:00:00Z'))).toMatchObject({ start: new Date('2026-12-01T00:00:00Z'), days: 31 })
    expect(previousMonth(new Date('2028-03-01T00:00:00Z'))).toMatchObject({ days: 29 })
  })
})

describe('同步订阅省', () => {
  it('写入报价（带上月出货与预测）与指标；幂等键；没有上月出货的 SKU 保持 null', async () => {
    const { ctx, of } = fakeContext()
    const { api, as } = stubApi()
    const result = await syncSubscribeSave(ctx, as, scope, { today: TODAY })
    expect(result).toMatchObject({ notApplicable: false, offers: 2, metrics: 4, skipped: 3, incomplete: false })
    const offers = of('subscribeSaveOffer')
    expect(offers).toHaveLength(2)
    expect(offers[0].args.where).toEqual({ tenantId_sellerAccountId_sku_snapshotDate: { tenantId: 't1', sellerAccountId: 'sa1', sku: 'SKU-A', snapshotDate: TODAY } })
    expect(offers[0].args.create).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      sku: 'SKU-A',
      forecastNext30: 36,
      shippedUnitsPrevMonth: 30,
      prevMonthStart: new Date('2026-09-01T00:00:00Z'),
      prevMonthDays: 30,
    })
    expect(offers[1].args.create).toMatchObject({ sku: 'SKU-B', shippedUnitsPrevMonth: null, forecastNext30: null })
    const metrics = of('subscribeSaveMetric')
    expect(metrics.map(call => call.args.create.granularity)).toEqual(['DAY', 'DAY', 'MONTH', 'MONTH'])
    expect(metrics[0].args.where.tenantId_sellerAccountId_granularity_metricDate).toMatchObject({ granularity: 'DAY', metricDate: new Date('2026-10-20T00:00:00Z') })
    expect(metrics[1].args.create).toMatchObject({ shippedUnits: 0, revenue: null })
    // 请求：上月窗口是 9 月整月，近 31 天按天窗口止于昨天
    expect(api.listOfferMetrics).toHaveBeenCalledWith({ startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-30T23:59:59Z' }, 'MONTH', 0)
    expect(api.sellerMetrics.mock.calls[0]).toEqual([{ startDate: '2026-09-21T00:00:00Z', endDate: '2026-10-21T23:59:59Z' }, 'DAY'])
    expect(api.sellerMetrics.mock.calls[1][0]).toEqual({ startDate: '2026-04-01T00:00:00Z', endDate: '2026-09-30T23:59:59Z' })
  })

  it('没有开通订阅省（第一页 404）：不适用，什么都不写', async () => {
    const { ctx, calls } = fakeContext()
    const { api, as } = stubApi({ listOffers: vi.fn(async () => Promise.reject(http(404, 'not found'))) })
    expect(await syncSubscribeSave(ctx, as, scope, { today: TODAY })).toEqual({ notApplicable: true, reason: 'NOT_ENROLLED', imported: 0 })
    expect(calls).toHaveLength(0)
    expect(api.listOfferMetrics).not.toHaveBeenCalled()
  })

  it('开通了但没有任何订阅省报价：不适用；缺少角色（403）等错误不被吞掉，原样抛出', async () => {
    const empty = fakeContext()
    expect(await syncSubscribeSave(empty.ctx, stubApi({ listOffers: vi.fn(async () => ({ offers: [], pagination: { totalResults: 0 } })) }).as, scope, { today: TODAY })).toMatchObject({
      notApplicable: true,
      reason: 'NO_OFFERS',
    })
    expect(empty.calls).toHaveLength(0)
    const denied = fakeContext()
    await expect(syncSubscribeSave(denied.ctx, stubApi({ listOffers: vi.fn(async () => Promise.reject(http(403, 'Unauthorized'))) }).as, scope, { today: TODAY })).rejects.toMatchObject({
      status: 403,
    })
    await expect(syncSubscribeSave(denied.ctx, stubApi({ listOfferMetrics: vi.fn(async () => Promise.reject(http(429))) }).as, scope, { today: TODAY })).rejects.toMatchObject({ status: 429 })
  })

  it('卖家指标报“没开通”不影响报价写入；报价列表满页就翻下一页', async () => {
    const { ctx, of } = fakeContext()
    const full = { offers: Array.from({ length: OFFERS_PAGE_SIZE }, (_, i) => ({ sku: `S${i}`, asin: 'A' })) }
    const listOffers = vi.fn(async (offset: number) => (offset === 0 ? full : { offers: [{ sku: 'LAST', asin: 'A' }] }))
    const { as } = stubApi({ listOffers, sellerMetrics: vi.fn(async () => Promise.reject(http(404))) })
    const result = await syncSubscribeSave(ctx, as, scope, { today: TODAY })
    expect(listOffers.mock.calls.map(call => call[0])).toEqual([0, 100])
    expect(of('subscribeSaveOffer')).toHaveLength(OFFERS_PAGE_SIZE + 1)
    expect(result).toMatchObject({ notApplicable: false, offers: OFFERS_PAGE_SIZE + 1, metrics: 0 })
  })
})

describe('连接器与“未开通”判断', () => {
  it('三个操作都是 POST，路径、请求体与官方模型一致，固定美国站与订阅省', async () => {
    const request = vi.fn(async () => ({}))
    const api = new ReplenishmentApi({ request } as unknown as AmazonSpApiClient)
    await api.listOffers(200)
    await api.listOfferMetrics({ startDate: 'a', endDate: 'b' }, 'MONTH', 0)
    await api.sellerMetrics({ startDate: 'a', endDate: 'b' }, 'DAY')
    expect(request.mock.calls[0]).toEqual([
      {
        method: 'POST',
        path: '/replenishment/2022-11-07/offers/search',
        body: { pagination: { limit: 100, offset: 200 }, filters: { marketplaceId: 'ATVPDKIKX0DER', programTypes: ['SUBSCRIBE_AND_SAVE'] } },
      },
    ])
    expect(request.mock.calls[1]).toEqual([
      {
        method: 'POST',
        path: '/replenishment/2022-11-07/offers/metrics/search',
        body: {
          pagination: { limit: 500, offset: 0 },
          filters: {
            aggregationFrequency: 'MONTH',
            timeInterval: { startDate: 'a', endDate: 'b' },
            timePeriodType: 'PERFORMANCE',
            marketplaceId: 'ATVPDKIKX0DER',
            programTypes: ['SUBSCRIBE_AND_SAVE'],
          },
        },
      },
    ])
    expect(request.mock.calls[2][0]).toMatchObject({
      method: 'POST',
      path: '/replenishment/2022-11-07/sellingPartners/metrics/search',
      body: { aggregationFrequency: 'DAY', timePeriodType: 'PERFORMANCE', metrics: ['SHIPPED_SUBSCRIPTION_UNITS', 'TOTAL_SUBSCRIPTIONS_REVENUE', 'ACTIVE_SUBSCRIPTIONS'] },
    })
  })

  it('只有 404 与带“未开通/不符合”字样的 400 算未开通；403、429、5xx 与授权服务的错误都不算', () => {
    expect(isNotEnrolled(http(404))).toBe(true)
    expect(isNotEnrolled(http(400, 'Seller is not enrolled in Subscribe and Save'))).toBe(true)
    expect(isNotEnrolled(http(400, 'Invalid timeInterval'))).toBe(false)
    expect(isNotEnrolled(http(403))).toBe(false)
    expect(isNotEnrolled(http(429))).toBe(false)
    expect(isNotEnrolled(http(503))).toBe(false)
    expect(isNotEnrolled(new UpstreamHttpError('x', 404, undefined, 'lwa'))).toBe(false)
    expect(isNotEnrolled(new Error('boom'))).toBe(false)
  })
})
