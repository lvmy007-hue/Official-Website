import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { readXlsx, XlsxError } from './xlsx-reader'

// 最小 XLSX 读取器（P6-11）：用 fflate 现场拼出几份合法与非法的文件。

const WORKBOOK = (sheets: Array<{ name: string; id: string; state?: string }>) =>
  `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="${sheet.id}"/>`)
    .join('')}</sheets></workbook>`
const RELS = (targets: Array<[string, string]>) =>
  `<?xml version="1.0"?><Relationships>${targets.map(([id, target]) => `<Relationship Id="${id}" Type="x" Target="${target}"/>`).join('')}</Relationships>`
const SHEET = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`

function build(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))
}
const SHARED = '<sst><si><t>箱号</t></si><si><t>货号</t></si><si><r><t>蓝牙</t></r><r><t xml:space="preserve"> 耳机</t></r><rPh><t>ignored</t></rPh></si><si><t>A &amp; B</t></si></sst>'

describe('readXlsx', () => {
  const standard = build({
    'xl/workbook.xml': WORKBOOK([
      { name: '装箱单', id: 'rId1' },
      { name: '隐藏页', id: 'rId2', state: 'hidden' },
      { name: '第二页', id: 'rId3' },
    ]),
    'xl/_rels/workbook.xml.rels': RELS([
      ['rId1', 'worksheets/sheet1.xml'],
      ['rId2', 'worksheets/sheet2.xml'],
      ['rId3', '/xl/worksheets/sheet3.xml'],
    ]),
    'xl/sharedStrings.xml': SHARED,
    'xl/worksheets/sheet1.xml': SHEET(
      [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>内联</t></is></c></row>',
        '<row r="3"><c r="A3"><v>12</v></c><c r="B3" t="s"><v>2</v></c><c r="C3"><v>0.1</v></c><c r="D3" t="s"><v>3</v></c><c r="E3" t="b"><v>1</v></c></row>',
        '<row r="4"><c r="A4" t="str"><v>公式结果</v></c><c r="B4" t="e"><v>#DIV/0!</v></c><c r="C4"/></row>',
      ].join(''),
    ),
    'xl/worksheets/sheet2.xml': SHEET('<row r="1"><c r="A1"><v>1</v></c></row>'),
    'xl/worksheets/sheet3.xml': SHEET('<row><c t="inlineStr"><is><t>无行号</t></is></c><c><v>7</v></c></row>'),
  })

  it('读取第一个可见工作表：共享字符串（含富文本与拼音）、内联字符串、数字、布尔、空行补空、缺失的格子补空', () => {
    const result = readXlsx(standard)
    expect(result.sheets).toEqual(['装箱单', '第二页'])
    expect(result.sheet).toBe('装箱单')
    expect(result.table).toEqual([['箱号', '货号', '', '内联'], [], ['12', '蓝牙 耳机', '0.1', 'A & B', 'TRUE'], ['公式结果', '', '']])
  })

  it('指定工作表（含绝对路径的关系、没有行号与列号的行）；隐藏的工作表不可选；找不到时给出可选名单', () => {
    expect(readXlsx(standard, { sheet: '第二页' }).table).toEqual([['无行号', '7']])
    expect(() => readXlsx(standard, { sheet: '隐藏页' })).toThrow('可选：装箱单、第二页')
    expect(() => readXlsx(standard, { sheet: '不存在' })).toThrow(XlsxError)
  })

  it('不是 xlsx、坏文件、缺工作簿、没有可读工作表都给明确的说法', () => {
    expect(() => readXlsx(strToU8('a,b\n1,2'))).toThrow('不是有效的 Excel')
    expect(() => readXlsx(new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5, 6]))).toThrow('已损坏')
    expect(() => readXlsx(build({ 'other.txt': 'x' }))).toThrow('找不到工作簿')
    expect(() => readXlsx(build({ 'xl/workbook.xml': WORKBOOK([{ name: 'S', id: 'rId9' }]), 'xl/_rels/workbook.xml.rels': RELS([]) }))).toThrow('没有可读的工作表')
  })

  it('体积保护：解压后过大、行数过多、列数过多都拒绝（压缩包炸弹也不会被展开）', () => {
    const bomb = build({
      'xl/workbook.xml': WORKBOOK([{ name: 'S', id: 'rId1' }]),
      'xl/_rels/workbook.xml.rels': RELS([['rId1', 'worksheets/sheet1.xml']]),
      'xl/worksheets/sheet1.xml': SHEET(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(2_000_000)}</t></is></c></row>`),
    })
    expect(bomb.length).toBeLessThan(10_000)
    expect(() => readXlsx(bomb, { limits: { maxFileBytes: 1_000_000 } })).toThrow('解压后太大')
    const rows = build({
      'xl/workbook.xml': WORKBOOK([{ name: 'S', id: 'rId1' }]),
      'xl/_rels/workbook.xml.rels': RELS([['rId1', 'worksheets/sheet1.xml']]),
      'xl/worksheets/sheet1.xml': SHEET('<row r="1"><c r="A1"><v>1</v></c></row><row r="50"><c r="A50"><v>1</v></c></row>'),
    })
    expect(() => readXlsx(rows, { limits: { maxRows: 10 } })).toThrow('超过 10 行')
    const cols = build({
      'xl/workbook.xml': WORKBOOK([{ name: 'S', id: 'rId1' }]),
      'xl/_rels/workbook.xml.rels': RELS([['rId1', 'worksheets/sheet1.xml']]),
      'xl/worksheets/sheet1.xml': SHEET('<row r="1"><c r="Z1"><v>1</v></c></row>'),
    })
    expect(() => readXlsx(cols, { limits: { maxCols: 5 } })).toThrow('超过 5 列')
  })
})
