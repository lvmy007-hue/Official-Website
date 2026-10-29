import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../types'
import { AdsV1Api, ADS_V1_MAX_PAGES, ADS_V1_PAGE_SIZE, pageItems } from './ads-v1-api'
import { parseEntity, parseForecast, parseRecommendation } from './ads-v1-parse'
import { AmazonAdsApiClient, adsScopeHeader } from './amazon-ads-api'

const ACCOUNT = 'amzn1.ads-account.g.test'

describe('账户上下文请求头（统一接口与旧接口不能混用）', () => {
  it('统一接口只带全球广告账户编号', () => {
    expect(adsScopeHeader('/adsApi/v1/query/campaigns', { adsAccountId: ACCOUNT })).toEqual({ 'Amazon-Ads-AccountId': ACCOUNT })
  })

  it('旧接口只带按站点的档案编号；档案列表这类不带账户上下文的路径什么都不带', () => {
    expect(adsScopeHeader('/sp/campaigns/list', { profileId: '123' })).toEqual({ 'Amazon-Advertising-API-Scope': '123' })
    expect(adsScopeHeader('/v2/profiles', {})).toEqual({})
  })

  it('传错体系或同时传两个：直接抛错，请求发不出去', () => {
    expect(() => adsScopeHeader('/adsApi/v1/query/campaigns', { profileId: '123' })).toThrow('ADS_SCOPE_HEADER_CONFLICT')
    expect(() => adsScopeHeader('/adsApi/v1/query/campaigns', {})).toThrow('ADS_ACCOUNT_ID_REQUIRED')
    expect(() => adsScopeHeader('/sp/campaigns/list', { adsAccountId: ACCOUNT })).toThrow('ADS_SCOPE_HEADER_CONFLICT')
    expect(() => adsScopeHeader('/sp/campaigns/list', { profileId: '1', adsAccountId: ACCOUNT })).toThrow('ADS_SCOPE_HEADER_CONFLICT')
    expect(() => adsScopeHeader('/adsApiXYZ/other', { adsAccountId: ACCOUNT })).toThrow('ADS_SCOPE_HEADER_CONFLICT')
  })
})

describe('客户端按路径发出正确的请求头', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.AMAZON_ADS_CLIENT_ID
    delete process.env.AMAZON_ADS_CLIENT_SECRET
  })

  async function send(options: { path: string; profileId?: string; adsAccountId?: string }) {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        if (String(url).includes('auth/o2/token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
        seen.push(init?.headers ?? {})
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    )
    process.env.AMAZON_ADS_CLIENT_ID = 'cid'
    process.env.AMAZON_ADS_CLIENT_SECRET = 'secret'
    const client = new AmazonAdsApiClient({ encryptedRefreshToken: 'cipher' }, { openAmazonToken: async () => 'refresh' } as never)
    await client.request({ method: 'POST', body: {}, ...options })
    return seen[0]
  }

  it('统一接口：带 Amazon-Ads-AccountId，不带旧作用域', async () => {
    const headers = await send({ path: '/adsApi/v1/query/campaigns', adsAccountId: ACCOUNT })
    expect(headers['Amazon-Ads-AccountId']).toBe(ACCOUNT)
    expect(headers['Amazon-Advertising-API-Scope']).toBeUndefined()
    expect(headers['Amazon-Advertising-API-ClientId']).toBe('cid')
  })

  it('旧接口：带作用域，不带账户编号', async () => {
    const headers = await send({ path: '/sp/campaigns/list', profileId: '555' })
    expect(headers['Amazon-Advertising-API-Scope']).toBe('555')
    expect(headers['Amazon-Ads-AccountId']).toBeUndefined()
  })
})

