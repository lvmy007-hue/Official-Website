import { unzipSync } from 'fflate'

// 最小的 xlsx 读取器（P6-11）：只读一张工作表里的单元格文字，用来读供应商的装箱单。不依赖大型表格库，不执行公式、不展开合并单元格（合并单元格只有左上角有值，
// 装箱单解析会把空的箱号沿用上一行）。日期单元格读出来是序列号数字（装箱单不会用到日期列）。
// 安全：先限制解压后的大小再解压（防压缩炸弹）、只解需要的几个文件、行数列数有上限、不解析 DOCTYPE 与外部实体（只用正则取标签，不会读外部资源）。

export class XlsxError extends Error {}

export interface XlsxTable {
  /** 全部可见工作表的名字（按顺序）。 */
  sheets: string[]
  /** 读取的工作表。 */
  sheet: string
  /** 二维表：下标加一就是工作表里的行号；没有内容的行是空数组，行内没有内容的格是空字符串。 */
  table: string[][]
}

export interface XlsxLimits {
  /** 解压后单个文件的大小上限（字节）。 */
  maxFileBytes: number
  /** 需要解压的几个文件的总大小上限（字节）。 */
  maxTotalBytes: number
  maxRows: number
  maxCols: number
}
export const DEFAULT_XLSX_LIMITS: XlsxLimits = { maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024, maxRows: 5000, maxCols: 200 }

const decoder = new TextDecoder('utf-8')

function decodeEntities(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_all, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => safeChar(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
const safeChar = (code: number) => (Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '')

const attrOf = (tag: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return match ? decodeEntities(match[1] ?? match[2] ?? '') : null
}

/** 一段 XML 里所有 <t> 的文字（去掉拼音注释 rPh），连起来。 */
function textOf(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let result = ''
  for (const match of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) result += decodeEntities(match[1] ?? '')
  return result
}

/** “B3”拆成列序号（从 0 起）与行号（从 1 起）。 */
function cellRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Za-z]{1,3})(\d+)$/.exec(ref)
  if (!match) return null
  let col = 0
  for (const letter of match[1]!.toUpperCase()) col = col * 26 + (letter.charCodeAt(0) - 64)
  return { col: col - 1, row: Number(match[2]) }
}

function numberText(raw: string): string {
  const value = Number(raw)
  if (!Number.isFinite(value) || raw.trim() === '') return raw.trim()
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  return String(Number(value.toPrecision(15)))
}

export function readXlsx(bytes: Uint8Array, options: { sheet?: string | null; limits?: Partial<XlsxLimits> } = {}): XlsxTable {
  const limits = { ...DEFAULT_XLSX_LIMITS, ...options.limits }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new XlsxError('这不是有效的 Excel（.xlsx）文件；老版 .xls 请另存为 .xlsx 或 CSV')
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: file => {
        if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)) return false
        if (file.originalSize > limits.maxFileBytes) throw new XlsxError('文件解压后太大，请拆小后再试')
        total += file.originalSize
        if (total > limits.maxTotalBytes) throw new XlsxError('文件解压后太大，请拆小后再试')
        return true
      },
    })
  } catch (error) {
    if (error instanceof XlsxError) throw error
    throw new XlsxError('Excel 文件已损坏或不是 .xlsx 格式，无法读取')
  }
  const read = (name: string) => (files[name] ? decoder.decode(files[name]) : null)
  const workbook = read('xl/workbook.xml')
  if (!workbook) throw new XlsxError('Excel 文件里找不到工作簿（xl/workbook.xml），可能不是 .xlsx')

  const rels = new Map<string, string>()
  for (const tag of (read('xl/_rels/workbook.xml.rels') ?? '').match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attrOf(tag, 'Id')
    const target = attrOf(tag, 'Target')
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const sheets = (workbook.match(/<sheet\b[^>]*>/g) ?? []).flatMap(tag => {
    const name = attrOf(tag, 'name')
    const rid = attrOf(tag, 'r:id') ?? attrOf(tag, 'id')
    const state = attrOf(tag, 'state')
    const path = rid ? rels.get(rid) : undefined
    return name && path && state !== 'hidden' && state !== 'veryHidden' ? [{ name, path }] : []
  })
  if (sheets.length === 0) throw new XlsxError('Excel 文件里没有可读的工作表')
  const chosen = options.sheet ? sheets.find(sheet => sheet.name === options.sheet) : sheets[0]
  if (!chosen) throw new XlsxError(`找不到工作表“${options.sheet}”（可选：${sheets.map(sheet => sheet.name).join('、')}）`)
  const sheetXml = read(chosen.path)
  if (sheetXml === null) throw new XlsxError(`工作表“${chosen.name}”的内容读取不到`)

  const shared: string[] = []
  for (const match of (read('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) shared.push(textOf(match[1] ?? ''))

  const rows: string[][] = []
  let nextRow = 0
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const given = Number(attrOf(rowMatch[1] ?? '', 'r'))
    const rowNumber = Number.isInteger(given) && given > 0 ? given : nextRow + 1
    nextRow = rowNumber
    if (rowNumber > limits.maxRows) throw new XlsxError(`工作表超过 ${limits.maxRows} 行，请拆成几份`)
    const cells: string[] = []
    let nextCol = 0
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? ''
      const ref = cellRef(attrOf(attrs, 'r') ?? '')
      const col = ref ? ref.col : nextCol
      nextCol = col + 1
      if (col >= limits.maxCols) throw new XlsxError(`工作表超过 ${limits.maxCols} 列，请删掉多余的列`)
      const inner = cellMatch[2] ?? ''
      const type = attrOf(attrs, 't')
      const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''
      let text: string
      if (type === 's') text = shared[Number(value)] ?? ''
      else if (type === 'inlineStr') text = textOf(inner)
      else if (type === 'str') text = decodeEntities(value)
      else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'e') text = ''
      else if (type === 'd') text = decodeEntities(value)
      else text = numberText(decodeEntities(value))
      while (cells.length < col) cells.push('')
      cells[col] = text.trim()
    }
    while (rows.length < rowNumber - 1) rows.push([])
    rows[rowNumber - 1] = cells
  }
  return { sheets: sheets.map(sheet => sheet.name), sheet: chosen.name, table: rows }
}
