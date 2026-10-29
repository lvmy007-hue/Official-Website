import { csvDelimiterOf, splitCsvLine } from './csv-table.js'
import { INBOUND_MAX_BOXES, type InboundBoxInput } from './inbound.js'
import type { InboundPlanRow } from './inbound-views.js'

// 装箱表格文件模板导入（P6-10，16 章 5.1）：两种模板（混装、原厂包装）的列定义、模板内容与文件解析。纯函数，页面预检与服务端校验共用，不带 zod。
// 文件是 CSV（UTF-8，逗号、制表符或分号分隔，Excel 另存为 CSV 即可）；表头认中英文别名；关键列缺失整份拒绝；一行有错整份拒绝；
// 与前面某一行完全相同的行跳过并告知；最多 2000 行。导入整体替换现有箱子，保存在我们这里，提交给亚马逊是单独的动作。

export const BOX_TEMPLATE_KINDS = ['MIXED', 'ORIGINAL'] as const
export type BoxTemplateKind = (typeof BOX_TEMPLATE_KINDS)[number]
export const isBoxTemplateKind = (value: string): value is BoxTemplateKind => (BOX_TEMPLATE_KINDS as readonly string[]).includes(value)
export const BOX_TEMPLATE_LABEL: Record<BoxTemplateKind, string> = { MIXED: '混装模板（一箱装多种商品）', ORIGINAL: '原厂包装模板（一箱只装一种商品）' }
export const BOX_TEMPLATE_HINT: Record<BoxTemplateKind, string> = {
  MIXED: '每行是“某个箱子里的一种商品”，同一箱号的多行合并成一个箱子；尺寸与重量取第一行，其余行必须一致或留空；相同箱数可省略（默认 1）。',
  ORIGINAL: '每行是一种原厂装箱规格：每箱件数 × 箱数；不用写箱号，导入后自动编号；同一个 SKU 有几种规格就写几行。',
}
export const BOX_IMPORT_MAX_ROWS = 2000
export const BOX_IMPORT_MAX_CHARS = 400_000
const MAX_ERRORS = 50
const SPEC_MAX = 100_000

type ColumnKey = 'boxId' | 'sku' | 'perBox' | 'count' | 'weightLb' | 'lengthIn' | 'widthIn' | 'heightIn'
interface ColumnSpec {
  key: ColumnKey
  /** 模板表头与错误提示里用的列名。 */
  label: string
  required: boolean
  aliases: readonly string[]
}

const WEIGHT: ColumnSpec = { key: 'weightLb', label: '重量(磅)', required: true, aliases: ['重量', '重量磅', '重量lb', '单箱重量', 'weight', 'weightlb', 'weight(lb)', 'weightlbs'] }
const LENGTH: ColumnSpec = { key: 'lengthIn', label: '长(英寸)', required: true, aliases: ['长', '长英寸', '长度', 'length', 'lengthin', 'l'] }
const WIDTH: ColumnSpec = { key: 'widthIn', label: '宽(英寸)', required: true, aliases: ['宽', '宽英寸', '宽度', 'width', 'widthin', 'w'] }
const HEIGHT: ColumnSpec = { key: 'heightIn', label: '高(英寸)', required: true, aliases: ['高', '高英寸', '高度', 'height', 'heightin', 'h'] }
const SKU: ColumnSpec = { key: 'sku', label: 'SKU', required: true, aliases: ['sku', '卖家sku', 'sellersku', '商品sku', '货号'] }

export const BOX_COLUMNS: Record<BoxTemplateKind, readonly ColumnSpec[]> = {
  MIXED: [
    { key: 'boxId', label: '箱号', required: true, aliases: ['箱号', 'boxid', 'box', 'boxno', 'boxnumber', 'cartonid', 'carton'] },
    SKU,
    { key: 'perBox', label: '每箱数量', required: true, aliases: ['每箱数量', '每箱件数', '数量', '件数', 'quantity', 'qty', 'unitsperbox', 'unitspercarton'] },
    WEIGHT,
    LENGTH,
    WIDTH,
    HEIGHT,
    { key: 'count', label: '相同箱数', required: false, aliases: ['相同箱数', '箱数', 'boxes', 'boxcount', 'numberofboxes', 'cartons'] },
  ],
  ORIGINAL: [
    SKU,
    { key: 'perBox', label: '每箱件数', required: true, aliases: ['每箱件数', '每箱数量', '装箱数', '数量', '件数', 'unitspercase', 'unitsperbox', 'quantity', 'qty'] },
    { key: 'count', label: '箱数', required: true, aliases: ['箱数', '相同箱数', '整箱数', 'boxes', 'cases', 'boxcount', 'numberofcases'] },
    WEIGHT,
    LENGTH,
    WIDTH,
    HEIGHT,
  ],
}

