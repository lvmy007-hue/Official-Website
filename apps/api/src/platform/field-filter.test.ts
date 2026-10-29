import { describe, expect, it } from 'vitest'
import { PROFIT_FIELD_RULES, PURCHASE_ORDER_FIELD_RULES, stripSensitiveFields, visibleColumns } from './field-filter'

describe('敏感字段过滤', () => {
  const data = {
    summary: { revenue: 1, cogs: 2, netProfit: 3 },
    bySku: [
      { sku: 'A', cogs: 1, grossProfit: 2 },
      { sku: 'B', cogs: 3, grossProfit: 4 },
    ],
    coverage: { n: 1 },
  }

  it('没有对应字段权限时，键不存在（不是空值）；有权限的字段原样保留', () => {
    const result = stripSensitiveFields(data, ['field.profit'], PROFIT_FIELD_RULES)
    expect(result.summary).toEqual({ revenue: 1, netProfit: 3 })
    expect(result.bySku).toEqual([
      { sku: 'A', grossProfit: 2 },
      { sku: 'B', grossProfit: 4 },
    ])
    expect('coverage' in result).toBe(false)
  })

  it('通配权限与全部字段权限都不过滤；原对象不被修改', () => {
    expect(stripSensitiveFields(data, ['*'], PROFIT_FIELD_RULES)).toBe(data)
    expect(stripSensitiveFields(data, ['field.cost', 'field.profit'], PROFIT_FIELD_RULES)).toEqual(data)
    stripSensitiveFields(data, [], PROFIT_FIELD_RULES)
    expect(data.summary.cogs).toBe(2)
  })

  it('根是数组、嵌套数组、路径不存在都能处理', () => {
    const orders = [
      { id: 1, totalAmount: 5, lines: [{ unitCost: 1, qty: 2 }] },
      { id: 2, lines: [] },
    ]
    expect(stripSensitiveFields(orders, [], PURCHASE_ORDER_FIELD_RULES)).toEqual([
      { id: 1, lines: [{ qty: 2 }] },
      { id: 2, lines: [] },
    ])
    expect(stripSensitiveFields(null, [], PROFIT_FIELD_RULES)).toBeNull()
    expect(stripSensitiveFields({ other: 1 }, [], PROFIT_FIELD_RULES)).toEqual({ other: 1 })
  })

  it('保留小数、日期等实例不被拆坏', () => {
    const when = new Date('2026-01-01T00:00:00Z')
    const result = stripSensitiveFields({ summary: { netProfit: 1, at: when } }, [], PROFIT_FIELD_RULES)
    expect(result.summary.at).toBe(when)
  })
})

describe('导出列的字段权限', () => {
  const columns = [
    { key: 'sku', title: 'SKU' },
    { key: 'cost', title: '成本', field: 'cost' as const },
    { key: 'profit', title: '利润', field: 'profit' as const },
    { key: 'buyer', title: '买家', field: 'buyer' as const },
  ]
  it('按发起人的字段权限决定列，没有权限的列整列不出现', () => {
    expect(visibleColumns(columns, ['field.profit']).map(c => c.key)).toEqual(['sku', 'profit'])
    expect(visibleColumns(columns, []).map(c => c.key)).toEqual(['sku'])
    expect(visibleColumns(columns, ['*']).map(c => c.key)).toEqual(['sku', 'cost', 'profit', 'buyer'])
  })
})
