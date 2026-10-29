import { describe, expect, it } from 'vitest'
import { ADS_CHANGE_CREATED, ADS_CHANGE_ENTITY_TYPES, ADS_CHANGE_FIELDS } from './ads-changes'
import { adsChangePath, changeFieldLabel, changeStateFromJson, changeStateOf, changeValueText, clipChangeText, diffChangeStates, isOwnChange, normalizeChangeValue } from './ads-changes-math'
import { AdsChangeListQuerySchema } from './ads-changes-query'

describe('广告变更：字段值规整', () => {
  it('空、空串、全空白都是 null，不是 0', () => {
    for (const kind of ['text', 'money', 'state', 'date'] as const) {
      expect(normalizeChangeValue(kind, null)).toBeNull()
      expect(normalizeChangeValue(kind, undefined)).toBeNull()
      expect(normalizeChangeValue(kind, '')).toBeNull()
      expect(normalizeChangeValue(kind, '   ')).toBeNull()
    }
    expect(normalizeChangeValue('money', 0)).toBe('0')
  })

  it('金额去掉多余的 0 与浮点尾巴；不是数字的原样保留', () => {
    expect(normalizeChangeValue('money', '1.500000')).toBe('1.5')
    expect(normalizeChangeValue('money', 1.25)).toBe('1.25')
    expect(normalizeChangeValue('money', 0.1 + 0.2)).toBe('0.3')
    expect(normalizeChangeValue('money', '20.000000')).toBe('20')
    expect(normalizeChangeValue('money', 'abc')).toBe('abc')
  })

  it('状态转大写、文字去首尾空格、日期取年月日', () => {
    expect(normalizeChangeValue('state', ' enabled ')).toBe('ENABLED')
    expect(normalizeChangeValue('text', '  瑜伽垫  ')).toBe('瑜伽垫')
    expect(normalizeChangeValue('date', new Date('2026-10-05T16:00:00.000Z'))).toBe('2026-10-05')
    expect(normalizeChangeValue('date', '2026-10-05T00:00:00.000Z')).toBe('2026-10-05')
    expect(normalizeChangeValue('date', 'someday')).toBe('someday')
  })

  it('过长的值截断到上限', () => {
    expect(normalizeChangeValue('text', 'x'.repeat(900))).toHaveLength(500)
    expect(clipChangeText('y'.repeat(900))).toHaveLength(500)
    expect(clipChangeText('   ')).toBeNull()
    expect(clipChangeText(null)).toBeNull()
  })
})

describe('广告变更：状态与差异', () => {
  it('每种对象都有追踪字段，字段名不重复，状态类字段取值类型正确', () => {
    for (const type of ADS_CHANGE_ENTITY_TYPES) {
      const keys = ADS_CHANGE_FIELDS[type].map(field => field.key)
      expect(keys.length).toBeGreaterThan(0)
      expect(new Set(keys).size).toBe(keys.length)
    }
    expect(ADS_CHANGE_FIELDS.CAMPAIGN.find(field => field.key === 'state')?.kind).toBe('state')
    expect(ADS_CHANGE_FIELDS.TARGET.find(field => field.key === 'bid')?.kind).toBe('money')
  })

  it('只取追踪字段并规整；多余的列（指标、标签、负责人）不进状态', () => {
    const state = changeStateOf('CAMPAIGN', { name: ' A ', state: 'enabled', budget: '20.000000', tags: ['x'], ownerId: 'u1', spend: 99, startDate: new Date('2026-10-01T00:00:00Z') })
    expect(state).toEqual({ name: 'A', state: 'ENABLED', budget: '20', bidStrategy: null, portfolioId: null, startDate: '2026-10-01', endDate: null })
  })

  it('库里的 JSON 还原：不认识的字段丢掉、缺的补 null、非文字按 null', () => {
    expect(changeStateFromJson('AD_GROUP', { name: 'G', state: 'ENABLED', defaultBid: 3, extra: 'x' })).toEqual({ name: 'G', state: 'ENABLED', defaultBid: null })
    expect(changeStateFromJson('AD_GROUP', null)).toEqual({ name: null, state: null, defaultBid: null })
    expect(changeStateFromJson('AD_GROUP', [1, 2])).toEqual({ name: null, state: null, defaultBid: null })
  })

  it('差异按字段定义的顺序；规整后相同的不算差异；从有到无与从无到有都算', () => {
    const before = changeStateOf('TARGET', { expression: 'yoga mat', matchType: 'EXACT', bid: '1.20', state: 'ENABLED' })
    const same = changeStateOf('TARGET', { expression: 'yoga mat', matchType: 'EXACT', bid: 1.2, state: 'enabled' })
    expect(diffChangeStates('TARGET', before, same)).toEqual([])
    const after = changeStateOf('TARGET', { expression: 'yoga mat', matchType: null, bid: 1.5, state: 'PAUSED' })
    expect(diffChangeStates('TARGET', before, after)).toEqual([
      { field: 'matchType', before: 'EXACT', after: null },
      { field: 'bid', before: '1.2', after: '1.5' },
      { field: 'state', before: 'ENABLED', after: 'PAUSED' },
    ])
  })
})

