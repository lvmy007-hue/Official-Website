import { describe, expect, it } from 'vitest'
import { parseCostFile } from './costs-import'

// 商品成本文件解析（importers.md F-04）：中英文表头、引号、千分位；一行有错整份拒绝。
const MAX_DAY = '2027-06-01'

describe('parseCostFile', () => {
  it('中英文表头都认；金额去千分位；币种转大写；空的成本项是“没有这一项”不是 0', () => {
    const csv = '\uFEFFSKU,生效日期,币种,采购单价,头程分摊,关税,其他成本,备注\n"SKU,1",2026/9/1,usd,"1,234.5",,0,2,"含税, 已确认"\n'
    const { rows, errors } = parseCostFile(csv, MAX_DAY)
    expect(errors).toEqual([])
    expect(rows).toEqual([{ line: 2, sku: 'SKU,1', effectiveFrom: '2026-09-01', currency: 'USD', amounts: { product: 1234.5, firstMile: null, duty: 0, other: 2 }, note: '含税, 已确认' }])
    const english = parseCostFile('sku\teffective-from\tcurrency\tunit cost\nA\t2026-01-02\tCNY\t8\n', MAX_DAY)
    expect(english.rows[0]).toMatchObject({ sku: 'A', amounts: { product: 8, firstMile: null } })
  })

  it('表头缺必需列、没有成本列、没有数据行、行数过多：整份拒绝并说明', () => {
    expect(parseCostFile('SKU,币种,采购单价\nA,USD,1\n', MAX_DAY).errors[0]).toContain('生效日期')
    expect(parseCostFile('SKU,生效日期,币种\nA,2026-01-01,USD\n', MAX_DAY).errors[0]).toContain('成本列')
    expect(parseCostFile('SKU,生效日期,币种,采购单价\n', MAX_DAY).errors[0]).toContain('没有数据行')
    const many = `SKU,生效日期,币种,采购单价\n${Array.from({ length: 501 }, (_, index) => `S${index},2026-01-01,USD,1`).join('\n')}\n`
    expect(parseCostFile(many, MAX_DAY).errors[0]).toContain('最多 500')
  })

  it('逐行校验：日期、未来日期、币种、金额、至少一项成本、同 SKU 同日重复；错误带行号且至多 10 条', () => {
    const csv = [
      'SKU,生效日期,币种,采购单价,关税',
      ',2026-01-01,USD,1,',
      'A,2026-13-01,USD,1,',
      'A,2028-01-01,USD,1,',
      'A,2026-01-01,US,1,',
      'A,2026-01-01,USD,-1,',
      'A,2026-01-01,USD,1.1234567,',
      'A,2026-01-01,USD,,',
      'A,2026-01-01,USD,1,',
      'A,2026-01-01,USD,2,',
      'B,2026-01-01,USD,x,',
      'C,2026-01-01,USD,x,',
    ].join('\n')
    const { rows, errors } = parseCostFile(csv, MAX_DAY)
    expect(rows).toEqual([])
    expect(errors).toHaveLength(10)
    expect(errors[0]).toContain('第 2 行')
    expect(errors[1]).toContain('第 3 行')
    expect(errors.some(message => message.includes('晚于'))).toBe(true)
    expect(errors.some(message => message.includes('至少填一项'))).toBe(true)
    expect(errors.some(message => message.includes('出现了多次'))).toBe(true)
  })
})
