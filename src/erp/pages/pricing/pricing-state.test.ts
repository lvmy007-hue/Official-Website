import { describe, expect, it } from 'vitest'
import { PRICING_PRICE_WRITE } from '@nova/api-contracts'
import { buildPriceHistoryOption } from './pricing-detail-options'
import { detailPath, guardOf, priceInputIssue } from './pricing-state'

describe('定价页的纯函数', () => {
  it('价格输入：空、非正数与超上限给出提示，合法价格通过', () => {
    expect(priceInputIssue(null)).toBe('请填写价格')
    expect(priceInputIssue(0)).toBe('价格要大于 0')
    expect(priceInputIssue(100_001)).toMatch(/不能超过/)
    expect(priceInputIssue(19.99)).toBeNull()
  })

  it('动作守卫：允许时只要权限；卡在开关或连接时带原因与前往处理的入口', () => {
    expect(guardOf(PRICING_PRICE_WRITE, undefined)).toEqual({ permission: PRICING_PRICE_WRITE })
    expect(guardOf(PRICING_PRICE_WRITE, { allowed: true, step: null, reason: null, remedyPath: null })).toEqual({ permission: PRICING_PRICE_WRITE })
    const sw = guardOf(PRICING_PRICE_WRITE, { allowed: false, step: 'SWITCH', reason: '开关未开启', remedyPath: '/app/settings/integrations' })
    expect(sw.writeSwitch?.enabled).toBe(false)
    expect(sw.writeSwitch?.fix?.href).toBe('/app/settings/integrations')
    const conn = guardOf(PRICING_PRICE_WRITE, { allowed: false, step: 'CONNECTION', reason: '授权已失效', remedyPath: '/app/settings/connections' })
    expect(conn.connection).toMatchObject({ ok: false, reason: '授权已失效' })
  })

  it('详情路径：SKU 里的特殊字符要编码', () => {
    expect(detailPath('A/B 1')).toBe('/app/pricing/A%2FB%201')
  })

  it('价格历史图：四条阶梯线，没有记录的点保持为空而不是 0', () => {
    const option = buildPriceHistoryOption(
      [
        { at: '2026-10-20T08:00:00Z', ownPrice: 26.99, featuredPrice: null, lowestPrice: 23, expectedPrice: null },
        { at: '2026-10-24T06:00:00Z', ownPrice: 24.99, featuredPrice: 23.5, lowestPrice: 22.5, expectedPrice: 23.99 },
      ],
      'USD',
    )
    const series = option.series as Array<{ name: string; data: Array<number | null>; step: string }>
    expect(series.map(item => item.name)).toEqual(['我方价格', '推荐报价价格', '最低竞争价', '预期获胜价'])
    expect(series[1]?.data).toEqual([null, 23.5])
    expect(series.every(item => item.step === 'end')).toBe(true)
  })
})
