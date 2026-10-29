import { csvDelimiterOf, splitCsvLine } from './csv-table.js'
import {
  ESTIMATED_FEE_LIMITS,
  ESTIMATED_MODE_LABEL,
  ESTIMATED_PERIOD_LABEL,
  ESTIMATED_SCOPE_LABEL,
  ESTIMATED_STATUS_LABEL,
  isDayText,
  type EstimatedMode,
  type EstimatedPeriod,
  type EstimatedScopeType,
  type EstimatedStatus,
} from './estimated-fees.js'

// 预估与自定义费用的导入文件（P6-20）：CSV，一行一条规则；整份校验，任何一行有错整份不导入。纯函数，不带 zod。
// 费用项与店铺用名称对应（费用项写利润项目字典里的项目名称或“一级 / 二级”路径，店铺写店铺名称或编号），这一步需要数据库，由接口层完成。

export const ESTIMATED_FEE_FILE_HEADER = ['费用项', '范围', '范围对象', '方式', '金额或比例', '周期', '起始日', '截止日', '状态', '备注'] as const
export const ESTIMATED_FEE_FILE_HINT =
  '每行一条规则：费用项写利润项目字典里的项目名称（同名时写“上级 / 项目”）；范围写 店铺、SKU 或 品类；范围对象写店铺名称、卖家 SKU 或品类；方式写 固定金额 或 销售额比例；金额按美元，比例单位是 %；周期写 按日 或 按月；日期格式 YYYY-MM-DD，截止日留空表示一直有效；状态留空按“生效”。整份文件有任何一行有误都不会导入。'
export const estimatedFeeFileName = '预估费用导入模板.csv'
export const estimatedFeeTemplateCsv = (): string =>
  `\uFEFF${[ESTIMATED_FEE_FILE_HEADER.join(','), '站外推广,店铺,示例店铺,固定金额,300,按月,2026-01-01,,生效,站外推广月预算', '佣金,SKU,SKU-A,销售额比例,2.5,按日,2026-01-01,2026-06-30,,'].join(
    '\r\n',
  )}\r\n`

const COLUMNS = {
  item: ['费用项', '费用项目', '项目', 'item', 'feeitem'],
  scopeType: ['范围', '范围类型', 'scope', 'scopetype'],
  scopeId: ['范围对象', '对象', '店铺或sku或品类', 'scopeid', 'target'],
  mode: ['方式', '计费方式', 'mode'],
  value: ['金额或比例', '金额', '比例', 'value', 'amount'],
  period: ['周期', 'period'],
  from: ['起始日', '生效起', '开始日期', 'from', 'start'],
  to: ['截止日', '生效止', '结束日期', 'to', 'end'],
  status: ['状态', 'status'],
  note: ['备注', 'note', 'remark'],
} as const
const normalize = (text: string) => text.toLowerCase().replace(/[\s_()（）/-]/g, '')

const pick = <T extends string>(text: string, labels: Readonly<Record<T, string>>, extra: Record<string, T> = {}): T | null => {
  const key = normalize(text)
  for (const [code, label] of Object.entries<string>(labels)) if (key === normalize(label) || key === normalize(code)) return code as T
  return extra[key] ?? null
}

export interface EstimatedFeeFileRow {
  line: number
  itemName: string
  scopeType: EstimatedScopeType
  scopeId: string
  mode: EstimatedMode
  value: number
  period: EstimatedPeriod
  from: string
  to: string | null
  status: EstimatedStatus
  note: string | null
}
export interface EstimatedFeeFileParse {
  rows: EstimatedFeeFileRow[]
  errors: Array<{ line: number; message: string }>
}

