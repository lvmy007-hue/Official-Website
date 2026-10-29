// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ColDef, ColGroupDef } from 'ag-grid-community'
import { columnPanelModel, prepareColumnDefs } from './grid-columns'
import { applyVisibility, loadHidden, hiddenStorageKey } from './grid-hidden'
import { buildSummaryRows } from './grid-summary'
import { numberColumn, textColumn } from './columns'
import type { ErpColDef } from './grid-types'

// 列定义转换的纯函数测试（P6-02）：固定列、两层表头、可排序白名单、汇总行的取值方式、列配置面板的结构、本机列配置的防御。

type Row = { id: string; a: string; b: number; c: number; d: number }
const col = (id: string, extra: ErpColDef<Row> = {}): ErpColDef<Row> => ({ ...textColumn<Row>(id, id as keyof Row & string), ...extra })
const isGroup = (def: ColDef<Row> | ColGroupDef<Row>): def is ColGroupDef<Row> => 'children' in def
const leaf = (def: ColDef<Row> | ColGroupDef<Row>): ColDef<Row> => {
  if (isGroup(def)) throw new Error('这里应该是单列')
  return def
}

describe('prepareColumnDefs：固定列', () => {
  it('pin 变成 AG Grid 的 pinned，并锁定不让用户拖走；自定义键不会漏进 AG Grid', () => {
    const defs = prepareColumnDefs<Row>({ columns: [col('a', { pin: 'left' }), col('b'), col('c', { pin: 'right' })], hidden: [] })
    expect(leaf(defs[0]!)).toMatchObject({ colId: 'a', pinned: 'left', lockPinned: true })
    expect(leaf(defs[1]!).pinned).toBeUndefined()
    expect(leaf(defs[2]!)).toMatchObject({ pinned: 'right', lockPinned: true })
    for (const def of defs) expect(Object.keys(def)).not.toEqual(expect.arrayContaining(['pin']))
    expect(Object.keys(leaf(defs[0]!))).not.toContain('group')
    expect(Object.keys(leaf(defs[0]!))).not.toContain('async')
  })

  it('不让 AG Grid 按第一行猜数据类型（汇总行里放文字时才不会显示 Invalid Number）', () => {
    const defs = prepareColumnDefs<Row>({ columns: [col('a')], hidden: [] })
    expect(leaf(defs[0]!).cellDataType).toBe(false)
  })
})

describe('prepareColumnDefs：两层表头', () => {
  it('相邻同名的列并成一组；不相邻的同名列各自成组，组编号不重复；没有分组的列保持单列', () => {
    const defs = prepareColumnDefs<Row>({ columns: [col('a', { group: '销售' }), col('b', { group: '销售' }), col('c'), col('d', { group: '销售' })], hidden: [] })
    expect(defs).toHaveLength(3)
    const [first, single, last] = defs
    expect(isGroup(first!) && first.headerName).toBe('销售')
    expect(isGroup(first!) && first.children.map(child => (child as ColDef<Row>).colId)).toEqual(['a', 'b'])
    expect(isGroup(single!)).toBe(false)
    expect(isGroup(last!) && last.headerName).toBe('销售')
    expect((first as ColGroupDef<Row>).groupId).not.toBe((last as ColGroupDef<Row>).groupId)
  })

  it('列配置面板：没有分组的平铺，同名分组不管是否相邻都并在一起，按首次出现排序', () => {
    const model = columnPanelModel<Row>([col('a', { group: '销售' }), col('b'), col('c', { group: '广告' }), col('d', { group: '销售' })])
    expect(model.ungrouped.map(item => item.id)).toEqual(['b'])
    expect(model.groups.map(group => [group.name, group.items.map(item => item.id)])).toEqual([
      ['销售', ['a', 'd']],
      ['广告', ['c']],
    ])
  })
})

