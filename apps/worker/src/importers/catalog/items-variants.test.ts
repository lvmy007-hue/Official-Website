import { describe, expect, it } from 'vitest'
import { parseCatalogItems } from './items-parse'
import { attributeChangeEvents, parentChangeEvents } from './variation-events'

// 变体属性解析与变体结构变更事件（P4-03）：只取变体主题列出的维度；站点不对的值不取；首次填入不记变更。

const US = 'ATVPDKIKX0DER'
const itemWith = (attributes: unknown, attributesNames: string[]) => ({
  items: [
    {
      asin: 'B0CHILD001',
      attributes,
      relationships: [{ marketplaceId: US, relationships: [{ type: 'VARIATION', parentAsins: ['B0PARENT01'], variationTheme: { attributes: attributesNames, theme: 'X' } }] }],
    },
  ],
})

describe('变体属性解析', () => {
  it('只取主题列出的维度，美国站优先，带单位的取值拼成文字，数字转文字', () => {
    const body = itemWith(
      {
        color: [
          { value: 'Rouge', marketplace_id: 'A2EUQ1WTGCTBG2' },
          { value: 'Red', marketplace_id: US },
        ],
        size: [{ value: 12, unit: 'inches', marketplace_id: US }],
        pattern: [{ value: '不在主题里', marketplace_id: US }],
        style: [{ value: 40, marketplace_id: US }],
      },
      ['color', 'size', 'style'],
    )
    expect(parseCatalogItems(body).items[0]!.variantValues).toEqual({ color: 'Red', size: '12 inches', style: '40' })
  })

  it('主题没列出维度、属性缺失、只有别的站点的值：都是空对象（不猜、不补）', () => {
    expect(parseCatalogItems(itemWith({ color: [{ value: 'Red', marketplace_id: US }] }, [])).items[0]!.variantValues).toEqual({})
    expect(parseCatalogItems(itemWith(undefined, ['color'])).items[0]!.variantValues).toEqual({})
    expect(
      parseCatalogItems(
        itemWith(
          {
            color: [
              { value: 'Rouge', marketplace_id: 'A2EUQ1WTGCTBG2' },
              { value: 'Rot', marketplace_id: 'A1PA6795UKMFR9' },
            ],
          },
          ['color'],
        ),
      ).items[0]!.variantValues,
    ).toEqual({})
    expect(parseCatalogItems(itemWith({ color: [{ value: '  ', marketplace_id: US }] }, ['color'])).items[0]!.variantValues).toEqual({})
  })

  it('维度名不合法（含符号）的跳过', () => {
    expect(parseCatalogItems(itemWith({ 'a-b': [{ value: 'x', marketplace_id: US }] }, ['a-b'])).items[0]!.variantValues).toEqual({})
  })
})

describe('变体结构变更事件', () => {
  const base = { childAsin: 'B0CHILD001', day: '2026-10-25' }

  it('父体变了：旧父体记移除、新父体记新增；脱离与加入变体组各记一条；没变化与首次同步不记', () => {
    const moved = parentChangeEvents({ ...base, before: 'B0OLD', after: 'B0NEW', previouslySynced: true })
    expect(moved.map(event => `${event.entityId}:${event.kind}`)).toEqual(['B0OLD:variation.child_removed', 'B0NEW:variation.child_added'])
    expect(moved[0]!.sourceRef).toBe('catalog:child_removed:B0CHILD001:2026-10-25')
    expect(parentChangeEvents({ ...base, before: 'B0OLD', after: null, previouslySynced: true }).map(event => event.kind)).toEqual(['variation.child_removed'])
    expect(parentChangeEvents({ ...base, before: null, after: 'B0NEW', previouslySynced: true }).map(event => event.kind)).toEqual(['variation.child_added'])
    expect(parentChangeEvents({ ...base, before: 'B0A', after: 'B0A', previouslySynced: true })).toEqual([])
    expect(parentChangeEvents({ ...base, before: null, after: 'B0NEW', previouslySynced: false })).toEqual([])
  })

  it('属性变化：只比较前后都有值且不同的维度，按名称排序；没有父体或首次同步不记', () => {
    const input = { productId: 'p1', childAsin: 'B0CHILD001', parentAsin: 'B0PARENT01', previouslySynced: true, day: '2026-10-25' }
    const events = attributeChangeEvents({ ...input, before: { size: 'M', color: 'Blue', style: 'A' }, after: { color: 'Red', size: 'M', pattern: 'Dots' } })
    expect(events.map(event => event.title)).toEqual(['变体属性 color 由「Blue」变为「Red」'])
    expect(events[0]).toMatchObject({ entityType: 'ASIN', entityId: 'p1', kind: 'variation.attribute_change', detailJson: { parentAsin: 'B0PARENT01' } })
    expect(attributeChangeEvents({ ...input, before: null, after: { color: 'Red' } })).toEqual([])
    expect(attributeChangeEvents({ ...input, parentAsin: null, before: { color: 'Blue' }, after: { color: 'Red' } })).toEqual([])
    expect(attributeChangeEvents({ ...input, previouslySynced: false, before: { color: 'Blue' }, after: { color: 'Red' } })).toEqual([])
  })
})
