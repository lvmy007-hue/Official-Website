import { COST_COMPONENTS, COST_IMPORT_COLUMNS, COST_IMPORT_MAX_ROWS, COST_NOTE_MAX, COST_SKU_MAX, type CostComponent } from '@nova/api-contracts'
import { parseDelimited } from '../inventory'

// 商品成本文件（freeze/importers.md F-04）的解析：纯函数。每一行变成一个“导入草稿”，确认后才参与利润计价。
// 列：SKU、生效日期、币种必填；采购单价、头程分摊、关税、其他成本至少填一项；备注可选（中英文表头都认）。
// 一行有错整份拒绝，错误按“第 N 行”列出，最多返回前 10 条。

export interface CostImportRow {
  /** 文件里的行号（表头是第 1 行）。 */
  line: number
  sku: string
  effectiveFrom: string
  currency: string
  amounts: Record<CostComponent, number | null>
  note: string | null
}

const MAX_ERRORS = 10
const norm = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')

function amountOf(raw: string): number | null | 'bad' {
  const text = raw.trim().replace(/,/g, '')
  if (text === '') return null
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return 'bad'
  const value = Number(text)
  return value > 1_000_000_000 ? 'bad' : value
}

function dateOf(raw: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw.trim())
  if (!match) return null
  const iso = `${match[1]}-${(match[2] as string).padStart(2, '0')}-${(match[3] as string).padStart(2, '0')}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso || iso < '2000-01-01' ? null : iso
}

export function parseCostFile(content: string, maxDay: string): { rows: CostImportRow[]; errors: string[] } {
  const table = parseDelimited(content)
  const errors: string[] = []
  const fail = (message: string) => {
    if (errors.length < MAX_ERRORS) errors.push(message)
  }
  if (table.length < 2) return { rows: [], errors: ['文件里没有数据行（第一行应是表头：SKU、生效日期、币种、采购单价、头程分摊、关税、其他成本、备注）'] }
  const header = (table[0] as string[]).map(norm)
  const indexOf = (aliases: readonly string[]) => header.findIndex(name => aliases.some(alias => norm(alias) === name))
  const columns = {
    sku: indexOf(COST_IMPORT_COLUMNS.sku),
    effectiveFrom: indexOf(COST_IMPORT_COLUMNS.effectiveFrom),
    currency: indexOf(COST_IMPORT_COLUMNS.currency),
    note: indexOf(COST_IMPORT_COLUMNS.note),
    amounts: COST_COMPONENTS.map(component => indexOf(COST_IMPORT_COLUMNS[component])),
  }
  if (columns.sku < 0 || columns.effectiveFrom < 0 || columns.currency < 0)
    return { rows: [], errors: ['表头缺少必需的列：SKU、生效日期、币种（另有采购单价、头程分摊、关税、其他成本，至少要有一列）'] }
  if (columns.amounts.every(index => index < 0)) return { rows: [], errors: ['表头里没有任何成本列：采购单价、头程分摊、关税、其他成本，至少要有一列'] }
  if (table.length - 1 > COST_IMPORT_MAX_ROWS) return { rows: [], errors: [`数据行过多（最多 ${COST_IMPORT_MAX_ROWS} 行）`] }
  const rows: CostImportRow[] = []
  const seen = new Set<string>()
  table.slice(1).forEach((cells, offset) => {
    const line = offset + 2
    const cell = (index: number) => (index < 0 ? '' : (cells[index] ?? '').trim())
    const sku = cell(columns.sku)
    if (!sku || sku.length > COST_SKU_MAX) return fail(`第 ${line} 行：SKU 不能为空，且不超过 ${COST_SKU_MAX} 个字符`)
    const effectiveFrom = dateOf(cell(columns.effectiveFrom))
    if (!effectiveFrom) return fail(`第 ${line} 行：生效日期“${cell(columns.effectiveFrom)}”格式应为 YYYY-MM-DD`)
    if (effectiveFrom > maxDay) return fail(`第 ${line} 行：生效日期不能晚于 ${maxDay}（今天起一年内）`)
    const currency = cell(columns.currency).toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) return fail(`第 ${line} 行：币种“${cell(columns.currency)}”应为 3 位字母代码，例如 USD、CNY`)
    const amounts = { product: null, firstMile: null, duty: null, other: null } as CostImportRow['amounts']
    for (const [position, component] of COST_COMPONENTS.entries()) {
      const parsed = amountOf(cell(columns.amounts[position] as number))
      if (parsed === 'bad') return fail(`第 ${line} 行：${cell(columns.amounts[position] as number)} 不是有效的成本（非负数字，最多 6 位小数）`)
      amounts[component] = parsed
    }
    if (COST_COMPONENTS.every(component => amounts[component] === null)) return fail(`第 ${line} 行：四项成本至少填一项`)
    const note = cell(columns.note)
    if (note.length > COST_NOTE_MAX) return fail(`第 ${line} 行：备注最多 ${COST_NOTE_MAX} 字`)
    const key = `${sku}|${effectiveFrom}`
    if (seen.has(key)) return fail(`第 ${line} 行：SKU“${sku}”在 ${effectiveFrom} 出现了多次`)
    seen.add(key)
    rows.push({ line, sku, effectiveFrom, currency, amounts, note: note || null })
  })
  return { rows: errors.length ? [] : rows, errors }
}
