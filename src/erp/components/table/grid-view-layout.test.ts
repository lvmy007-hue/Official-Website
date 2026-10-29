import { describe, expect, it } from 'vitest'
import { emptyViewConfig, viewConfigOf } from '@nova/api-contracts'
import { applyLayout, countInvalid, dropInvalid, layoutEventOf, sameConfig, withBinding } from './grid-view-layout'
import type { ErpColDef } from './grid-types'

// 表格视图的纯函数（P6-03）：套用顺序、列宽与固定；统计并丢弃已失效的列；比较两份视图；把人手拖动列、拉宽转成版式变化。

type Row = { a: string }
const col = (id: string, over: Partial<ErpColDef<Row>> = {}): ErpColDef<Row> => ({ colId: id, headerName: id.toUpperCase(), ...over })
const columns = [col('sku', { pin: 'left' }), col('units'), col('sales'), col('cost')]
const config = (over: Record<string, unknown>) => viewConfigOf(over)
const ids = (list: ErpColDef<Row>[]) => list.map(item => item.colId)

describe('套用版式', () => {
  it('没有顺序时保持页面默认顺序；列宽与固定覆盖到对应列，页面自己固定的列不被改', () => {
    const out = applyLayout(columns, config({ widths: { units: 150 }, pinned: { sales: 'left', sku: 'right' } }))
    expect(ids(out)).toEqual(['sku', 'units', 'sales', 'cost'])
    expect(out[0]!.pin).toBe('left')
    expect(out[1]).toMatchObject({ width: 150 })
    expect(out[2]).toMatchObject({ pin: 'left' })
    expect(columns[1]!.width).toBeUndefined()
  })

  it('按视图里的顺序重排；没出现在顺序里的列保持原有相对顺序，排在后面', () => {
    expect(ids(applyLayout(columns, config({ order: ['cost', 'units'] })))).toEqual(['cost', 'units', 'sku', 'sales'])
    // 顺序里有页面已经没有的列：忽略
    expect(ids(applyLayout(columns, config({ order: ['gone', 'sales'] })))).toEqual(['sales', 'sku', 'units', 'cost'])
  })
})

describe('已失效的条件', () => {
  const stale = config({ hidden: ['units', 'gone'], order: ['sales', 'gone2'], widths: { gone: 100, cost: 90 }, pinned: { gone3: 'left' }, sort: { field: 'removed', direction: 'asc' } })

  it('数出视图里引用了、但页面里已经没有的列和排序字段', () => {
    expect(countInvalid(stale, ['sku', 'units', 'sales', 'cost'], ['units'])).toBe(5)
    expect(countInvalid(emptyViewConfig(), ['sku'], [])).toBe(0)
    // 不跟踪排序的表格（sortFields 为空）不数排序
    expect(countInvalid(stale, ['sku', 'units', 'sales', 'cost'], null)).toBe(4)
  })

  it('丢弃失效项后，隐藏、顺序、列宽、固定、排序里都只剩有效的', () => {
    const kept = dropInvalid(stale, ['sku', 'units', 'sales', 'cost'], ['units'])
    expect(kept).toMatchObject({ hidden: ['units'], order: ['sales'], widths: { cost: 90 }, pinned: {}, sort: null })
    expect(countInvalid(kept, ['sku', 'units', 'sales', 'cost'], ['units'])).toBe(0)
  })
})

describe('比较两份视图', () => {
  it('隐藏列与筛选的先后不影响；顺序与排序方向有影响', () => {
    expect(sameConfig(config({ hidden: ['a', 'b'], filters: { x: '1', y: '2' } }), config({ hidden: ['b', 'a'], filters: { y: '2', x: '1' } }))).toBe(true)
    expect(sameConfig(config({ order: ['a', 'b'] }), config({ order: ['b', 'a'] }))).toBe(false)
    expect(sameConfig(config({ sort: { field: 'f', direction: 'asc' } }), config({ sort: { field: 'f', direction: 'desc' } }))).toBe(false)
    expect(sameConfig(config({ dimension: 'sku' }), emptyViewConfig())).toBe(false)
    expect(sameConfig(config({ widths: { a: 100 } }), config({ widths: { a: 101 } }))).toBe(false)
  })

  it('页面的筛选与维度覆盖视图里的；没有绑定就原样', () => {
    const base = config({ filters: { tab: 'low' }, dimension: 'asin' })
    expect(withBinding(base, undefined)).toBe(base)
    expect(withBinding(base, { value: { tab: 'all', q: 'x' }, dimension: null, apply: () => 0 })).toMatchObject({ filters: { tab: 'all', q: 'x' }, dimension: null })
  })
})

describe('人手操作的列事件', () => {
  const api = { getColumnState: () => [{ colId: 'b' }, { colId: 'a' }] }
  const column = (id: string, width: number) => ({ getColId: () => id, getActualWidth: () => width })

  it('拖动列松手后给出完整顺序；拉宽松手后给出新列宽（取整）', () => {
    expect(layoutEventOf({ type: 'columnMoved', finished: true, source: 'uiColumnMoved', columns: null, api })).toEqual({ order: ['b', 'a'] })
    expect(layoutEventOf({ type: 'columnResized', finished: true, source: 'uiColumnResized', columns: [column('a', 150.4)], api })).toEqual({ widths: { a: 150 } })
  })

  it('没松手、接口调用、列定义刷新产生的事件一律不算用户的修改', () => {
    expect(layoutEventOf({ type: 'columnMoved', finished: false, source: 'uiColumnMoved', columns: null, api })).toBeNull()
    expect(layoutEventOf({ type: 'columnResized', finished: true, source: 'api', columns: [column('a', 100)], api })).toBeNull()
    expect(layoutEventOf({ type: 'columnMoved', finished: true, source: 'gridOptionsChanged', columns: null, api })).toBeNull()
    expect(layoutEventOf({ type: 'columnResized', finished: true, source: 'uiColumnResized', columns: [], api })).toBeNull()
  })
})