const EXAMPLE: Record<BoxTemplateKind, readonly string[][]> = {
  MIXED: [
    ['BOX-001', 'SKU-A', '10', '22', '16', '12', '10', '2'],
    ['BOX-001', 'SKU-B', '5', '22', '16', '12', '10', '2'],
    ['BOX-002', 'SKU-A', '20', '18', '14', '12', '10', '1'],
  ],
  ORIGINAL: [
    ['SKU-A', '24', '10', '28', '18', '14', '12'],
    ['SKU-B', '12', '5', '16', '16', '12', '10'],
  ],
}

export const boxTemplateFileName = (kind: BoxTemplateKind): string => (kind === 'MIXED' ? '装箱导入模板-混装.csv' : '装箱导入模板-原厂包装.csv')

/** 模板内容：UTF-8 带 BOM（Excel 才不会把中文列名读成乱码），CRLF 换行，表头后跟示例行（导入前删掉示例）。 */
export function boxTemplateCsv(kind: BoxTemplateKind): string {
  const header = BOX_COLUMNS[kind].map(column => column.label).join(',')
  return `\uFEFF${[header, ...EXAMPLE[kind].map(row => row.join(','))].join('\r\n')}\r\n`
}

export interface BoxTemplateResponse {
  kind: BoxTemplateKind
  label: string
  fileName: string
  content: string
  columns: Array<{ label: string; required: boolean }>
  hint: string
  maxRows: number
}
export const boxTemplateOf = (kind: BoxTemplateKind): BoxTemplateResponse => ({
  kind,
  label: BOX_TEMPLATE_LABEL[kind],
  fileName: boxTemplateFileName(kind),
  content: boxTemplateCsv(kind),
  columns: BOX_COLUMNS[kind].map(column => ({ label: column.label, required: column.required })),
  hint: BOX_TEMPLATE_HINT[kind],
  maxRows: BOX_IMPORT_MAX_ROWS,
})

export interface BoxFileLineError {
  /** 文件里的行号（表头是第 1 行）；0 表示整份文件的问题。 */
  line: number
  message: string
}
export interface BoxFileParse {
  boxes: InboundBoxInput[]
  errors: BoxFileLineError[]
  /** 与前面某一行完全相同而被跳过的行。 */
  skipped: BoxFileLineError[]
  /** 读到的数据行数（不含表头与空行）。 */
  rows: number
}
export interface InboundBoxImportResponse {
  plan: InboundPlanRow
  state: 'SAVED'
  imported: { boxTypes: number; boxes: number; units: number }
  skipped: BoxFileLineError[]
}

const normalize = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[\s_()（）-]/g, '')

const numberOf = (text: string): number | null => {
  const clean = text.replace(/,/g, '').trim()
  return /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : null
}

/**
 * 解析装箱文件。`planSkus` 给了就同时核对“SKU 必须在计划里”（页面预检与服务端都传）；不给只做格式校验。
 * 返回的 boxes 只在 errors 为空时才有内容，调用方不要在有错误时使用。
 */
