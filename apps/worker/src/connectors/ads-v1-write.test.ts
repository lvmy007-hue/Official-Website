import { ADS_WRITE_KINDS } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { adsWriteRejection, buildAdsWriteCall, createdIdOf, type AdsWriteInput } from './ads-v1-write'

// 广告统一接口的写入请求体（P3-17）：十种写入各给出资源、操作与对象编号；缺必填值直接报错；响应里逐条的失败被识别。
// 请求体的嵌套形状是按文档惯例写的（未对真实账户验证），测试只锁定“哪个编号放在哪、取值原样带入”。

const base = { externalId: 'EXT-1', campaignExternalId: 'EXT-C' }
const input = (over: Partial<AdsWriteInput> & Pick<AdsWriteInput, 'kind'>): AdsWriteInput => ({ ...base, ...over })

describe('请求构造', () => {
  it('修改类：编号与取值原样带入，操作是 update', () => {
    expect(buildAdsWriteCall(input({ kind: 'CAMPAIGN_STATE', state: 'PAUSED' }))).toEqual({ operation: 'update', resource: 'campaigns', item: { campaignId: 'EXT-1', state: 'PAUSED' } })
    expect(buildAdsWriteCall(input({ kind: 'AD_GROUP_STATE', state: 'ENABLED' }))).toEqual({ operation: 'update', resource: 'adGroups', item: { adGroupId: 'EXT-1', state: 'ENABLED' } })
    expect(buildAdsWriteCall(input({ kind: 'TARGET_STATE', state: 'PAUSED' }))).toEqual({ operation: 'update', resource: 'targets', item: { targetId: 'EXT-1', state: 'PAUSED' } })
    expect(buildAdsWriteCall(input({ kind: 'AD_GROUP_BID', amount: 0.85 }))).toMatchObject({ resource: 'adGroups', item: { adGroupId: 'EXT-1', bid: { defaultBid: 0.85 } } })
    expect(buildAdsWriteCall(input({ kind: 'TARGET_BID', amount: 1.2 }))).toMatchObject({ resource: 'targets', item: { targetId: 'EXT-1', bid: { bid: 1.2 } } })
  })

  it('活动的预算、竞价策略、广告位调整都挂在活动上，金额不做四舍五入', () => {
    const budget = buildAdsWriteCall(input({ kind: 'CAMPAIGN_BUDGET', amount: 33.33 }))
    expect(JSON.stringify(budget.item)).toContain('33.33')
    expect(budget).toMatchObject({ operation: 'update', resource: 'campaigns', item: { campaignId: 'EXT-1' } })
    expect(buildAdsWriteCall(input({ kind: 'CAMPAIGN_BID_STRATEGY', strategy: 'MANUAL' })).item).toMatchObject({ campaignId: 'EXT-1', optimizations: { bidSettings: { bidStrategy: 'MANUAL' } } })
    expect(JSON.stringify(buildAdsWriteCall(input({ kind: 'CAMPAIGN_PLACEMENT', placement: 'TOP_OF_SEARCH', amount: 50 })).item)).toContain('TOP_OF_SEARCH')
  })

  it('否定投放：挂活动时只带活动编号；挂广告组时带广告组编号与所属活动；标记为否定', () => {
    const campaignLevel = buildAdsWriteCall(input({ kind: 'NEGATIVE_ADD', level: 'CAMPAIGN', text: 'free', matchType: 'NEGATIVE_EXACT' }))
    expect(campaignLevel).toMatchObject({ operation: 'create', resource: 'targets', item: { campaignId: 'EXT-1', negative: true } })
    expect(campaignLevel.item).not.toHaveProperty('adGroupId')
    const groupLevel = buildAdsWriteCall(input({ kind: 'NEGATIVE_ADD', level: 'AD_GROUP', text: 'free', matchType: 'NEGATIVE_PHRASE' }))
    expect(groupLevel.item).toMatchObject({ adGroupId: 'EXT-1', campaignId: 'EXT-C', negative: true, targetDetails: { keywordTarget: { keyword: 'free', matchType: 'NEGATIVE_PHRASE' } } })
  })

  it('添加关键词：挂在广告组下，默认启用；给了竞价才带竞价', () => {
    const withBid = buildAdsWriteCall(input({ kind: 'KEYWORD_ADD', text: 'yoga block', matchType: 'PHRASE', amount: 0.9 }))
    expect(withBid).toMatchObject({ operation: 'create', resource: 'targets', item: { adGroupId: 'EXT-1', campaignId: 'EXT-C', negative: false, state: 'ENABLED', bid: { bid: 0.9 } } })
    expect(buildAdsWriteCall(input({ kind: 'KEYWORD_ADD', text: 'yoga block', matchType: 'EXACT' })).item).not.toHaveProperty('bid')
  })

  it('缺必填值直接报错，不发出残缺的请求', () => {
    expect(() => buildAdsWriteCall(input({ kind: 'CAMPAIGN_STATE' }))).toThrow('ADS_WRITE_STATE_MISSING')
    expect(() => buildAdsWriteCall(input({ kind: 'CAMPAIGN_BUDGET' }))).toThrow('ADS_WRITE_AMOUNT_MISSING')
    expect(() => buildAdsWriteCall(input({ kind: 'TARGET_BID', amount: Number.NaN }))).toThrow('ADS_WRITE_AMOUNT_MISSING')
    expect(() => buildAdsWriteCall(input({ kind: 'NEGATIVE_ADD', level: 'AD_GROUP', matchType: 'NEGATIVE_EXACT' }))).toThrow('ADS_WRITE_TEXT_MISSING')
    expect(() => buildAdsWriteCall(input({ kind: 'KEYWORD_ADD', text: 'x' }))).toThrow('ADS_WRITE_MATCH_TYPE_MISSING')
    expect(() => buildAdsWriteCall(input({ kind: 'NOPE' as never }))).toThrow('ADS_WRITE_KIND_UNKNOWN')
  })

  it('十种写入类型都能构造出请求（新增类型漏了构造会在这里暴露）', () => {
    const full = { state: 'PAUSED', amount: 1, strategy: 'MANUAL', placement: 'PRODUCT_PAGE', text: 'x', matchType: 'EXACT', level: 'AD_GROUP' }
    for (const kind of ADS_WRITE_KINDS) expect(() => buildAdsWriteCall({ ...base, ...full, kind }), kind).not.toThrow()
  })
})

describe('响应判断', () => {
  it('顶层有 error 数组，或条目里带 error，都算被拒绝；成功与没有逐条信息按成功', () => {
    expect(adsWriteRejection({ error: [{ code: 'INVALID_ARGUMENT' }] })).toBe('ADS_WRITE_REJECTED')
    expect(adsWriteRejection({ campaigns: [{ campaignId: 'c1', error: { code: 'X' } }] })).toBe('ADS_WRITE_REJECTED')
    expect(adsWriteRejection({ targets: [{ targetId: 't1', status: 'FAILED' }] })).toBe('ADS_WRITE_REJECTED')
    expect(adsWriteRejection({ campaigns: [{ campaignId: 'c1' }], success: [{ index: 0 }], error: [] })).toBeNull()
    expect(adsWriteRejection({})).toBeNull()
  })

  it('新增类返回的新编号：取不到返回 null，不影响成功判断', () => {
    expect(createdIdOf({ targets: [{ targetId: 'T-9' }] })).toBe('T-9')
    expect(createdIdOf({ success: [{ target: { targetId: 'T-8' } }] })).toBe('T-8')
    expect(createdIdOf({})).toBeNull()
  })
})
