import { PACKING_MAX_ROWS, PACKING_SPEC_MAX, toInches, toPounds, type PackingColumns, type PackingField, type PackingUnits } from './packing-list.js'

// 装箱单的行读取（P6-11）：把表格里的每一行读成一条“货号 × 每箱件数 × 箱数 + 箱规”，并写明哪些行有问题。纯函数，不带 zod。
// 规则要点：
//   - 空行直接略过；没有货号也没有品名的行（合计、说明）和写着“合计、总计、Total”的行列进 skipped，不当商品；
//   - 箱号这一列有但当前行为空时，沿用上一行的箱号（Excel 合并单元格只在第一行有值），沿用的行标 boxNoInherited；
//   - 箱号写成“1-5”表示第 1 到第 5 箱规格相同，箱数取范围大小；
//   - 每箱件数没有时：有箱数就用“数量 ÷ 箱数”，没有箱数就把数量当作一个箱子里的件数；箱数没有时：用“数量 ÷ 每箱件数”（要整除），都没有就是 1 箱；
//   - 数量、每箱件数、箱数都有而对不上时只提醒（warnings），按每箱件数与箱数算；
//   - 尺寸与重量按单位换算成英寸与磅（保留两位小数）；没有也不在这里报错，等合并成箱子时再看有没有默认箱规。

export interface PackingSourceRow {
  /** 工作表里的行号（从 1 起，表头所在行也算）。 */
  line: number
  boxNo: string | null
  /** 箱号是沿用上一行的。 */
  boxNoInherited: boolean
  boxRange: { from: number; to: number } | null
  code: string | null
  name: string | null
  totalQty: number | null
  perBox: number | null
  boxCount: number | null
  weightLb: number | null
  lengthIn: number | null
  widthIn: number | null
  heightIn: number | null
  issues: string[]
  warnings: string[]
}
export interface PackingSkippedRow {
  line: number
  message: string
}
export interface PackingExtract {
  rows: PackingSourceRow[]
  skipped: PackingSkippedRow[]
  /** 整份文件的问题（行数超限等），有就不要继续。 */
  fatal: string | null
  notes: string[]
}

