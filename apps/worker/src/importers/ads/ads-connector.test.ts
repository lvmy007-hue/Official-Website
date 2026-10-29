import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { ADS_STREAM_ID_UNRESOLVED } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { decodeStream } from '../../streaming/download'
import type { Row } from '../../streaming/rows'
import type { JsonObject } from '../../types'
import { fakeQueryAll, recorder } from './ads-fake.test-helper'
import { readAdsEntities, newEntityStats } from './entities'
import { FORECAST_BUDGET_MAX, requestCampaignForecast } from './forecast'
import { syncAdsRecommendations } from './recommendations'
import { campaignDailyMetrics, parseCampaignDailyRow } from './report-v1-parse'
import { newStreamStats, parseStreamConverted, parseStreamHourly, streamLabel, streamRecords } from './stream-parse'

const scope = { tenantId: 't1', adsProfileId: 'p1', adsAccountId: 'amzn1.ads-account.g.test' }
const NOW = new Date('2026-10-23T08:00:00Z')

async function* rowsOf(items: Row[]) {
  for (const item of items) yield item
}

describe('新报告行的解析', () => {
  it('活动日指标：读维度与指标；缺的指标是 null 不是 0；广告产品统一大写', () => {
    expect(parseCampaignDailyRow({ date: '2026-10-20T00:00:00Z', campaignId: 'c1', adProduct: 'sponsored_products', impressions: 100, clicks: '5', cost: '1,234.50', sales: 20 })).toEqual({
      date: '2026-10-20',
      campaignId: 'c1',
      adProduct: 'SPONSORED_PRODUCTS',
      impressions: 100,
      clicks: 5,
      cost: 1234.5,
      sales: 20,
      purchases: null,
    })
  })

  it('兼容旧版别名；缺日期、缺活动编号的行跳过并计数，不猜', async () => {
    expect(parseCampaignDailyRow({ reportDate: '2026-10-20', campaign_id: 7, spend: 3, sales7d: 9, purchases7d: 2 })).toMatchObject({
      campaignId: '7',
      cost: 3,
      sales: 9,
      purchases: 2,
      adProduct: 'UNKNOWN',
    })
    const stats = { read: 0, skipped: 0, skippedReasons: {} as Record<string, number> }
    const out: string[] = []
    for await (const row of campaignDailyMetrics(rowsOf([{ campaignId: 'a', date: '2026-10-01' }, { campaignId: 'b' }, { date: '2026-10-01' }, { date: 'bad', campaignId: 'c' }]), stats))
      out.push(row.campaignId)
    expect(out).toEqual(['a'])
    expect(stats).toEqual({ read: 4, skipped: 3, skippedReasons: { NO_DATE: 2, NO_CAMPAIGN: 1 } })
  })
})

