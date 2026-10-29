import { describe, expect, it } from 'vitest'
import { SYSTEM_PROFIT_ITEMS, buildDictionaryResolver, defaultTargetOfType, effectiveTargetOf, transactionTypeKey, transactionTypeLabel, type ProfitItemNode } from './profit-items.js'
import { buildDictionaryView } from './profit-items-view.js'
import { NEW_ID_PREFIX, planProfitItemTree, type StoredProfitItem } from './profit-items-tree.js'
import { ProfitItemTreeBodySchema, ProfitUnmappedQuerySchema } from './profit-items-query.js'

// 利润项目字典（P6-18）：交易类型键、项目归属、解析器、整树校验、字典视图与利润桥对账、请求校验。

const stored: StoredProfitItem[] = SYSTEM_PROFIT_ITEMS.map((item, index) => ({
  id: `id:${item.key}`,
  parentId: item.parent === null ? null : `id:${item.parent}`,
  level: item.parent === null ? 1 : 2,
  name: item.name,
  group: item.group,
  sign: item.sign,
  isSystem: true,
  systemKey: item.key,
  sort: index,
}))
const byId = new Map<string, ProfitItemNode>(stored.map(item => [item.id, item]))
const bodyItems = (extra: Array<{ id: string; parentId: string | null; name: string; sort: number; group?: 'OTHER'; sign?: 1 | -1 }> = []) => [
  ...stored.map(item => ({ id: item.id, parentId: item.parentId, name: item.name, sort: item.sort })),
  ...extra,
]

describe('交易类型', () => {
  it('键是“分类/子类型”，没有子类型只有分类；易读名认不出的分类原样显示', () => {
    expect(transactionTypeKey('COMMISSION', 'ReferralFee')).toBe('COMMISSION/ReferralFee')
    expect(transactionTypeKey('COMMISSION', null)).toBe('COMMISSION')
    expect(transactionTypeLabel('NON_FEE/Principal')).toContain('非费用')
    expect(transactionTypeLabel('MYSTERY')).toBe('MYSTERY')
  })
  it('内置口径：佣金归佣金，销售本金归销售收入', () => {
    expect(defaultTargetOfType('COMMISSION/ReferralFee')).toBe('COMMISSION')
    expect(defaultTargetOfType('NON_FEE/Principal')).toBe('REVENUE')
  })
})

describe('项目归属与解析器', () => {
  it('系统二级项目按自己的利润桥项目；广告与商品成本不接收交易；自定义项目沿用祖先', () => {
    expect(effectiveTargetOf(byId.get('id:COMMISSION') as ProfitItemNode, byId)).toBe('COMMISSION')
    expect(effectiveTargetOf(byId.get('id:ADS') as ProfitItemNode, byId)).toBeNull()
    expect(effectiveTargetOf(byId.get('id:PRODUCT_COST') as ProfitItemNode, byId)).toBeNull()
    const custom: ProfitItemNode = { id: 'c1', parentId: 'id:STORAGE', group: 'LOGISTICS_FEE', systemKey: null }
    expect(effectiveTargetOf(custom, new Map([...byId, ['c1', custom]]))).toBe('STORAGE')
  })

  it('已映射按项目口径并带项目键；未映射按内置口径并打上 ~: 键', () => {
    const resolve = buildDictionaryResolver(stored, [{ transactionType: 'COMMISSION/ReferralFee', itemId: 'id:OTHER_FEES' }])
    expect(resolve('COMMISSION', 'ReferralFee')).toEqual({ target: 'OTHER_FEES', itemKey: 'id:OTHER_FEES', mapped: true })
    expect(resolve('NON_FEE', 'Principal')).toEqual({ target: 'REVENUE', itemKey: '~:REVENUE', mapped: false })
  })

  it('映射到已不接收交易的项目时回到内置口径', () => {
    const resolve = buildDictionaryResolver(stored, [{ transactionType: 'COMMISSION/ReferralFee', itemId: 'id:ADS' }])
    expect(resolve('COMMISSION', 'ReferralFee').mapped).toBe(false)
  })
})

