import { describe, expect, it } from 'vitest'
import { ScopeQuerySchema, ScopeSearchSchema } from './query.js'
import { SCOPE_PARAM_KEYS, ScopeSearchParser, parseScopeSearch } from './scope-search.js'

// 前端首屏用 parseScopeSearch（不带 zod），接口用 ScopeSearchSchema：两者必须对同一份输入给出同样的结果。
function expectSame(raw: unknown) {
  const expected = ScopeSearchSchema.safeParse(raw)
  const actual = parseScopeSearch(raw)
  const label = JSON.stringify(raw)
  expect(actual.success, label).toBe(expected.success)
  if (expected.success && actual.success) expect(actual.data, label).toEqual(expected.data)
  if (!expected.success && !actual.success) expect(actual.error.issues[0].message, label).toBe(expected.error.issues[0].message)
}

describe('地址栏范围参数校验与 ScopeSearchSchema 一致', () => {
  it('键名清单与 zod 定义一致', () => {
    expect([...SCOPE_PARAM_KEYS]).toEqual(Object.keys(ScopeQuerySchema.shape))
  })

  const cases: Array<[string, unknown]> = [
    ['空', {}],
    ['只有默认值', { marketplaceId: 'ATVPDKIKX0DER', compare: 'none', displayCurrency: 'USD' }],
    ['店铺逗号分隔带空格与空项', { storeIds: ' a1 , b2,,c_3 ' }],
    ['店铺数组', { storeIds: ['a1', 'b2'], legalEntityIds: 'le-1' }],
    ['店铺编号含非法字符', { storeIds: 'a b,ok' }],
    ['店铺编号过长', { storeIds: 'x'.repeat(65) }],
    ['店铺超过 100 个', { storeIds: Array.from({ length: 101 }, (_item, index) => `s${index}`).join(',') }],
    ['店铺数组超过 100 个', { storeIds: Array.from({ length: 101 }, (_item, index) => `s${index}`) }],
    ['店铺字符串超长', { storeIds: 'a,'.repeat(1100) }],
    ['店铺是数字', { storeIds: 5 }],
    ['店铺是 null', { storeIds: null }],
    ['店铺数组含数字', { storeIds: ['a', 1] }],
    ['非美国站', { marketplaceId: 'A1F83G8C2ARO7P' }],
    ['站点是数字', { marketplaceId: 1 }],
    ['合法日期范围', { from: '2026-01-01', to: '2026-01-31' }],
    ['只有开始日期', { from: '2026-01-01' }],
    ['只有结束日期', { to: '2026-01-01' }],
    ['结束早于开始', { from: '2026-02-01', to: '2026-01-01' }],
    ['恰好 1100 天', { from: '2023-01-01', to: '2026-01-04' }],
    ['超过 1100 天', { from: '2023-01-01', to: '2026-01-05' }],
    ['日期格式错', { from: '2026/01/01', to: '2026-01-31' }],
    ['日期不存在', { from: '2026-02-30', to: '2026-03-01' }],
    ['日期是数字', { from: 20260101, to: '2026-01-31' }],
    ['日期是 null', { from: null }],
    ['对比上期', { from: '2026-01-01', to: '2026-01-31', compare: 'previous' }],
    ['对比上期但没有时间范围', { compare: 'yoy' }],
    ['自定义对比完整', { from: '2026-01-01', to: '2026-01-31', compare: 'custom', compareFrom: '2025-01-01', compareTo: '2025-01-31' }],
    ['自定义对比缺结束', { from: '2026-01-01', to: '2026-01-31', compare: 'custom', compareFrom: '2025-01-01' }],
    ['自定义对比倒置', { from: '2026-01-01', to: '2026-01-31', compare: 'custom', compareFrom: '2025-02-01', compareTo: '2025-01-01' }],
    ['不是自定义却带了对比日期', { from: '2026-01-01', to: '2026-01-31', compare: 'previous', compareFrom: '2025-01-01' }],
    ['对比取值不合法', { compare: 'weekly' }],
    ['对比取值是数字', { compare: 3 }],
    ['币种口径', { displayCurrency: 'ORIGINAL' }],
    ['币种取值不合法', { displayCurrency: 'CNY' }],
    ['页面自己的参数原样带过', { term: 'shoes', page: '2', storeIds: 'a1' }],
    ['不是对象', 'abc'],
    ['数组', []],
    ['null', null],
  ]
  for (const [name, raw] of cases) it(name, () => expectSame(raw))

  it('错误原因是给用户看的中文', () => {
    const message = (raw: unknown) => {
      const result = parseScopeSearch(raw)
      return result.success ? '' : result.error.issues[0].message
    }
    expect(message({ from: '2026-01-01' })).toBe('开始日期与结束日期需要同时提供')
    expect(message({ marketplaceId: 'X' })).toBe('站点只支持亚马逊美国站')
    expect(message({ storeIds: 'a b' })).toBe('编号格式不正确')
    expect(message({ from: '2026-02-01', to: '2026-01-01' })).toBe('结束日期不能早于开始日期')
  })

  it('登记到路由表的解析器与函数同一个行为', () => {
    expect(ScopeSearchParser.safeParse({ storeIds: 'a' })).toEqual(parseScopeSearch({ storeIds: 'a' }))
  })

  it('随机组合 4000 次：结果一致（固定种子，可复现）', () => {
    let seed = 20261024
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]
    const pools: Record<string, readonly unknown[]> = {
      legalEntityIds: [undefined, undefined, 'le-1', 'le-1,le-2', ['le-1'], 'bad id', '', ',', 7],
      storeIds: [undefined, undefined, 's1', 's1, s2', ['s1', 's2'], 'a b', '', null, ['x', 2]],
      marketplaceId: [undefined, undefined, 'ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', null, 3],
      from: [undefined, '2026-01-01', '2026-03-31', '2026-02-30', '2026-13-01', 'abc', '', 20260101, null],
      to: [undefined, '2026-01-31', '2026-04-30', '2025-12-31', '2029-12-31', 'x', null],
      compare: [undefined, undefined, 'none', 'previous', 'yoy', 'custom', 'daily', 5],
      compareFrom: [undefined, undefined, '2025-01-01', '2025-02-30', 'z'],
      compareTo: [undefined, undefined, '2025-01-31', '2024-12-31', 9],
      displayCurrency: [undefined, undefined, 'USD', 'ORIGINAL', 'EUR', true],
    }
    for (let round = 0; round < 4000; round += 1) {
      const raw: Record<string, unknown> = {}
      for (const [key, pool] of Object.entries(pools)) {
        const value = pick(pool)
        if (value !== undefined) raw[key] = value
      }
      if (next() < 0.2) raw.page = '3'
      expectSame(raw)
    }
  })
})
