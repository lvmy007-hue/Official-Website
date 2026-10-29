import { describe, expect, it } from 'vitest'
import { parseCsvTable } from './csv-table.js'
import { SKU_ALIAS_IMPORT_MAX_ROWS, parseSkuAliasFile, skuAliasExportCsv, skuAliasTemplateCsv } from './sku-alias.js'

// 外部货号映射导入导出文件（P6-11）与 CSV 表格切分。

describe('外部货号映射文件', () => {
  it('模板可以直接导入；供应商编码留空是通用映射；表头认中英文别名', () => {
    const parsed = parseSkuAliasFile(skuAliasTemplateCsv())
    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toEqual([
      { line: 2, supplierCode: 'SUP-001', externalCode: 'AB-1001', sku: 'SKU-A' },
      { line: 3, supplierCode: null, externalCode: '条码-6901234567890', sku: 'SKU-B' },
    ])
    expect(parseSkuAliasFile('external code;SKU\nX1;S1').rows).toEqual([{ line: 2, supplierCode: null, externalCode: 'X1', sku: 'S1' }])
  })

  it('导出的文件再导入得到同样的内容（含逗号、引号的货号）', () => {
    const rows = [
      { supplierCode: 'SUP-1', externalCode: 'A,1', sku: 'S1' },
      { supplierCode: null, externalCode: 'B"2', sku: 'S2' },
    ]
    const parsed = parseSkuAliasFile(skuAliasExportCsv(rows))
    expect(parsed.errors).toEqual([])
    expect(parsed.rows.map(row => ({ supplierCode: row.supplierCode, externalCode: row.externalCode, sku: row.sku }))).toEqual(rows)
  })

  it('整份校验：缺列、空文件、没数据行、超行、必填、过长、同货号不同 SKU 都报错并且不返回任何行', () => {
    expect(parseSkuAliasFile('').errors[0]!.message).toBe('文件是空的')
    expect(parseSkuAliasFile('外部货号\nA').errors.map(error => error.message)).toEqual(['缺少“SKU”列'])
    expect(parseSkuAliasFile('外部货号,SKU').errors[0]!.message).toContain('没有数据行')
    const many = ['外部货号,SKU', ...Array.from({ length: SKU_ALIAS_IMPORT_MAX_ROWS + 1 }, (_, index) => `A${index},S`)].join('\n')
    expect(parseSkuAliasFile(many).errors[0]!.message).toContain('一次最多导入')
    const bad = parseSkuAliasFile(['外部货号,SKU', ',S1', 'A1,', `${'x'.repeat(121)},S1`, 'D1,S1', 'D1,S2', 'D1,S1'].join('\n'))
    expect(bad.rows).toEqual([])
    expect(bad.errors.map(error => [error.line, error.message])).toEqual([
      [2, '外部货号必填'],
      [3, 'SKU 必填'],
      [4, '外部货号太长（最多 120 个字）'],
      [6, '外部货号 D1 与第 5 行重复，但 SKU 不同'],
    ])
  })

  it('同一个（供应商，货号）重复且 SKU 相同时只留一条；不同供应商同货号互不影响', () => {
    const parsed = parseSkuAliasFile(['供应商编码,外部货号,SKU', 'S1,A,X', 'S1,A,X', 'S2,A,Y'].join('\n'))
    expect(parsed.errors).toEqual([])
    expect(parsed.rows.map(row => [row.supplierCode, row.sku])).toEqual([
      ['S1', 'X'],
      ['S2', 'Y'],
    ])
  })
})

describe('CSV 表格切分', () => {
  it('空行保留为空行（行号与文件一致）；引号内的逗号与换行不拆；制表符、分号分隔也能认', () => {
    expect(parseCsvTable('a,b\n\n"c,1","d""x"')).toEqual([['a', 'b'], [], ['c,1', 'd"x']])
    expect(parseCsvTable('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsvTable('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})