const TOTAL_ROW = /^(合计|总计|小计|共计|总共)|^(total|subtotal|grand\s*total|sum)([:：\s]|$)/i
const BOX_RANGE = /^[A-Za-z#]*\s*(\d+)\s*[-~～–—至到]\s*[A-Za-z#]*\s*(\d+)$/
const RANGE_MAX = 10_000
const COUNT_MAX = 10_000
const QTY_MAX = 1_000_000

/** 单元格读成数字：允许千分位逗号与紧跟的单位文字（“12.5kg”“60cm”“100pcs”“100件”）；读不出返回 bad。 */
export function cellNumber(raw: string): { value: number | null; bad: boolean } {
  const clean = raw.replace(/[,，\s]/g, '')
  if (!clean) return { value: null, bad: false }
  const match = /^(\d+(?:\.\d+)?)[A-Za-z\u4e00-\u9fa5"]{0,8}$/.exec(clean)
  return match ? { value: Number(match[1]), bad: false } : { value: null, bad: true }
}

/** “60*40*30”“60x40x30cm”拆成三个数字；拆不出三个返回 null。 */
export function parseDimensions(raw: string): [number, number, number] | null {
  const parts = raw.split(/\s*[x×*＊✕]\s*/i)
  if (parts.length !== 3) return null
  const numbers = parts.map(part => cellNumber(part).value)
  return numbers.every(value => value !== null && value > 0) ? (numbers as [number, number, number]) : null
}

const cellOf = (cells: readonly string[], index: number | null | undefined): string => (typeof index === 'number' ? (cells[index] ?? '').trim() : '')

export function extractPackingRows(table: readonly (readonly string[])[], options: { headerRow: number; columns: PackingColumns; units: PackingUnits }): PackingExtract {
  const { headerRow, columns, units } = options
  const rows: PackingSourceRow[] = []
  const skipped: PackingSkippedRow[] = []
  const body = table.slice(headerRow + 1)
  const filled = body.filter(cells => cells.some(cell => cell.trim() !== '')).length
  if (filled > PACKING_MAX_ROWS) return { rows, skipped, fatal: `一次最多处理 ${PACKING_MAX_ROWS} 行，现在有 ${filled} 行，请拆成几份`, notes: [] }
  const has = (field: PackingField) => typeof columns[field] === 'number'
  let lastBoxNo: string | null = null

  for (let offset = 0; offset < body.length; offset += 1) {
    const cells = body[offset]!
    if (!cells.some(cell => cell.trim() !== '')) continue
    const line = headerRow + 2 + offset
    const get = (field: PackingField) => cellOf(cells, columns[field])
    const code = get('code') || null
    const name = get('name') || null
    const firstFilled = cells.find(cell => cell.trim() !== '')?.trim() ?? ''
    if ([get('boxNo'), code ?? '', name ?? '', firstFilled].some(text => TOTAL_ROW.test(text))) {
      skipped.push({ line, message: '合计行，已忽略' })
      continue
    }
    if (!code && !name) {
      skipped.push({ line, message: '没有货号也没有品名（可能是说明行），已忽略' })
      continue
    }
    const issues: string[] = []
    const warnings: string[] = []

    let boxNo: string | null = get('boxNo') || null
    let inherited = false
    if (boxNo) lastBoxNo = boxNo
    else if (has('boxNo') && lastBoxNo) {
      boxNo = lastBoxNo
      inherited = true
    }
    let boxRange: PackingSourceRow['boxRange'] = null
    const rangeMatch = boxNo ? BOX_RANGE.exec(boxNo) : null
    if (rangeMatch) {
      const from = Number(rangeMatch[1])
      const to = Number(rangeMatch[2])
      if (to < from) issues.push(`箱号 ${boxNo} 的范围起止颠倒`)
      else if (to - from + 1 > RANGE_MAX) issues.push(`箱号 ${boxNo} 的范围太大（最多 ${RANGE_MAX} 箱）`)
      else boxRange = { from, to }
    }

    const whole = (field: PackingField, max: number): number | null => {
      const parsed = cellNumber(get(field))
      if (parsed.bad) issues.push(`${field === 'perBox' ? '每箱件数' : field === 'boxCount' ? '箱数' : '数量'}“${get(field)}”不是数字`)
      else if (parsed.value !== null && (!Number.isInteger(parsed.value) || parsed.value < 1 || parsed.value > max))
        issues.push(`${field === 'perBox' ? '每箱件数' : field === 'boxCount' ? '箱数' : '数量'}要是 1 到 ${max} 的整数，现在是 ${parsed.value}`)
      else return parsed.value
      return null
    }
    const totalQty = whole('totalQty', QTY_MAX)
    let perBox = whole('perBox', QTY_MAX)
    let boxCount = whole('boxCount', COUNT_MAX)

    if (boxRange) {
      const size = boxRange.to - boxRange.from + 1
      if (boxCount !== null && boxCount !== size) warnings.push(`箱数 ${boxCount} 与箱号 ${boxNo} 的范围（${size} 箱）不一致，按箱号范围算`)
      boxCount = size
    }
    const rowIssuesBefore = issues.length
    if (perBox === null && rowIssuesBefore === 0) {
      if (totalQty === null) issues.push('没有每箱件数，也没有数量')
      else if (boxCount !== null) {
        if (totalQty % boxCount === 0) perBox = totalQty / boxCount
        else issues.push(`数量 ${totalQty} 不是箱数 ${boxCount} 的整数倍，算不出每箱件数`)
      } else {
        perBox = totalQty
        boxCount = 1
      }
    }
    if (perBox !== null && boxCount === null && issues.length === rowIssuesBefore) {
      if (totalQty === null) boxCount = 1
      else if (totalQty % perBox === 0) boxCount = totalQty / perBox
      else issues.push(`数量 ${totalQty} 不是每箱件数 ${perBox} 的整数倍，算不出箱数`)
    }
    if (perBox !== null && boxCount !== null && totalQty !== null && perBox * boxCount !== totalQty)
      warnings.push(`数量 ${totalQty} 与每箱件数 ${perBox} × 箱数 ${boxCount} = ${perBox * boxCount} 对不上，按每箱件数与箱数算`)

    const spec = (raw: string, label: string, convert: (value: number) => number): number | null => {
      if (!raw) return null
      const parsed = cellNumber(raw)
      if (parsed.bad || parsed.value === null || parsed.value <= 0) {
        issues.push(`${label}“${raw}”要是大于 0 的数字`)
        return null
      }
      const value = convert(parsed.value)
      if (value <= 0 || value > PACKING_SPEC_MAX) {
        issues.push(`${label}“${raw}”换算后超出范围（0 到 ${PACKING_SPEC_MAX}）`)
        return null
      }
      return value
    }
    const lengthOf = (value: number) => toInches(value, units.length)
    let lengthIn: number | null = null
    let widthIn: number | null = null
    let heightIn: number | null = null
    const combined = get('dimensions')
    if (combined) {
      const parts = parseDimensions(combined)
      if (!parts) issues.push(`尺寸“${combined}”认不出，应写成 长*宽*高，例如 60*40*30`)
      else {
        lengthIn = spec(String(parts[0]), '尺寸', lengthOf)
        widthIn = spec(String(parts[1]), '尺寸', lengthOf)
        heightIn = spec(String(parts[2]), '尺寸', lengthOf)
      }
    } else {
      lengthIn = spec(get('length'), '长', lengthOf)
      widthIn = spec(get('width'), '宽', lengthOf)
      heightIn = spec(get('height'), '高', lengthOf)
    }
    const weightLb = spec(get('weight'), '重量', value => toPounds(value, units.weight))

    rows.push({ line, boxNo, boxNoInherited: inherited, boxRange, code, name, totalQty, perBox, boxCount, weightLb, lengthIn, widthIn, heightIn, issues, warnings })
  }

  const notes: string[] = []
  if (rows.length > 0 && !has('boxNo') && !has('perBox') && !has('boxCount')) notes.push('装箱单里没有箱号、每箱件数和箱数，每一行按一个箱子处理')
  return { rows, skipped, fatal: null, notes }
}