describe('prepareColumnDefs：排序白名单与隐藏', () => {
  it('只有白名单里的列可排序；异步列永远不可排序；分页模式下本地比较器恒为 0（顺序交给服务端）', () => {
    const asyncSpec = { key: 'k', fetch: async () => ({ rows: {} }) }
    const defs = prepareColumnDefs<Row>({ columns: [col('a'), col('b', { async: asyncSpec }), col('c')], hidden: [], sortableFields: { a: 'a', b: 'b' }, serverSort: true })
    expect(leaf(defs[0]!).sortable).toBe(true)
    expect((leaf(defs[0]!).comparator as (...args: unknown[]) => number)(1, 2, {}, {}, false)).toBe(0)
    expect(leaf(defs[1]!).sortable).toBe(false)
    expect(leaf(defs[2]!).sortable).toBe(false)
    expect(leaf(defs[2]!).comparator).toBeUndefined()
  })

  it('隐藏的列 hide 为真', () => {
    const defs = prepareColumnDefs<Row>({ columns: [col('a'), col('b')], hidden: ['b'] })
    expect(leaf(defs[0]!).hide).toBe(false)
    expect(leaf(defs[1]!).hide).toBe(true)
  })
})

describe('汇总行', () => {
  it('汇总行只放服务端给的列；没给的列不出现（显示“—”），不会由前端补 0 或求和', () => {
    const columns = [col('a'), numberColumn<Row>('b', 'b'), numberColumn<Row>('c', 'c')]
    const rows = buildSummaryRows(columns, { status: 'ready', totals: { b: 12, c: null, zzz: 5 }, currency: null })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ __erpSummary: true, b: 12, c: null })
    expect(Object.keys(rows[0]!)).not.toContain('a')
    expect(Object.keys(rows[0]!)).not.toContain('zzz')
  })

  it('加载中显示占位行；读取失败、没有汇总接口都没有行', () => {
    expect(buildSummaryRows([col('a')], { status: 'loading' })).toHaveLength(1)
    expect(buildSummaryRows([col('a')], { status: 'error', forbidden: false })).toEqual([])
    expect(buildSummaryRows([col('a')], { status: 'idle' })).toEqual([])
  })

  it('汇总行的取值：钉住的行按列标识取，数据行仍按字段取，自带取值函数的列也不会被汇总行数据弄坏', () => {
    const getter = (params: { data?: Row }) => (params.data ? params.data.b * 2 : undefined)
    const defs = prepareColumnDefs<Row>({ columns: [col('a'), { ...col('b'), valueGetter: p => getter(p) }], hidden: [], summary: true })
    const a = leaf(defs[0]!).valueGetter as (p: unknown) => unknown
    const b = leaf(defs[1]!).valueGetter as (p: unknown) => unknown
    const dataRow = { id: '1', a: '甲', b: 4, c: 0, d: 0 }
    expect(a({ data: dataRow, node: { rowPinned: undefined } })).toBe('甲')
    expect(b({ data: dataRow, node: { rowPinned: undefined } })).toBe(8)
    expect(b({ data: { __erpSummary: true, b: 100 }, node: { rowPinned: 'top' } })).toBe(100)
    expect(a({ data: { __erpSummary: true }, node: { rowPinned: 'top' } })).toBeUndefined()
  })
})

describe('本机列配置', () => {
  beforeEach(() => window.localStorage.clear())

  it('读取时只取字符串、去重、限长、限个数；坏数据当没有', () => {
    const key = hiddenStorageKey('g')
    window.localStorage.setItem(key, JSON.stringify(['a', 'a', 3, null, 'x'.repeat(101), 'b']))
    expect(loadHidden('g')).toEqual(['a', 'b'])
    window.localStorage.setItem(key, JSON.stringify(Array.from({ length: 500 }, (_, i) => `c${i}`)))
    expect(loadHidden('g')).toHaveLength(200)
    window.localStorage.setItem(key, '{"a":1}')
    expect(loadHidden('g')).toEqual([])
    window.localStorage.setItem(key, '不是 JSON')
    expect(loadHidden('g')).toEqual([])
  })

  it('不能把列全部隐藏：隐藏到一列不剩时原样返回', () => {
    expect(applyVisibility([], ['a', 'b'], ['a'], false)).toEqual(['a'])
    expect(applyVisibility(['a'], ['a', 'b'], ['b'], false)).toEqual(['a'])
    expect(applyVisibility(['a'], ['a', 'b'], ['a'], true)).toEqual([])
    expect(applyVisibility([], ['a', 'b', 'c'], ['a', 'b'], false)).toEqual(['a', 'b'])
  })
})