describe('营销数据流解析（接收端暂缓，只解析投递文件）', () => {
  it('小时表现：按最具体的编号定实体类型，小时对齐到整点，搜索词“其他”标记出来', () => {
    expect(
      parseStreamHourly({
        time_window_start: '2026-10-23T08:45:12Z',
        campaign_id: 'c1',
        ad_group_id: 'g1',
        keyword_id: 'k1',
        impressions: 10,
        clicks: 1,
        cost: 0.5,
        sales: 4,
        purchases: 1,
        currency: 'USD',
      }),
    ).toMatchObject({
      hourStart: new Date('2026-10-23T08:00:00Z'),
      entityType: 'TARGET',
      entityId: 'k1',
      campaignId: 'c1',
      otherBucket: false,
      cost: 0.5,
      currency: 'USD',
    })
    expect(parseStreamHourly({ hourStart: '2026-10-23T08:00:00Z', adGroupId: 'g1', campaignId: 'c1' })).toMatchObject({ entityType: 'AD_GROUP', entityId: 'g1', impressions: null })
    expect(parseStreamHourly({ hourStart: '2026-10-23T08:00:00Z', campaignId: 'c1' })).toMatchObject({ entityType: 'CAMPAIGN' })
    expect(parseStreamHourly({ hourStart: '2026-10-23T08:00:00Z', campaign_id: 'c1', search_term: 'Other' })).toMatchObject({ searchTerm: 'Other', otherBucket: true })
    expect(parseStreamHourly({ hourStart: '2026-10-23T08:00:00Z', campaign_id: 'c1', search_term: 'red shoes' })).toMatchObject({ otherBucket: false })
  })

  it('小时表现：没有时间或没有任何编号的行跳过', () => {
    expect(parseStreamHourly({ campaign_id: 'c1' })).toEqual({ skipped: 'NO_HOUR' })
    expect(parseStreamHourly({ hourStart: 'not a time', campaign_id: 'c1' })).toEqual({ skipped: 'NO_HOUR' })
    expect(parseStreamHourly({ hourStart: '2026-10-23T08:00:00Z' })).toEqual({ skipped: 'NO_ENTITY' })
  })

  it('转化商品：买走的商品与被推广的不是同一个就是光环销售', () => {
    const own = parseStreamConverted({ date: '2026-10-22', campaign_id: 'c1', advertised_asin: 'b0aaa', purchased_asin: 'B0AAA', units: 2, sales: 30 })
    expect(own).toMatchObject({ advertisedAsin: 'B0AAA', purchasedAsin: 'B0AAA', isHalo: false, units: 2 })
    expect(parseStreamConverted({ date: '2026-10-22', campaignId: 'c1', advertisedAsin: 'B0AAA', purchasedAsin: 'B0BBB', unitsSold: 1 })).toMatchObject({ isHalo: true })
    expect(parseStreamConverted({ campaign_id: 'c1', advertised_asin: 'A', purchased_asin: 'B' })).toEqual({ skipped: 'NO_DATE' })
    expect(parseStreamConverted({ date: '2026-10-22', advertised_asin: 'A', purchased_asin: 'B' })).toEqual({ skipped: 'NO_CAMPAIGN' })
    expect(parseStreamConverted({ date: '2026-10-22', campaign_id: 'c1', advertised_asin: 'A' })).toEqual({ skipped: 'NO_ASIN' })
  })

  it('投递文件（压缩的逐行 JSON）→ 记录流；跳过的行计数', async () => {
    const text = ['{"time_window_start":"2026-10-23T08:00:00Z","campaign_id":"c1","clicks":3}', '{"campaign_id":"c2"}', '{"time_window_start":"2026-10-23T09:00:00Z","ad_id":"a1","clicks":1}'].join(
      '\n',
    )
    const source = Readable.from([gzipSync(text)])
    const stats = newStreamStats()
    const out: Array<{ entityType?: string }> = []
    for await (const record of streamRecords(decodeStream(source), 'ads-performance-v1', stats)) out.push(record as { entityType?: string })
    expect(out.map(record => record.entityType)).toEqual(['CAMPAIGN', 'AD'])
    expect(stats).toEqual({ read: 3, skipped: 1, skippedReasons: { NO_HOUR: 1 } })
  })

  it('投放对象只带编号：查得到名称用名称，查不到显示编号并标记 STREAM_ID_UNRESOLVED', () => {
    const names = new Map([['TARGET:k1', '红色 跑鞋']])
    expect(streamLabel(names, 'TARGET', 'k1')).toEqual({ label: '红色 跑鞋' })
    expect(streamLabel(names, 'TARGET', 'k2')).toEqual({ label: 'k2', code: ADS_STREAM_ID_UNRESOLVED })
    expect(streamLabel(names, 'CAMPAIGN', 'k1')).toMatchObject({ code: ADS_STREAM_ID_UNRESOLVED })
  })
})

describe('广告实体读取', () => {
  it('逐类资源读取并解析；没有编号的条目计入跳过；各类资源的完整标记分别记录', async () => {
    const api = fakeQueryAll({ campaigns: [{ campaignId: 'c1', name: '活动' }, { name: '没编号' }], adGroups: [{ adGroupId: 'g1', campaignId: 'c1' }] })
    const stats = newEntityStats()
    const out: string[] = []
    for await (const entity of readAdsEntities(api, { resources: ['campaigns', 'adGroups', 'ads'], stats })) out.push(`${entity.entityType}:${entity.entityId}:${entity.parentId ?? ''}`)
    expect(out).toEqual(['CAMPAIGN:c1:', 'AD_GROUP:g1:c1'])
    expect(stats.campaigns).toEqual({ read: 2, skipped: 1, complete: true })
    expect(stats.adGroups).toEqual({ read: 1, skipped: 0, complete: true })
    expect(stats.ads).toEqual({ read: 0, skipped: 0, complete: true })
    expect(stats.targets.complete).toBe(false) // 没有读取的资源保持“未完成”
  })

  it('某类资源翻页没翻完：标记不完整', async () => {
    const stats = newEntityStats()
    for await (const entity of readAdsEntities(fakeQueryAll({ campaigns: [{ campaignId: 'c1' }] }, false), { resources: ['campaigns'], stats })) void entity
    expect(stats.campaigns.complete).toBe(false)
  })
})

