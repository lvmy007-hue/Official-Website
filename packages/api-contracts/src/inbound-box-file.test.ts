import { describe, expect, it } from 'vitest'
import { BOX_IMPORT_MAX_ROWS, BOX_TEMPLATE_KINDS, boxTemplateCsv, boxTemplateOf, isBoxTemplateKind, parseBoxFile } from './inbound-box-file.js'
import { INBOUND_MAX_BOXES } from './inbound.js'

const MIXED_HEADER = '箱号,SKU,每箱数量,重量(磅),长(英寸),宽(英寸),高(英寸),相同箱数'
const ORIGINAL_HEADER = 'SKU,每箱件数,箱数,重量(磅),长(英寸),宽(英寸),高(英寸)'
const text = (...lines: string[]) => lines.join('\r\n')
const messages = (result: ReturnType<typeof parseBoxFile>) => result.errors.map(error => `${error.line}:${error.message}`)

describe('装箱文件模板', () => {
  it('两种模板：UTF-8 带 BOM，表头后带示例行；白名单之外不是模板；模板自己能被自己的解析器读懂', () => {
    expect(BOX_TEMPLATE_KINDS).toEqual(['MIXED', 'ORIGINAL'])
    expect(isBoxTemplateKind('MIXED')).toBe(true)
    expect(isBoxTemplateKind('WHATEVER')).toBe(false)
    for (const kind of BOX_TEMPLATE_KINDS) {
      const csv = boxTemplateCsv(kind)
      expect(csv.startsWith('\uFEFF')).toBe(true)
      expect(csv).toContain('\r\n')
      const parsed = parseBoxFile(csv, kind, ['SKU-A', 'SKU-B'])
      expect(parsed.errors, kind).toEqual([])
      expect(parsed.boxes.length).toBeGreaterThan(0)
    }
    expect(boxTemplateOf('ORIGINAL')).toMatchObject({ kind: 'ORIGINAL', maxRows: 2000 })
    expect(boxTemplateOf('MIXED').columns.find(column => column.label === '相同箱数')?.required).toBe(false)
  })
})

describe('混装文件解析', () => {
  it('同箱号多行合并成一个箱子；相同箱数可省略（默认 1）；英文表头与带引号、制表符分隔都认', () => {
    const result = parseBoxFile(text(MIXED_HEADER, 'B1,SKU-A,6,22,16,12,10,2', 'B1,SKU-B,2,22,16,12,10,2', 'B2,"SKU-A",4,18,14,12,10'), 'MIXED', ['SKU-A', 'SKU-B'])
    expect(result.errors).toEqual([])
    expect(result.rows).toBe(3)
    expect(result.boxes).toEqual([
      {
        boxId: 'B1',
        quantity: 2,
        weightLb: 22,
        lengthIn: 16,
        widthIn: 12,
        heightIn: 10,
        items: [
          { sku: 'SKU-A', quantity: 6 },
          { sku: 'SKU-B', quantity: 2 },
        ],
      },
      { boxId: 'B2', quantity: 1, weightLb: 18, lengthIn: 14, widthIn: 12, heightIn: 10, items: [{ sku: 'SKU-A', quantity: 4 }] },
    ])
    const english = parseBoxFile('Box ID\tSKU\tQty\tWeight (lb)\tLength\tWidth\tHeight\nB1\tX\t3\t5\t6\t7\t8', 'MIXED')
    expect(english.errors).toEqual([])
    expect(english.boxes[0]).toMatchObject({ boxId: 'B1', items: [{ sku: 'X', quantity: 3 }], weightLb: 5, heightIn: 8 })
  })

  it('同箱号的尺寸、重量或相同箱数不一致，同一箱里同一 SKU 数量不同都整份拒绝', () => {
    const mismatch = parseBoxFile(text(MIXED_HEADER, 'B1,A,1,10,10,10,10', 'B1,B,1,11,10,10,10'), 'MIXED')
    expect(messages(mismatch)).toEqual(['3:箱 B1 的重量、尺寸或相同箱数与第 2 行不一致'])
    expect(mismatch.boxes).toEqual([])
    const duplicate = parseBoxFile(text(MIXED_HEADER, 'B1,A,1,10,10,10,10', 'B1,A,2,10,10,10,10'), 'MIXED')
    expect(messages(duplicate)[0]).toContain('B1 里 A 重复')
  })

  it('完全相同的行只留第一行并告知，不翻倍装箱', () => {
    const result = parseBoxFile(text(MIXED_HEADER, 'B1,A,1,10,10,10,10', 'B1,A,1,10,10,10,10', '', 'B2,A,1,10,10,10,10'), 'MIXED')
    expect(result.errors).toEqual([])
    expect(result.skipped).toEqual([{ line: 3, message: '与第 2 行完全相同，已跳过' }])
    expect(result.boxes.map(box => box.boxId)).toEqual(['B1', 'B2'])
    expect(result.boxes[0]!.items).toEqual([{ sku: 'A', quantity: 1 }])
  })
})