describe('统一接口分页', () => {
  const page = (items: JsonObject[], nextToken?: string) => ({ campaigns: items, ...(nextToken ? { nextToken } : {}) })

  function apiWith(bodies: JsonObject[]) {
    const request = vi.fn(async () => bodies.shift() ?? {})
    return { api: new AdsV1Api({ request } as never, ACCOUNT), request }
  }

  it('一页一页翻到没有 nextToken；筛选条件每页都带，nextToken 只在后续页带；账户编号与限速桶按接口约定', async () => {
    const { api, request } = apiWith([page([{ campaignId: 'c1' }, { campaignId: 'c2' }], 'tok-1'), page([{ campaignId: 'c3' }])])
    const gen = api.queryAll('campaigns', { stateFilter: ['ENABLED'] })
    const ids: string[] = []
    let last: { complete: boolean; pages: number } | undefined
    for (;;) {
      const next = await gen.next()
      if (next.done) {
        last = next.value
        break
      }
      ids.push(String(next.value.campaignId))
    }
    expect(ids).toEqual(['c1', 'c2', 'c3'])
    expect(last).toEqual({ complete: true, pages: 2 })
    const calls = request.mock.calls as unknown as Array<[{ method: string; path: string; adsAccountId: string; body: JsonObject }]>
    expect(calls.map(call => call[0].path)).toEqual(['/adsApi/v1/query/campaigns', '/adsApi/v1/query/campaigns'])
    expect(calls[0][0]).toMatchObject({ method: 'POST', adsAccountId: ACCOUNT })
    expect(calls[0][0].body).toEqual({ maxResults: ADS_V1_PAGE_SIZE, stateFilter: ['ENABLED'] })
    expect(calls[1][0].body).toEqual({ maxResults: ADS_V1_PAGE_SIZE, stateFilter: ['ENABLED'], nextToken: 'tok-1' })
  })

  it('分页令牌一直不结束：翻到页数上限就停下并标记不完整，不会死循环', async () => {
    const request = vi.fn(async () => page([{ campaignId: 'c' }], 'again'))
    const api = new AdsV1Api({ request } as never, ACCOUNT)
    const gen = api.queryAll('campaigns')
    let count = 0
    let last: { complete: boolean; pages: number } | undefined
    for (;;) {
      const next = await gen.next()
      if (next.done) {
        last = next.value
        break
      }
      count += 1
    }
    expect(last).toEqual({ complete: false, pages: ADS_V1_MAX_PAGES })
    expect(count).toBe(ADS_V1_MAX_PAGES)
  })

  it('没有账户编号不能创建客户端；预测请求发到预测资源并带活动与预算', async () => {
    expect(() => new AdsV1Api({ request: vi.fn() } as never, '')).toThrow('ADS_ACCOUNT_ID_REQUIRED')
    const request = vi.fn(async () => ({ forecast: { clicks: { low: 1, high: 2 } } }))
    const api = new AdsV1Api({ request } as never, ACCOUNT)
    await api.forecastCampaign('c9', 50)
    expect(request.mock.calls[0][0]).toMatchObject({ path: '/adsApi/v1/query/campaignForecasts', adsAccountId: ACCOUNT, body: { campaignId: 'c9', budget: 50 } })
  })

  it('响应的条目可以在资源名、items、data 任一键下；空数组也认', () => {
    expect(pageItems({ campaigns: [{ a: 1 }] }, 'campaigns')).toEqual([{ a: 1 }])
    expect(pageItems({ items: [{ a: 2 }] }, 'campaigns')).toEqual([{ a: 2 }])
    expect(pageItems({ data: [{ a: 3 }] }, 'campaigns')).toEqual([{ a: 3 }])
    expect(pageItems({ campaigns: [], items: [{ a: 4 }] }, 'campaigns')).toEqual([])
    expect(pageItems({ other: 1 }, 'campaigns')).toEqual([])
  })
})

describe('解析（没有编号的条目不猜）', () => {
  it('实体：按资源取编号与上级编号；没有编号返回 null', () => {
    expect(parseEntity('campaigns', { campaignId: 'c1', name: ' 春季 ', state: 'ENABLED' })).toMatchObject({
      entityType: 'CAMPAIGN',
      entityId: 'c1',
      name: '春季',
      state: 'ENABLED',
      parentId: undefined,
    })
    expect(parseEntity('adGroups', { adGroupId: 'g1', campaignId: 'c1' })).toMatchObject({ entityType: 'AD_GROUP', entityId: 'g1', parentId: 'c1' })
    expect(parseEntity('targets', { id: 7, adGroupId: 'g1' })).toMatchObject({ entityType: 'TARGET', entityId: '7', parentId: 'g1' })
    expect(parseEntity('ads', { adGroupId: 'g1' })).toBeNull()
    expect(parseEntity('brandStores', { name: '旗舰店' })).toBeNull()
  })

  it('推荐：关联对象优先取 entity，其次广告组与活动编号，都没有就是账户级', () => {
    expect(parseRecommendation({ recommendationId: 'r1', type: 'BUDGET', entity: { type: 'campaign', id: 'c1' } })).toMatchObject({ entityType: 'CAMPAIGN', entityId: 'c1' })
    expect(parseRecommendation({ id: 'r2', recommendationType: 'BID', adGroupId: 'g1', campaignId: 'c1' })).toMatchObject({
      recommendationId: 'r2',
      type: 'BID',
      entityType: 'AD_GROUP',
      entityId: 'g1',
    })
    expect(parseRecommendation({ id: 'r3', type: 'KEYWORD', campaignId: 'c1' })).toMatchObject({ entityType: 'CAMPAIGN', entityId: 'c1' })
    expect(parseRecommendation({ id: 'r4', type: 'ACCOUNT_TIP' })).toMatchObject({ entityType: 'ACCOUNT', entityId: '' })
    expect(parseRecommendation({ type: 'BUDGET' })).toBeNull()
    expect(parseRecommendation({ id: 'r5' })).toBeNull()
  })

  it('预测：非空对象原样保留，空对象视为没有结果', () => {
    expect(parseForecast({ clicks: { low: 1 } })).toEqual({ clicks: { low: 1 } })
    expect(parseForecast({})).toBeNull()
  })
})