describe('官方推荐同步', () => {
  const rec = (id: string, over: JsonObject = {}): JsonObject => ({ recommendationId: id, type: 'BUDGET', campaignId: 'c1', ...over })

  it('新推荐写成待处理；已有推荐只更新内容，不改人工决定的状态；失效的再次出现回到待处理', async () => {
    const { ctx, of } = recorder({
      'adsRecommendation.findMany': [
        { recommendationId: 'r-ignored', status: 'IGNORED' },
        { recommendationId: 'r-expired', status: 'EXPIRED' },
      ],
    })
    const api = fakeQueryAll({ recommendations: [rec('r-new'), rec('r-ignored', { type: 'BID' }), rec('r-expired'), { type: 'NO_ID' }] })
    const result = await syncAdsRecommendations(ctx, api, scope, { now: NOW })
    expect(result).toMatchObject({ read: 4, created: 1, updated: 2, skipped: 1, complete: true })
    const created = of('adsRecommendation', 'create')[0].args.data
    expect(created).toMatchObject({
      tenantId: 't1',
      adsProfileId: 'p1',
      adsAccountId: scope.adsAccountId,
      recommendationId: 'r-new',
      entityType: 'CAMPAIGN',
      entityId: 'c1',
      receivedAt: NOW,
      lastSeenAt: NOW,
    })
    expect(created.status).toBeUndefined() // 默认值 NEW 由数据库给
    const updates = of('adsRecommendation', 'update').map(call => call.args.data)
    expect(updates[0]).toMatchObject({ type: 'BID', lastSeenAt: NOW })
    expect(updates[0].status).toBeUndefined() // 已忽略的不动
    expect(updates[1].status).toBe('NEW') // 失效后又出现
  })

  it('这次不再返回的待处理推荐记为已失效：条件只含待处理且这次没看到的', async () => {
    const { ctx, of } = recorder({ 'adsRecommendation.updateMany': { count: 3 } })
    const result = await syncAdsRecommendations(ctx, fakeQueryAll({ recommendations: [rec('r1')] }), scope, { now: NOW })
    expect(result.expired).toBe(3)
    expect(of('adsRecommendation', 'updateMany')[0].args).toEqual({
      where: { adsProfileId: 'p1', adsAccountId: scope.adsAccountId, status: 'NEW', lastSeenAt: { lt: NOW } },
      data: { status: 'EXPIRED' },
    })
  })

  it('没读完（接口翻页没结束或超过一次的上限）：不做失效判断', async () => {
    const incomplete = recorder()
    expect((await syncAdsRecommendations(incomplete.ctx, fakeQueryAll({ recommendations: [rec('r1')] }, false), scope, { now: NOW })).complete).toBe(false)
    expect(incomplete.of('adsRecommendation', 'updateMany')).toHaveLength(0)

    const capped = recorder()
    const result = await syncAdsRecommendations(capped.ctx, fakeQueryAll({ recommendations: [rec('r1'), rec('r2'), rec('r3')] }), scope, { now: NOW, limit: 2 })
    expect(result).toMatchObject({ read: 2, created: 2, complete: false, expired: 0 })
    expect(capped.of('adsRecommendation', 'updateMany')).toHaveLength(0)
  })

  it('同一次返回里重复的推荐只建一次，之后按更新处理', async () => {
    const { ctx } = recorder()
    expect(await syncAdsRecommendations(ctx, fakeQueryAll({ recommendations: [rec('dup'), rec('dup', { type: 'BID' })] }), scope, { now: NOW })).toMatchObject({ created: 1, updated: 1 })
  })
})

describe('活动预测', () => {
  const api = (forecast: JsonObject) => ({ forecastCampaign: vi.fn(async () => forecast) })

  it('调用官方预测并留一行记录（只追加）：预算、币种、预测原文、请求人', async () => {
    const { ctx, of } = recorder()
    const result = await requestCampaignForecast(ctx, api({ clicks: { low: 10, high: 20 } }), scope, { campaignId: 'c1', requestedBudget: 75.5, requestedBy: 'u1', now: NOW })
    expect(result.forecast).toEqual({ clicks: { low: 10, high: 20 } })
    expect(of('adsForecastRun', 'create')[0].args.data).toMatchObject({
      tenantId: 't1',
      adsProfileId: 'p1',
      adsAccountId: scope.adsAccountId,
      campaignId: 'c1',
      requestedBudget: 75.5,
      currency: 'USD',
      forecastJson: { clicks: { low: 10, high: 20 } },
      requestedAt: NOW,
      requestedBy: 'u1',
    })
  })

  it('预算不合法或没有活动：不可重试，不调用亚马逊也不写库', async () => {
    const { ctx, of } = recorder()
    const forecast = api({ a: 1 })
    for (const requestedBudget of [-1, Number.NaN, Number.POSITIVE_INFINITY, FORECAST_BUDGET_MAX + 1]) {
      await expect(requestCampaignForecast(ctx, forecast, scope, { campaignId: 'c1', requestedBudget })).rejects.toMatchObject({ code: 'ADS_FORECAST_INVALID', retryable: false })
    }
    await expect(requestCampaignForecast(ctx, forecast, scope, { campaignId: '', requestedBudget: 5 })).rejects.toMatchObject({ code: 'ADS_FORECAST_INVALID' })
    expect(forecast.forecastCampaign).not.toHaveBeenCalled()
    expect(of('adsForecastRun', 'create')).toHaveLength(0)
  })

  it('亚马逊返回空结果：报错（可重试），不写假记录', async () => {
    const { ctx, of } = recorder()
    await expect(requestCampaignForecast(ctx, api({}), scope, { campaignId: 'c1', requestedBudget: 5 })).rejects.toThrow('ADS_FORECAST_EMPTY')
    expect(of('adsForecastRun', 'create')).toHaveLength(0)
  })
})