export function parseBoxFile(content: string, kind: BoxTemplateKind, planSkus?: readonly string[]): BoxFileParse {
  const errors: BoxFileLineError[] = []
  const skipped: BoxFileLineError[] = []
  const fail = (line: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ line, message })
  }
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter(entry => entry.raw.trim() !== '')
  const done = (boxes: InboundBoxInput[]): BoxFileParse => ({ boxes: errors.length > 0 ? [] : boxes, errors, skipped, rows: Math.max(0, lines.length - 1) })
  if (lines.length === 0) {
    fail(0, '文件是空的')
    return done([])
  }
  const delimiter = csvDelimiterOf(lines[0].raw)
  const headers = splitCsvLine(lines[0].raw, delimiter).map(normalize)
  const columns = BOX_COLUMNS[kind]
  const index = new Map<ColumnKey, number>()
  for (const column of columns) {
    const found = headers.findIndex(header => column.aliases.some(alias => normalize(alias) === header))
    if (found >= 0) index.set(column.key, found)
    else if (column.required) fail(lines[0].line, `缺少“${column.label}”列`)
  }
  if (errors.length > 0) return done([])
  if (lines.length === 1) {
    fail(0, '文件里没有数据行（第一行应是表头）')
    return done([])
  }
  if (lines.length - 1 > BOX_IMPORT_MAX_ROWS) {
    fail(0, `一次最多导入 ${BOX_IMPORT_MAX_ROWS} 行，现在有 ${lines.length - 1} 行`)
    return done([])
  }

  const known = planSkus ? new Set(planSkus) : null
  const seenRows = new Map<string, number>()
  const mixed = new Map<string, InboundBoxInput & { line: number }>()
  const original: InboundBoxInput[] = []
  for (const entry of lines.slice(1)) {
    const cells = splitCsvLine(entry.raw, delimiter)
    const cell = (key: ColumnKey) => (index.has(key) ? (cells[index.get(key)!] ?? '') : '')
    const before = errors.length
    const bad = (column: ColumnKey, message: string) => fail(entry.line, `${columns.find(item => item.key === column)!.label}：${message}`)
    const sku = cell('sku')
    if (!sku) bad('sku', '必填')
    else if (sku.length > 120) bad('sku', '太长（最多 120 个字）')
    else if (known && !known.has(sku)) bad('sku', `${sku} 不在这个计划里`)
    const boxId = kind === 'MIXED' ? cell('boxId') : ''
    if (kind === 'MIXED' && !boxId) bad('boxId', '必填')
    else if (boxId.length > 40) bad('boxId', '太长（最多 40 个字）')
    const wholeNumber = (column: ColumnKey, fallback: number | null, max: number): number => {
      const text = cell(column)
      if (text === '' && fallback !== null) return fallback
      const value = numberOf(text)
      if (value === null || !Number.isInteger(value) || value < 1 || value > max) bad(column, `要是 1 到 ${max} 的整数`)
      return value ?? 0
    }
    const perBox = wholeNumber('perBox', null, 1_000_000)
    const count = wholeNumber('count', kind === 'MIXED' ? 1 : null, 10_000)
    const spec = (column: ColumnKey): number => {
      const value = numberOf(cell(column))
      if (value === null || value <= 0 || value > SPEC_MAX) bad(column, `要是大于 0 且不超过 ${SPEC_MAX} 的数字`)
      return value ?? 0
    }
    const [weightLb, lengthIn, widthIn, heightIn] = [spec('weightLb'), spec('lengthIn'), spec('widthIn'), spec('heightIn')]
    if (errors.length > before) continue
    // 完全相同的行（所有列的值一样）只留第一行：同一份文件里重复粘贴的行不应翻倍装箱
    const signature = JSON.stringify([boxId, sku, perBox, count, weightLb, lengthIn, widthIn, heightIn])
    const first = seenRows.get(signature)
    if (first !== undefined) {
      skipped.push({ line: entry.line, message: `与第 ${first} 行完全相同，已跳过` })
      continue
    }
    seenRows.set(signature, entry.line)
    if (kind === 'ORIGINAL') {
      original.push({ quantity: count, weightLb, lengthIn, widthIn, heightIn, items: [{ sku, quantity: perBox }] })
      continue
    }
    const existing = mixed.get(boxId)
    if (!existing) {
      mixed.set(boxId, { boxId, quantity: count, weightLb, lengthIn, widthIn, heightIn, items: [{ sku, quantity: perBox }], line: entry.line })
    } else if (existing.weightLb !== weightLb || existing.lengthIn !== lengthIn || existing.widthIn !== widthIn || existing.heightIn !== heightIn || existing.quantity !== count) {
      fail(entry.line, `箱 ${boxId} 的重量、尺寸或相同箱数与第 ${existing.line} 行不一致`)
    } else if (existing.items.some(item => item.sku === sku)) fail(entry.line, `箱 ${boxId} 里 ${sku} 重复（数量不同的同一商品请合并成一行）`)
    else existing.items.push({ sku, quantity: perBox })
  }
  const boxes: InboundBoxInput[] =
    kind === 'MIXED'
      ? [...mixed.values()].map(box => ({ boxId: box.boxId, quantity: box.quantity, weightLb: box.weightLb, lengthIn: box.lengthIn, widthIn: box.widthIn, heightIn: box.heightIn, items: box.items }))
      : original
  if (errors.length === 0 && boxes.length > INBOUND_MAX_BOXES) fail(0, `箱型最多 ${INBOUND_MAX_BOXES} 个，现在有 ${boxes.length} 个：请把相同的箱子合并，用“相同箱数”表示`)
  if (errors.length === 0) {
    const tooMany = boxes.find(box => box.items.length > 100)
    if (tooMany) fail(0, `一个箱子里的商品最多 100 种（箱 ${tooMany.boxId ?? ''}）`)
  }
  return done(boxes)
}
