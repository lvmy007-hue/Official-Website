import { describe, expect, it } from 'vitest'
import {
  ADS_BINDING_STATUSES,
  ADS_BINDING_STATUS_LABEL,
  ADS_UNBOUND_REASONS,
  ADS_UNBOUND_REASON_TEXT,
  bindingChangeOf,
  bindingReasonRequired,
  marketplaceWarning,
  unboundReasonOf,
} from './ads-binding.js'
import { AdsAccountBindBodySchema } from './ads-binding-query.js'

describe('绑定状态与权限', () => {
  it('每个状态都有中文', () => {
    expect(ADS_BINDING_STATUSES.map(status => ADS_BINDING_STATUS_LABEL[status])).toEqual(['已自动匹配', '人工绑定', '未绑定'])
  })
  it('每个未绑定原因都有说明', () => {
    for (const reason of ADS_UNBOUND_REASONS) expect(ADS_UNBOUND_REASON_TEXT[reason].length).toBeGreaterThan(8)
  })
})

describe('未绑定原因', () => {
  const base = { sellerAccountId: null, bindingStatus: 'UNBOUND', accountId: 'SELLER1', candidateCount: 0 }
  it('已有店铺时没有原因', () => {
    expect(unboundReasonOf({ ...base, sellerAccountId: 's1', bindingStatus: 'AUTO_MATCHED' })).toBeNull()
  })
  it('没有卖家编号、没有同编号店铺、多个同编号店铺、店铺被移除各给一个原因', () => {
    expect(unboundReasonOf({ ...base, accountId: null })).toBe('NO_SELLER_ID')
    expect(unboundReasonOf(base)).toBe('NO_MATCHING_STORE')
    expect(unboundReasonOf({ ...base, candidateCount: 2 })).toBe('MULTIPLE_STORES')
    expect(unboundReasonOf({ ...base, bindingStatus: 'MANUAL' })).toBe('RELEASED')
  })
})

describe('绑定操作的性质', () => {
  it('从未绑定到绑定是 BIND，换店铺是 REBIND，解除是 UNBIND', () => {
    expect(bindingChangeOf({ sellerAccountId: null, bindingStatus: 'UNBOUND' }, 's1')).toBe('BIND')
    expect(bindingChangeOf({ sellerAccountId: 's1', bindingStatus: 'MANUAL' }, 's2')).toBe('REBIND')
    expect(bindingChangeOf({ sellerAccountId: 's1', bindingStatus: 'AUTO_MATCHED' }, null)).toBe('UNBIND')
  })
  it('自动匹配的店铺再人工选同一个是 PIN（固定下来），人工绑定选同一个没有变化', () => {
    expect(bindingChangeOf({ sellerAccountId: 's1', bindingStatus: 'AUTO_MATCHED' }, 's1')).toBe('PIN')
    expect(bindingChangeOf({ sellerAccountId: 's1', bindingStatus: 'MANUAL' }, 's1')).toBe('NONE')
  })
  it('本来就没有绑定时解除没有变化；店铺被移除后留下的“人工绑定无店铺”解除一次恢复成未绑定', () => {
    expect(bindingChangeOf({ sellerAccountId: null, bindingStatus: 'UNBOUND' }, null)).toBe('NONE')
    expect(bindingChangeOf({ sellerAccountId: null, bindingStatus: 'MANUAL' }, null)).toBe('UNBIND')
  })
  it('只有改绑与解除要求写原因', () => {
    expect(['BIND', 'REBIND', 'UNBIND', 'PIN', 'NONE'].filter(change => bindingReasonRequired(change as never))).toEqual(['REBIND', 'UNBIND'])
  })
})

describe('站点提醒', () => {
  it('站点一致或店铺没有站点信息时不提醒，不一致时点名', () => {
    expect(marketplaceWarning('ATVPDKIKX0DER', ['ATVPDKIKX0DER'], '美国主店')).toBeNull()
    expect(marketplaceWarning('ATVPDKIKX0DER', [], '美国主店')).toBeNull()
    expect(marketplaceWarning('ATVPDKIKX0DER', null, '美国主店')).toBeNull()
    expect(marketplaceWarning('A1F83G8C2ARO7P', ['ATVPDKIKX0DER'], '美国主店')).toContain('美国主店')
  })
})

describe('绑定请求体', () => {
  it('店铺编号与可选原因；null 表示解除；多余字段与空串拒绝', () => {
    expect(AdsAccountBindBodySchema.parse({ sellerAccountId: ' s1 ' })).toEqual({ sellerAccountId: 's1' })
    expect(AdsAccountBindBodySchema.parse({ sellerAccountId: null, reason: '店铺已出售' })).toEqual({ sellerAccountId: null, reason: '店铺已出售' })
    expect(AdsAccountBindBodySchema.safeParse({ sellerAccountId: '' }).success).toBe(false)
    expect(AdsAccountBindBodySchema.safeParse({ sellerAccountId: 's1', reason: '短' }).success).toBe(false)
    expect(AdsAccountBindBodySchema.safeParse({ sellerAccountId: 's1', extra: 1 }).success).toBe(false)
    expect(AdsAccountBindBodySchema.safeParse({}).success).toBe(false)
  })
})