/** 解析导入文件：表头认中英文别名；整份校验，错误最多记 50 条；一次最多 2000 行。 */
export function parseEstimatedFeeFile(content: string): EstimatedFeeFileParse {
  const errors: EstimatedFeeFileParse['errors'] = []
  const fail = (line: number, message: string) => {
    if (errors.length < ESTIMATED_FEE_LIMITS.problemMax) errors.push({ line, message })
  }
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter(entry => entry.raw.trim() !== '')
  if (lines.length === 0) {
    fail(0, '文件是空的')
    return { rows: [], errors }
  }
  const delimiter = csvDelimiterOf(lines[0]!.raw)
  const headers = splitCsvLine(lines[0]!.raw, delimiter).map(normalize)
  const index = (key: keyof typeof COLUMNS) => headers.findIndex(header => COLUMNS[key].some(alias => normalize(alias) === header))
  const at = Object.fromEntries((Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).map(key => [key, index(key)])) as Record<keyof typeof COLUMNS, number>
  const required: Array<[keyof typeof COLUMNS, string]> = [
    ['item', '费用项'],
    ['scopeType', '范围'],
    ['scopeId', '范围对象'],
    ['mode', '方式'],
    ['value', '金额或比例'],
    ['period', '周期'],
    ['from', '起始日'],
  ]
  for (const [key, label] of required) if (at[key] < 0) fail(lines[0]!.line, `缺少“${label}”列`)
  if (errors.length > 0) return { rows: [], errors }
  if (lines.length === 1) {
    fail(0, '文件里没有数据行（第一行应是表头）')
    return { rows: [], errors }
  }
  if (lines.length - 1 > ESTIMATED_FEE_LIMITS.importMaxRows) {
    fail(0, `一次最多导入 ${ESTIMATED_FEE_LIMITS.importMaxRows} 行，现在有 ${lines.length - 1} 行`)
    return { rows: [], errors }
  }
  const rows: EstimatedFeeFileRow[] = []
  for (const entry of lines.slice(1)) {
    const cells = splitCsvLine(entry.raw, delimiter)
    const cell = (key: keyof typeof COLUMNS) => (at[key] >= 0 ? (cells[at[key]] ?? '') : '')
    const before = errors.length
    const itemName = cell('item')
    const scopeType = pick(cell('scopeType'), ESTIMATED_SCOPE_LABEL, { 品类: 'CATEGORY', 类目: 'CATEGORY', 商品: 'SKU' })
    const scopeId = cell('scopeId')
    const mode = pick(cell('mode'), ESTIMATED_MODE_LABEL, { 固定: 'FIXED', 比例: 'PERCENT_OF_SALES', 百分比: 'PERCENT_OF_SALES' })
    const valueText = cell('value').replace(/[,，%％$]/g, '')
    const value = valueText === '' ? Number.NaN : Number(valueText)
    const period = pick(cell('period'), ESTIMATED_PERIOD_LABEL, { 日: 'DAILY', 每日: 'DAILY', 月: 'MONTHLY', 每月: 'MONTHLY' })
    const from = cell('from')
    const to = cell('to')
    const statusText = cell('status')
    const status = statusText === '' ? 'ACTIVE' : pick(statusText, ESTIMATED_STATUS_LABEL, { 启用: 'ACTIVE' })
    const note = cell('note')
    if (!itemName) fail(entry.line, '费用项必填')
    if (!scopeType) fail(entry.line, '范围只能写 店铺、SKU 或 品类')
    if (!scopeId) fail(entry.line, '范围对象必填')
    else if (scopeId.length > ESTIMATED_FEE_LIMITS.scopeIdMax) fail(entry.line, '范围对象太长')
    if (!mode) fail(entry.line, '方式只能写 固定金额 或 销售额比例')
    if (!Number.isFinite(value) || value <= 0) fail(entry.line, '金额或比例必须是大于 0 的数字')
    else if (value > ESTIMATED_FEE_LIMITS.valueMax) fail(entry.line, '金额或比例太大')
    else if (mode === 'PERCENT_OF_SALES' && value > 100) fail(entry.line, '销售额比例不能超过 100')
    if (!period) fail(entry.line, '周期只能写 按日 或 按月')
    if (!isDayText(from)) fail(entry.line, '起始日必填，格式 YYYY-MM-DD')
    if (to !== '' && !isDayText(to)) fail(entry.line, '截止日格式应为 YYYY-MM-DD')
    else if (to !== '' && isDayText(from) && to < from) fail(entry.line, '截止日不能早于起始日')
    if (!status) fail(entry.line, '状态只能写 生效 或 停用')
    if (note.length > ESTIMATED_FEE_LIMITS.noteMax) fail(entry.line, '备注太长（最多 200 个字）')
    if (errors.length > before || !scopeType || !mode || !period || !status) continue
    rows.push({ line: entry.line, itemName, scopeType, scopeId, mode, value, period, from, to: to === '' ? null : to, status, note: note === '' ? null : note })
  }
  return { rows: errors.length > 0 ? [] : rows, errors }
}

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** 导出内容：列与导入模板一致，导出的文件可以直接再导入。 */
export const estimatedFeeExportCsv = (
  rows: ReadonlyArray<{
    itemName: string
    scopeType: EstimatedScopeType
    scopeName: string
    mode: EstimatedMode
    value: number
    period: EstimatedPeriod
    from: string
    to: string | null
    status: EstimatedStatus
    note: string | null
  }>,
): string =>
  `\uFEFF${[
    ESTIMATED_FEE_FILE_HEADER.join(','),
    ...rows.map(row =>
      [
        row.itemName,
        ESTIMATED_SCOPE_LABEL[row.scopeType],
        row.scopeName,
        ESTIMATED_MODE_LABEL[row.mode],
        String(row.value),
        ESTIMATED_PERIOD_LABEL[row.period],
        row.from,
        row.to ?? '',
        ESTIMATED_STATUS_LABEL[row.status],
        row.note ?? '',
      ]
        .map(csvCell)
        .join(','),
    ),
  ].join('\r\n')}\r\n`