describe('原厂包装文件解析', () => {
  it('一行一种规格，不写箱号（导入后自动编号）；同一 SKU 多种规格各占一行', () => {
    const result = parseBoxFile(text(ORIGINAL_HEADER, 'SKU-A,24,10,28,18,14,12', 'SKU-A,12,1,15,18,14,12', 'SKU-B,5,3,8,10,10,10'), 'ORIGINAL', ['SKU-A', 'SKU-B'])
    expect(result.errors).toEqual([])
    expect(result.boxes).toEqual([
      { quantity: 10, weightLb: 28, lengthIn: 18, widthIn: 14, heightIn: 12, items: [{ sku: 'SKU-A', quantity: 24 }] },
      { quantity: 1, weightLb: 15, lengthIn: 18, widthIn: 14, heightIn: 12, items: [{ sku: 'SKU-A', quantity: 12 }] },
      { quantity: 3, weightLb: 8, lengthIn: 10, widthIn: 10, heightIn: 10, items: [{ sku: 'SKU-B', quantity: 5 }] },
    ])
  })

  it('箱数是必填列：缺了整份拒绝', () => {
    const result = parseBoxFile(text('SKU,每箱件数,重量,长,宽,高', 'A,1,1,1,1,1'), 'ORIGINAL')
    expect(messages(result)).toEqual(['1:缺少“箱数”列'])
  })
})

describe('整份拒绝的情形', () => {
  it('空文件、只有表头、缺关键列', () => {
    expect(messages(parseBoxFile('', 'MIXED'))).toEqual(['0:文件是空的'])
    expect(messages(parseBoxFile('\uFEFF  \r\n', 'MIXED'))).toEqual(['0:文件是空的'])
    expect(messages(parseBoxFile(MIXED_HEADER, 'MIXED'))[0]).toContain('没有数据行')
    const missing = parseBoxFile(text('箱号,SKU,每箱数量,重量,长', 'B1,A,1,1,1'), 'MIXED')
    expect(messages(missing)).toEqual(['1:缺少“宽(英寸)”列', '1:缺少“高(英寸)”列'])
    expect(missing.boxes).toEqual([])
  })

  it('SKU 不在计划里：逐行指出；不给计划 SKU 时只做格式校验', () => {
    const content = text(MIXED_HEADER, 'B1,A,1,1,1,1,1', 'B2,GHOST,1,1,1,1,1')
    expect(messages(parseBoxFile(content, 'MIXED', ['A']))).toEqual(['3:SKU：GHOST 不在这个计划里'])
    expect(parseBoxFile(content, 'MIXED').errors).toEqual([])
  })

  it('数字不合法：必填为空、不是整数、不是正数、超上限都逐行逐列指出', () => {
    const result = parseBoxFile(text(MIXED_HEADER, ',A,1,1,1,1,1', 'B2,,1,1,1,1,1', 'B3,A,1.5,1,1,1,1', 'B4,A,1,0,1,1,1', 'B5,A,1,1,1,1,x', 'B6,A,1,1,1,1,1,0', 'B7,A,1,1,1,1,100001'), 'MIXED')
    expect(messages(result)).toEqual([
      '2:箱号：必填',
      '3:SKU：必填',
      '4:每箱数量：要是 1 到 1000000 的整数',
      '5:重量(磅)：要是大于 0 且不超过 100000 的数字',
      '6:高(英寸)：要是大于 0 且不超过 100000 的数字',
      '7:相同箱数：要是 1 到 10000 的整数',
      '8:高(英寸)：要是大于 0 且不超过 100000 的数字',
    ])
  })

  it('超过 2000 行整份拒绝（恰好 2000 行可以）', () => {
    const rows = (count: number) => Array.from({ length: count }, (_value, index) => `SKU-${index},1,1,1,1,1,1`)
    expect(BOX_IMPORT_MAX_ROWS).toBe(2000)
    const over = parseBoxFile(text(ORIGINAL_HEADER, ...rows(2001)), 'ORIGINAL')
    expect(messages(over)).toEqual(['0:一次最多导入 2000 行，现在有 2001 行'])
    const exact = parseBoxFile(text(ORIGINAL_HEADER, ...rows(2000)), 'ORIGINAL')
    expect(exact.errors.map(error => error.message)).toEqual([`箱型最多 ${INBOUND_MAX_BOXES} 个，现在有 2000 个：请把相同的箱子合并，用“相同箱数”表示`])
    expect(exact.boxes).toEqual([])
  })

  it('错误最多收集 50 条，不会无限增长', () => {
    const rows = Array.from({ length: 300 }, () => 'B,,1,1,1,1,1')
    expect(parseBoxFile(text(MIXED_HEADER, ...rows), 'MIXED').errors).toHaveLength(50)
  })
})