describe('整树校验', () => {
  it('原样保存通过；新增自定义子项目拿到临时编号', () => {
    expect(planProfitItemTree(stored, { items: bodyItems(), mappings: [] }).ok).toBe(true)
    const plan = planProfitItemTree(stored, { items: bodyItems([{ id: `${NEW_ID_PREFIX}1`, parentId: 'id:STORAGE', name: '长期仓储', sort: 99 }]), mappings: [] })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.items.find(item => item.name === '长期仓储')).toMatchObject({ isNew: true, level: 3, group: 'LOGISTICS_FEE' })
  })

  it('系统项目不能删除；同级重名、超过三级、映射到不接收交易的项目、重复映射都不通过', () => {
    expect(planProfitItemTree(stored, { items: bodyItems().filter(item => item.id !== 'id:STORAGE'), mappings: [] }).ok).toBe(false)
    expect(
      planProfitItemTree(stored, {
        items: bodyItems([
          { id: `${NEW_ID_PREFIX}1`, parentId: 'id:STORAGE', name: '甲', sort: 1 },
          { id: `${NEW_ID_PREFIX}2`, parentId: 'id:STORAGE', name: '甲', sort: 2 },
        ]),
        mappings: [],
      }).ok,
    ).toBe(false)
    const deep = [
      { id: `${NEW_ID_PREFIX}1`, parentId: 'id:STORAGE', name: '三级', sort: 1 },
      { id: `${NEW_ID_PREFIX}2`, parentId: `${NEW_ID_PREFIX}1`, name: '四级', sort: 1 },
    ]
    expect(planProfitItemTree(stored, { items: bodyItems(deep), mappings: [] }).ok).toBe(false)
    expect(planProfitItemTree(stored, { items: bodyItems(), mappings: [{ transactionType: 'X', itemId: 'id:ADS' }] }).ok).toBe(false)
    expect(
      planProfitItemTree(stored, {
        items: bodyItems(),
        mappings: [
          { transactionType: 'X', itemId: 'id:STORAGE' },
          { transactionType: 'X', itemId: 'id:COMMISSION' },
        ],
      }).ok,
    ).toBe(false)
  })
})

describe('字典视图与利润桥对账', () => {
  const items = stored.map(item => ({ ...item }))
  const contribution = { REVENUE: 1000, COMMISSION: -150, ADS: -100, PRODUCT_COST: -300, DUTY: -20 }
  const netProfit = 430

  it('没有按项目拆分的数据时，余量记在系统项目上，合计等于净利润', () => {
    const view = buildDictionaryView({ version: 1, items, sums: new Map(), contribution, netProfit, rowsWithItems: 0, rowsTotal: 3 })
    expect(view.total).toBe(430)
    expect(view.balanced).toBe(true)
    expect(view.note).toContain('还没有按项目字典重算')
    expect(view.rows.find(row => row.name === '关税')?.own).toBe(-20)
  })

  it('改映射只在项目之间挪金额，合计不变；未映射金额单列', () => {
    const sums = new Map([
      ['id:OTHER_FEES', -40],
      ['id:COMMISSION', -110],
      ['~:COMMISSION', 0],
      ['~:OTHER_FEES', 0],
    ])
    const view = buildDictionaryView({ version: 2, items, sums, contribution: { ...contribution, OTHER_FEES: -40, COMMISSION: -110 }, netProfit: 430, rowsWithItems: 2, rowsTotal: 2 })
    expect(view.balanced).toBe(true)
    const unmappedView = buildDictionaryView({ version: 2, items, sums: new Map([['~:COMMISSION', -150]]), contribution, netProfit, rowsWithItems: 2, rowsTotal: 2 })
    expect(unmappedView.unmappedAmount).toBe(-150)
    expect(unmappedView.balanced).toBe(true)
    expect(unmappedView.note).toContain('没有映射')
  })

  it('没有利润数据时提示范围内没有数据', () => {
    const view = buildDictionaryView({ version: 1, items, sums: new Map(), contribution: {}, netProfit: null, rowsWithItems: 0, rowsTotal: 0 })
    expect(view.total).toBeNull()
    expect(view.balanced).toBeNull()
    expect(view.note).toContain('没有利润数据')
  })
})

describe('请求校验', () => {
  it('保存必须带版本；名称不能为空或超长；多余字段拒绝', () => {
    const item = { id: 'a', parentId: null, name: '项', sort: 1 }
    expect(ProfitItemTreeBodySchema.safeParse({ version: 1, items: [item], mappings: [] }).success).toBe(true)
    expect(ProfitItemTreeBodySchema.safeParse({ items: [item], mappings: [] }).success).toBe(false)
    expect(ProfitItemTreeBodySchema.safeParse({ version: 1, items: [{ ...item, name: ' ' }], mappings: [] }).success).toBe(false)
    expect(ProfitItemTreeBodySchema.safeParse({ version: 1, items: [{ ...item, name: 'x'.repeat(41) }], mappings: [] }).success).toBe(false)
    expect(ProfitItemTreeBodySchema.safeParse({ version: 1, items: [{ ...item, extra: 1 }], mappings: [] }).success).toBe(false)
  })
  it('未映射列表只能按近 30 天笔数排序', () => {
    expect(ProfitUnmappedQuerySchema.safeParse({ sort: 'txCount30d:asc' }).success).toBe(true)
    expect(ProfitUnmappedQuerySchema.safeParse({ sort: 'password:asc' }).success).toBe(false)
  })
})