describe('广告变更：排除本系统自己的写入', () => {
  const diff = { field: 'bid', before: '1.2', after: '1.5' }

  it('同对象同字段、改后的值一致（规整后）就是本系统的写入', () => {
    expect(isOwnChange('TARGET', 't1', diff, [{ entityId: 't1', field: 'bid', after: '1.50' }])).toBe(true)
    expect(isOwnChange('TARGET', 't1', diff, [{ entityId: 't1', field: 'bid', after: '1.5' }])).toBe(true)
  })

  it('对象、字段、改后的值任一不同都不算', () => {
    expect(isOwnChange('TARGET', 't1', diff, [{ entityId: 't2', field: 'bid', after: '1.5' }])).toBe(false)
    expect(isOwnChange('TARGET', 't1', diff, [{ entityId: 't1', field: 'state', after: '1.5' }])).toBe(false)
    expect(isOwnChange('TARGET', 't1', diff, [{ entityId: 't1', field: 'bid', after: '1.6' }])).toBe(false)
    expect(isOwnChange('TARGET', 't1', diff, [])).toBe(false)
  })

  it('不认识的字段不算本系统写入；状态大小写不敏感；清空（null）能对上', () => {
    expect(isOwnChange('TARGET', 't1', { field: 'nope', before: 'a', after: 'b' }, [{ entityId: 't1', field: 'nope', after: 'b' }])).toBe(false)
    expect(isOwnChange('TARGET', 't1', { field: 'state', before: 'ENABLED', after: 'PAUSED' }, [{ entityId: 't1', field: 'state', after: 'paused' }])).toBe(true)
    expect(isOwnChange('CAMPAIGN', 'c1', { field: 'endDate', before: '2026-12-31', after: null }, [{ entityId: 'c1', field: 'endDate', after: null }])).toBe(true)
  })
})

describe('广告变更：显示', () => {
  it('字段名中文；新出现有专门的名字；不认识的字段原样', () => {
    expect(changeFieldLabel('CAMPAIGN', 'budget')).toBe('日预算')
    expect(changeFieldLabel('KEYWORD', 'text')).toBe('关键词')
    expect(changeFieldLabel('CAMPAIGN', ADS_CHANGE_CREATED)).toBe('新出现')
    expect(changeFieldLabel('CAMPAIGN', 'mystery')).toBe('mystery')
  })

  it('状态值翻成中文，不认识的原样；空保持 null；非状态字段不翻', () => {
    expect(changeValueText('CAMPAIGN', 'state', 'PAUSED')).toBe('已暂停')
    expect(changeValueText('CAMPAIGN', 'state', 'WEIRD')).toBe('WEIRD')
    expect(changeValueText('CAMPAIGN', 'state', null)).toBeNull()
    expect(changeValueText('CAMPAIGN', 'name', 'PAUSED')).toBe('PAUSED')
  })

  it('详情页路径：关键词与投放对象共用投放对象详情；编号被转义', () => {
    expect(adsChangePath('CAMPAIGN', 'c1')).toBe('/app/advertising/campaigns/c1')
    expect(adsChangePath('AD_GROUP', 'g1')).toBe('/app/advertising/ad-groups/g1')
    expect(adsChangePath('TARGET', 't1')).toBe('/app/advertising/targets/t1')
    expect(adsChangePath('KEYWORD', 'k1')).toBe('/app/advertising/targets/k1')
    expect(adsChangePath('PORTFOLIO', 'p 1')).toBe('/app/advertising/portfolios/p%201')
  })
})

describe('广告变更：列表参数', () => {
  it('默认按发生时间从新到旧；来源、对象类型必须是已知值；排序只认发生时间', () => {
    const parsed = AdsChangeListQuerySchema.parse({})
    expect(parsed.sort).toEqual({ field: 'occurredAt', dir: 'desc' })
    expect(AdsChangeListQuerySchema.parse({ source: 'EXTERNAL', entityType: 'KEYWORD', adsProfileId: 'ap-1', q: '瑜伽' })).toMatchObject({ source: 'EXTERNAL', entityType: 'KEYWORD' })
    expect(AdsChangeListQuerySchema.safeParse({ source: 'ROBOT' }).success).toBe(false)
    expect(AdsChangeListQuerySchema.safeParse({ entityType: 'AD' }).success).toBe(false)
    expect(AdsChangeListQuerySchema.safeParse({ sort: 'entityLabel:asc' }).success).toBe(false)
    expect(AdsChangeListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
    expect(AdsChangeListQuerySchema.safeParse({ pageSize: '201' }).success).toBe(false)
  })
})
