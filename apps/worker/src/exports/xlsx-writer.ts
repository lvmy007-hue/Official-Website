import type { Writable } from 'node:stream'
import type { Cell } from './csv'
import { ZipStream } from './zip-stream'

// 流式 XLSX（单个工作表）：不引入第三方库，行数据边读边压缩边写出。字符串一律按“文本”存放（inlineStr），
// 以 = + - @ 开头的内容不会被当成公式执行；数字与布尔保持原类型；日期按 ISO 文本输出，与 CSV 一致。

export class XlsxRowLimitError extends Error {
  constructor(readonly limit: number) {
    super(`行数超过上限 ${limit}`)
    this.name = 'XlsxRowLimitError'
  }
}

/** Excel 单元格最多 32767 个字符 */
const MAX_CELL_CHARS = 32_767
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g
const escapeXml = (text: string) => text.replace(ILLEGAL_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 0 → A，25 → Z，26 → AA */
export function columnName(index: number): string {
  let name = ''
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name
  return name
}

function cellXml(value: Cell, ref: string, style?: number): string {
  if (value === null || value === undefined) return ''
  const s = style ? ` s="${style}"` : ''
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"${s}><v>${value ? 1 : 0}</v></c>`
  const text = (value instanceof Date ? value.toISOString() : String(value)).slice(0, MAX_CELL_CHARS)
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
}

const rowXml = (cells: readonly Cell[], rowNumber: number, style?: number) =>
  `<row r="${rowNumber}">${cells.map((cell, index) => cellXml(cell, `${columnName(index)}${rowNumber}`, style)).join('')}</row>`

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const CONTENT_TYPES = [
  XML_HEAD,
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
].join('')
const ROOT_RELS = [
  XML_HEAD,
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
  '</Relationships>',
].join('')
const WORKBOOK_RELS = [
  XML_HEAD,
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
].join('')
// 样式 0：常规；样式 1：加粗（表头）
const STYLES = [
  XML_HEAD,
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font>',
  '<b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill>',
  '<patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>',
  '</styleSheet>',
].join('')

const sheetNameOf = (name: string) =>
  name
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet1'

export interface XlsxOptions {
  sheetName: string
  header: readonly string[]
  rows: AsyncIterable<readonly Cell[]>
  /** 数据行数上限（不含表头）；超过抛 XlsxRowLimitError，调用方丢弃半成品 */
  maxRows: number
  now?: Date
}

/** 把行流写成 XLSX（冻结首行、表头加粗）；返回数据行数。不负责结束 target。 */
export async function writeXlsx(target: Writable, options: XlsxOptions): Promise<number> {
  const zip = new ZipStream(target, options.now)
  let written = 0
  await zip.addFile('[Content_Types].xml', async write => write(CONTENT_TYPES))
  await zip.addFile('_rels/.rels', async write => write(ROOT_RELS))
  await zip.addFile('xl/workbook.xml', async write =>
    write(
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` +
        ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${escapeXml(sheetNameOf(options.sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
  )
  await zip.addFile('xl/_rels/workbook.xml.rels', async write => write(WORKBOOK_RELS))
  await zip.addFile('xl/styles.xml', async write => write(STYLES))
  await zip.addFile('xl/worksheets/sheet1.xml', async write => {
    await write(
      `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>`,
    )
    await write(rowXml(options.header, 1, 1))
    let buffer = ''
    for await (const row of options.rows) {
      if (written >= options.maxRows) throw new XlsxRowLimitError(options.maxRows)
      written += 1
      buffer += rowXml(row, written + 1)
      if (buffer.length > 64 * 1024) {
        await write(buffer)
        buffer = ''
      }
    }
    await write(`${buffer}</sheetData></worksheet>`)
  })
  await zip.finish()
  return written
}
