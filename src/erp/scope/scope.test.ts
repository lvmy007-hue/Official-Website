import { describe, expect, it } from 'vitest'
import { effectiveCompareRange, describeRange, nextSearch } from './actions'
import { addDays, previousRange, rangePresets, spanDays, todayInMarketplace, yearOverYearRange } from './dates'
import { isScopeNarrowed, pickScope, scopeToApiParams, validateScope } from './params'
import { parseSearch, stringifySearch } from '../routes/search'

describe('业务日期（按美国站时区切日）', () => {
  it('同一时刻在太平洋时区可能还是前一天', () => {
    // 2026-10-21 03:00 UTC 在洛杉矶是 10 月 20 日 20:00
    expect(todayInMarketplace(new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-20')
    expect(todayInMarketplace(new Date('2026-10-21T15:00:00Z'))).toBe('2026-10-21')
  })

  it('天数计算含首尾，跨月跨年正确', () => {
    expect(spanDays('2026-10-01', '2026-10-07')).toBe(7)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('上一期与去年同期', () => {
    expect(previousRange({ from: '2026-10-08', to: '2026-10-14' })).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(yearOverYearRange({ from: '2026-10-01', to: '2026-10-07' })).toEqual({ from: '2025-10-01', to: '2025-10-07' })
    // 闰日回退到 2 月 28 日
    expect(yearOverYearRange({ from: '2028-02-29', to: '2028-03-02' })).toEqual({ from: '2027-02-28', to: '2027-03-02' })
  })

  it('快捷范围以站点今天为基准', () => {
    const presets = Object.fromEntries(rangePresets('2026-10-21').map(item => [item.key, item.range]))
    expect(presets.last7).toEqual({ from: '2026-10-15', to: '2026-10-21' })
    expect(presets.last30).toEqual({ from: '2026-09-22', to: '2026-10-21' })
    expect(presets.month).toEqual({ from: '2026-10-01', to: '2026-10-21' })
    expect(presets.lastMonth).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(presets.yesterday).toEqual({ from: '2026-10-20', to: '2026-10-20' })
  })

  it('一月份的“上月”跨到上一年', () => {
    const lastMonth = rangePresets('2027-01-15').find(item => item.key === 'lastMonth')!.range
    expect(lastMonth).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })
})

describe('范围参数校验', () => {
  it('站点固定美国站，其他站点被拒绝，并给出中文原因', () => {
    expect(validateScope({ marketplaceId: 'A1F83G8C2ARO7P' })).toEqual({ ok: false, message: '站点只支持亚马逊美国站' })
  })

  it('时间范围必须成对、不能倒置、不能超过上限', () => {
    expect(validateScope({ from: '2026-10-01' })).toMatchObject({ ok: false })
    expect(validateScope({ from: '2026-10-09', to: '2026-10-01' })).toMatchObject({ ok: false, message: '结束日期不能早于开始日期' })
    expect(validateScope({ from: '2020-01-01', to: '2026-10-01' })).toMatchObject({ ok: false })
  })

  it('对比期必须先有时间范围；自定义对比要给出完整区间', () => {
    expect(validateScope({ compare: 'previous' })).toMatchObject({ ok: false })
    expect(validateScope({ from: '2026-10-01', to: '2026-10-07', compare: 'custom' })).toMatchObject({ ok: false })
    expect(validateScope({ from: '2026-10-01', to: '2026-10-07', compare: 'previous' })).toMatchObject({ ok: true })
  })

  it('页面自己的参数允许共存；范围参数转成接口参数时数组用逗号连接且必带站点', () => {
    const result = validateScope({ storeIds: 'a,b', page: '2', q: 'x' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scope.storeIds).toEqual(['a', 'b'])
      expect(scopeToApiParams(result.scope)).toMatchObject({ storeIds: 'a,b', marketplaceId: 'ATVPDKIKX0DER', compare: 'none', displayCurrency: 'USD' })
      expect(scopeToApiParams(result.scope)).not.toHaveProperty('page')
    }
  })

  it('pickScope 只保留范围参数；是否收窄的判断', () => {
    expect(pickScope({ storeIds: ['a'], page: 2, q: 'x', from: '2026-10-01', to: '2026-10-07' })).toEqual({ storeIds: ['a'], from: '2026-10-01', to: '2026-10-07' })
    expect(isScopeNarrowed({})).toBe(false)
    expect(isScopeNarrowed({ storeIds: ['a'] })).toBe(true)
  })
})

describe('范围栏操作', () => {
  const today = '2026-10-21'

  it('选择店铺：改写地址参数，并让分页回到第一页', () => {
    const next = nextSearch({ page: 3, cursor: 'x', q: '收纳' }, { storeIds: ['s1', 's2'] }, today)
    expect(next).toMatchObject({ storeIds: ['s1', 's2'], q: '收纳' })
    expect(next).not.toHaveProperty('page', 3)
    expect(next.cursor).toBeUndefined()
  })

  it('清空选择即还原为“全部”', () => {
    expect(nextSearch({ storeIds: ['s1'] }, { storeIds: [] }, today).storeIds).toBeUndefined()
  })

  it('选择对比期时没有时间范围，自动补近 30 天', () => {
    const next = nextSearch({}, { compare: 'yoy' }, today)
    expect(next).toMatchObject({ compare: 'yoy', from: '2026-09-22', to: '2026-10-21' })
    expect(validateScope(next).ok).toBe(true)
  })

  it('清除时间范围时对比期一并清除，否则地址会变成不合法', () => {
    const next = nextSearch({ from: '2026-10-01', to: '2026-10-07', compare: 'previous' }, { range: null }, today)
    expect(next).toMatchObject({ from: undefined, to: undefined, compare: undefined })
    expect(validateScope(next).ok).toBe(true)
  })

  it('从自定义对比切回其他模式，清掉自定义日期', () => {
    const next = nextSearch({ from: '2026-10-01', to: '2026-10-07', compare: 'custom', compareFrom: '2026-09-01', compareTo: '2026-09-07' }, { compare: 'previous' }, today)
    expect(next.compareFrom).toBeUndefined()
    expect(next.compareTo).toBeUndefined()
  })

  it('对比区间由规则推出或取自定义值', () => {
    expect(effectiveCompareRange({ from: '2026-10-08', to: '2026-10-14', compare: 'previous' })).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(effectiveCompareRange({ from: '2026-10-08', to: '2026-10-14', compare: 'custom', compareFrom: '2026-01-01', compareTo: '2026-01-07' })).toEqual({ from: '2026-01-01', to: '2026-01-07' })
    expect(effectiveCompareRange({ from: '2026-10-08', to: '2026-10-14' })).toBeNull()
    expect(describeRange({ from: '2026-10-08', to: '2026-10-14' })).toBe('2026-10-08 至 2026-10-14')
    expect(describeRange({})).toBe('近 30 天')
  })
})

describe('地址栏读写', () => {
  it('读取时所有值都是字符串，不做 JSON 猜测', () => {
    expect(parseSearch('?storeIds=123&flag=true&n=1')).toEqual({ storeIds: '123', flag: 'true', n: '1' })
  })

  it('写入时数组用逗号连接，范围默认值不写，空值不写', () => {
    expect(stringifySearch({ storeIds: ['a', 'b'], marketplaceId: 'ATVPDKIKX0DER', compare: 'none', displayCurrency: 'USD', q: '', page: 2 })).toBe('?page=2&storeIds=a%2Cb')
    expect(stringifySearch({ displayCurrency: 'ORIGINAL' })).toBe('?displayCurrency=ORIGINAL')
    expect(stringifySearch({})).toBe('')
  })
})
