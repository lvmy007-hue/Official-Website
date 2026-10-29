import { STORAGE_LIMIT_COLUMNS, type StorageType } from '@nova/api-contracts'

// 仓储限额文件（freeze/importers.md F-02，卖家后台“库容管理”导出）的解析：纯函数。
// 列：存储类型、限额、已用、采集日期（中英文表头都认；已用与采集日期可以留空，采集日期留空时用导入当天）。
// 一行有错整份拒绝，错误按“第 N 行”列出，最多返回前 10 条。

export interface LimitRow {
  storageType: StorageType
  limitQty: number
  usedQty: number | null
  captureDate: string
}

export const MAX_LIMIT_ROWS = 200
const MAX_ERRORS = 10

const TYPE_ALIASES: Record<StorageType, readonly string[]> = {
  STANDARD: ['standard', 'standardsize', 'standard-size', '标准', '标准尺寸', '标准件'],
  OVERSIZE: ['oversize', 'oversized', 'large', 'largebulky', 'large bulky', '超大件', '超大', '大件'],
  APPAREL: ['apparel', '服饰', '服装'],
  FOOTWEAR: ['footwear', 'shoes', '鞋靴', '鞋'],
  DANGEROUS: ['dangerous', 'dangerousgoods', 'dangerous goods', 'hazmat', '危险品'],
}

const norm = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')

/** 逐字符解析（支持引号与引号内的分隔符、换行）；分隔符按表头行自动判断（制表符、分号或逗号）。 */
export function parseDelimited(content: string): string[][] {
  const text = content.replace(/^\uFEFF/, '')
  const header = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = header.includes('\t') ? '\t' : header.includes(';') && !header.includes(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index++
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(cell)
      cell = ''
      rows.push(row)
      row = []
    } else cell += char
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter(items => items.some(item => item.trim() !== ''))
}

function typeOf(raw: string): StorageType | null {
  const key = norm(raw)
  for (const [type, aliases] of Object.entries(TYPE_ALIASES) as Array<[StorageType, readonly string[]]>) {
    if (aliases.some(alias => norm(alias) === key) || type.toLowerCase() === key) return type
  }
  return null
}

function numberOf(raw: string): number | null {
  const text = raw.trim().replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return Number(text)
}

function dateOf(raw: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw.trim())
  if (!match) return null
  const iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso
}

export function parseStorageLimits(content: string, today: string): { rows: LimitRow[]; errors: string[] } {
  const table = parseDelimited(content)
  const errors: string[] = []
  const fail = (message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(message)
  }
  if (table.length < 2) return { rows: [], errors: ['文件里没有数据行（第一行应是表头：存储类型、限额、已用、采集日期）'] }
  const header = table[0].map(norm)
  const indexOf = (aliases: readonly string[]) => header.findIndex(name => aliases.some(alias => norm(alias) === name))
  const columns = { type: indexOf(STORAGE_LIMIT_COLUMNS.type), limit: indexOf(STORAGE_LIMIT_COLUMNS.limit), used: indexOf(STORAGE_LIMIT_COLUMNS.used), date: indexOf(STORAGE_LIMIT_COLUMNS.date) }
  if (columns.type < 0 || columns.limit < 0) return { rows: [], errors: ['表头缺少必需的列：存储类型、限额（可选列：已用、采集日期）'] }
  if (table.length - 1 > MAX_LIMIT_ROWS) return { rows: [], errors: [`数据行过多（最多 ${MAX_LIMIT_ROWS} 行）`] }
  const rows: LimitRow[] = []
  const seen = new Set<string>()
  table.slice(1).forEach((cells, offset) => {
    const line = offset + 2
    const type = typeOf(cells[columns.type] ?? '')
    if (!type) return fail(`第 ${line} 行：不认识的存储类型“${(cells[columns.type] ?? '').trim()}”（可用：标准尺寸、超大件、服饰、鞋靴、危险品）`)
    const limitQty = numberOf(cells[columns.limit] ?? '')
    if (limitQty === null) return fail(`第 ${line} 行：限额“${(cells[columns.limit] ?? '').trim()}”不是有效的非负数字`)
    const usedRaw = columns.used >= 0 ? (cells[columns.used] ?? '').trim() : ''
    const usedQty = usedRaw === '' ? null : numberOf(usedRaw)
    if (usedRaw !== '' && usedQty === null) return fail(`第 ${line} 行：已用“${usedRaw}”不是有效的非负数字`)
    const dateRaw = columns.date >= 0 ? (cells[columns.date] ?? '').trim() : ''
    const captureDate = dateRaw === '' ? today : dateOf(dateRaw)
    if (!captureDate) return fail(`第 ${line} 行：采集日期“${dateRaw}”格式应为 YYYY-MM-DD`)
    if (captureDate > today) return fail(`第 ${line} 行：采集日期不能晚于今天`)
    const key = `${captureDate}|${type}`
    if (seen.has(key)) return fail(`第 ${line} 行：同一采集日期的“${type}”出现了多次`)
    seen.add(key)
    rows.push({ storageType: type, limitQty, usedQty, captureDate })
  })
  return { rows: errors.length ? [] : rows, errors }
}
