import { describe, expect, it } from 'vitest'
import { brandShareOf } from './ad-terms-brand'

const row = (over: Partial<Parameters<typeof brandShareOf>[0][number]>) => ({
  sellerAccountId: 's1',
  searchVolume: null,
  clicksTotal: null,
  clicksOwn: null,
  purchasesTotal: null,
  purchasesOwn: null,
  ...over,
})

describe('词级分析页的品牌分析份额（纯计算）', () => {
  it('同一店铺的多个我方 ASIN：我方数量相加，市场总量取同一个值，不重复相加', () => {
    const rows = [
      row({ searchVolume: 500, clicksTotal: 100, clicksOwn: 10, purchasesTotal: 20, purchasesOwn: 2 }),
      row({ searchVolume: 500, clicksTotal: 100, clicksOwn: 15, purchasesTotal: 20, purchasesOwn: 3 }),
    ]
    expect(brandShareOf(rows)).toEqual({ searchVolume: 500, clickShare: 0.25, purchaseShare: 0.25 })
  })

  it('多个店铺：搜索量与份额各店铺分别汇总后相加', () => {
    const rows = [row({ searchVolume: 100, clicksTotal: 100, clicksOwn: 50 }), row({ sellerAccountId: 's2', searchVolume: 300, clicksTotal: 300, clicksOwn: 50 })]
    expect(brandShareOf(rows)).toMatchObject({ searchVolume: 400, clickShare: 0.25 })
  })

  it('官方没给的列是空，不是 0；市场总量为 0 时份额为空', () => {
    expect(brandShareOf([row({ searchVolume: 10 })])).toEqual({ searchVolume: 10, clickShare: null, purchaseShare: null })
    expect(brandShareOf([row({ clicksTotal: 0, clicksOwn: 0 })]).clickShare).toBeNull()
    expect(brandShareOf([]).searchVolume).toBeNull()
  })
})
