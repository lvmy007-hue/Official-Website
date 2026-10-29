import { describe, expect, it, vi } from 'vitest'
import { autoBindAdsProfile, pickAdsAccountId, uniqueCandidate } from './ads-binding'

describe('广告账户取卖家编号', () => {
  it('优先顶层 accountId，其次卖家类型的 accountInfo.id，供应商类型不取', () => {
    expect(pickAdsAccountId({ accountId: 'A1' })).toBe('A1')
    expect(pickAdsAccountId({ accountInfo: { type: 'seller', id: 'A2' } })).toBe('A2')
    expect(pickAdsAccountId({ accountInfo: { type: 'vendor', id: 'V1' } })).toBeUndefined()
    expect(pickAdsAccountId({})).toBeUndefined()
  })
  it('候选必须唯一', () => {
    expect(uniqueCandidate([{ id: 's1' }])).toBe('s1')
    expect(uniqueCandidate([])).toBeNull()
    expect(uniqueCandidate([{ id: 's1' }, { id: 's2' }])).toBeNull()
  })
})

describe('广告账户自动匹配店铺', () => {
  const profile = { id: 'p1', tenantId: 't1', accountId: 'SELLER1', bindingStatus: 'UNBOUND', sellerAccountId: null as string | null }
  const makeDb = (candidates: { id: string }[]) => ({
    sellerAccount: { findMany: vi.fn().mockResolvedValue(candidates) },
    adsProfile: { update: vi.fn().mockResolvedValue({}) },
  })

  it('唯一匹配时绑定并标记为自动匹配，且只在本租户内查找', async () => {
    const db = makeDb([{ id: 's1' }])
    expect(await autoBindAdsProfile(db, profile)).toBe('AUTO_MATCHED')
    expect(db.sellerAccount.findMany).toHaveBeenCalledWith({ where: { tenantId: 't1', sellerId: 'SELLER1' }, select: { id: true } })
    expect(db.adsProfile.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { sellerAccountId: 's1', bindingStatus: 'AUTO_MATCHED' } })
  })
  it('零个或多个候选时不猜测，保持未绑定', async () => {
    for (const candidates of [[], [{ id: 's1' }, { id: 's2' }]]) {
      const db = makeDb(candidates)
      expect(await autoBindAdsProfile(db, profile)).toBe('UNBOUND')
      expect(db.adsProfile.update).not.toHaveBeenCalled()
    }
  })
  it('人工绑定的结果不被覆盖，也不查库', async () => {
    const db = makeDb([{ id: 's9' }])
    expect(await autoBindAdsProfile(db, { ...profile, bindingStatus: 'MANUAL', sellerAccountId: 's2' })).toBe('MANUAL_KEPT')
    expect(db.sellerAccount.findMany).not.toHaveBeenCalled()
    expect(db.adsProfile.update).not.toHaveBeenCalled()
  })
  it('原本自动匹配的店铺已不再唯一时，回到未绑定', async () => {
    const db = makeDb([])
    expect(await autoBindAdsProfile(db, { ...profile, bindingStatus: 'AUTO_MATCHED', sellerAccountId: 's1' })).toBe('UNBOUND')
    expect(db.adsProfile.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { sellerAccountId: null, bindingStatus: 'UNBOUND' } })
  })
  it('没有卖家编号的广告账户直接保持未绑定且不查库', async () => {
    const db = makeDb([{ id: 's1' }])
    expect(await autoBindAdsProfile(db, { ...profile, accountId: null })).toBe('UNBOUND')
    expect(db.sellerAccount.findMany).not.toHaveBeenCalled()
  })
})
