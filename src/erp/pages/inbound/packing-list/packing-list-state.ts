import {
  DEFAULT_PACKING_UNITS,
  PACKING_CSV_MAX_CHARS,
  PACKING_FIELDS,
  PACKING_XLSX_MAX_BASE64,
  buildPackingBoxes,
  resolvePacking,
  type PackingAnalysis,
  type PackingDecision,
  type PackingDefaults,
  type PackingField,
  type PackingFileFormat,
  type PackingUnits,
} from '@nova/api-contracts'

// 装箱单匹配页签的纯逻辑（P6-11）：文件读取后的形态、识别设置转请求体、人工决定、应用前的就绪判断。
// 应用前的“还有哪些行没解决”直接用契约里的 resolvePacking（服务端用同一个函数再算一遍），所以前端按钮状态与服务端判断不会不一致。

export interface PackingFile {
  fileName: string
  format: PackingFileFormat
  content: string
}

export interface PackingSettings {
  supplierId: string | null
  sheet: string | null
  headerLine: number | null
  /** 手动指定的列：字段 → 列序号（从 0 起），null 表示这一字段没有对应列；没出现表示不干预。 */
  columns: Partial<Record<PackingField, number | null>>
  units: Partial<PackingUnits>
  defaults: PackingDefaults
}

export const EMPTY_SETTINGS: PackingSettings = { supplierId: null, sheet: null, headerLine: null, columns: {}, units: {}, defaults: {} }

export type DecisionMap = Readonly<Record<number, PackingDecision>>

/** 文件名取扩展名决定格式：.xlsx 读 Excel，.xls 不支持，其余当 CSV 文本。 */
export function formatOf(fileName: string): PackingFileFormat | 'XLS' {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'XLSX'
  if (lower.endsWith('.xls')) return 'XLS'
  return 'CSV'
}

/** 文件是否超出大小上限（超出返回原因）。 */
export function sizeProblem(file: PackingFile): string | null {
  if (file.format === 'CSV' && file.content.length > PACKING_CSV_MAX_CHARS) return '文件过大（CSV 上限约 400 KB），请拆成几份'
  if (file.format === 'XLSX' && file.content.length > PACKING_XLSX_MAX_BASE64) return '文件过大（Excel 上限约 600 KB），请拆成几份或删掉多余的工作表与图片'
  return null
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

const positive = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)

/** 识别设置里没填的项不进请求体（服务端按保存的映射、表头提示、默认值处理）。 */
export function requestBody(file: PackingFile, settings: PackingSettings) {
  const columns = Object.fromEntries(PACKING_FIELDS.flatMap(field => (settings.columns[field] === undefined ? [] : [[field, settings.columns[field]]])))
  const units = {
    ...(settings.units.length ? { length: settings.units.length } : {}),
    ...(settings.units.weight ? { weight: settings.units.weight } : {}),
  }
  const defaults = {
    ...(positive(settings.defaults.weightLb) ? { weightLb: settings.defaults.weightLb } : {}),
    ...(positive(settings.defaults.lengthIn) ? { lengthIn: settings.defaults.lengthIn } : {}),
    ...(positive(settings.defaults.widthIn) ? { widthIn: settings.defaults.widthIn } : {}),
    ...(positive(settings.defaults.heightIn) ? { heightIn: settings.defaults.heightIn } : {}),
  }
  return {
    fileName: file.fileName,
    format: file.format,
    content: file.content,
    supplierId: settings.supplierId,
    ...(file.format === 'XLSX' && settings.sheet ? { sheet: settings.sheet } : {}),
    ...(settings.headerLine ? { headerLine: settings.headerLine } : {}),
    ...(Object.keys(columns).length > 0 ? { columns } : {}),
    ...(Object.keys(units).length > 0 ? { units } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
  }
}

/** 把决定表整理成请求里的数组：没有任何内容的决定不传。 */
export function decisionList(map: DecisionMap): PackingDecision[] {
  return Object.values(map)
    .filter(item => item.ignore === true || (item.sku ?? null) !== null || item.remember === true)
    .map(item => ({ line: item.line, ...(item.ignore ? { ignore: true } : {}), ...(item.sku ? { sku: item.sku } : {}), ...(item.remember ? { remember: true } : {}) }))
    .sort((a, b) => a.line - b.line)
}

/** 改一行的决定：选了 SKU 就取消忽略，选了忽略就清掉 SKU 与“记住”。 */
export function withDecision(map: DecisionMap, line: number, patch: Partial<Omit<PackingDecision, 'line'>>): DecisionMap {
  const current = map[line] ?? { line }
  const next: PackingDecision = { ...current, ...patch, line }
  if (patch.sku) next.ignore = false
  if (patch.ignore) {
    next.sku = null
    next.remember = false
  }
  if (patch.sku === null) next.remember = false
  return { ...map, [line]: next }
}

export type RowVerdict = 'IGNORED' | 'PROBLEM' | 'NEEDS_SKU' | 'READY'

export interface VerdictInput {
  line: number
  sku: string | null
  issues: readonly string[]
}

/**
 * 装箱后才看得出的问题（同箱规格不一致、缺箱规、同箱 SKU 重复），按行号。
 * 随人工决定与默认箱规实时重算（预览行里的 boxIssues 是识别那一刻的，改了默认箱规或选了 SKU 就过时了），与服务端应用时用同一个 buildPackingBoxes。
 */
export function liveBoxIssues(analysis: PackingAnalysis | null, decisions: DecisionMap, defaults: PackingDefaults | null): ReadonlyMap<number, string[]> {
  if (!analysis || analysis.fatal) return new Map()
  const used = analysis.rows.flatMap(row => {
    const sku = decisions[row.line]?.sku ?? row.sku
    return decisions[row.line]?.ignore || row.issues.length > 0 || !sku ? [] : [{ ...row, sku }]
  })
  return buildPackingBoxes(used, defaults).rowIssues
}

/** 这一行现在的处理结果：忽略 / 数据有问题 / 还要选 SKU / 可以装箱。 */
export function verdictOf(row: VerdictInput, decision: PackingDecision | undefined, boxIssues: readonly string[] = []): RowVerdict {
  if (decision?.ignore) return 'IGNORED'
  if (row.issues.length > 0 || boxIssues.length > 0) return 'PROBLEM'
  return (decision?.sku ?? row.sku) ? 'READY' : 'NEEDS_SKU'
}

export interface Readiness {
  total: number
  ready: number
  ignored: number
  needsSku: number
  problems: number
  /** 应用时会写进映射表的条数。 */
  toRemember: number
  blockers: string[]
  canApply: boolean
}

export function readiness(analysis: PackingAnalysis | null, decisions: DecisionMap, planSkus: ReadonlySet<string>, defaults: PackingDefaults | null): Readiness {
  const empty: Readiness = { total: 0, ready: 0, ignored: 0, needsSku: 0, problems: 0, toRemember: 0, blockers: [], canApply: false }
  if (!analysis || analysis.fatal || analysis.rows.length === 0) return empty
  const live = liveBoxIssues(analysis, decisions, defaults)
  const verdicts = analysis.rows.map(row => verdictOf(row, decisions[row.line], live.get(row.line)))
  const count = (verdict: RowVerdict) => verdicts.filter(item => item === verdict).length
  const resolved = resolvePacking(analysis.rows, decisionList(decisions), planSkus, defaults)
  return {
    total: analysis.rows.length,
    ready: count('READY'),
    ignored: count('IGNORED'),
    needsSku: count('NEEDS_SKU'),
    problems: count('PROBLEM'),
    toRemember: resolved.remember.length,
    blockers: resolved.blockers,
    canApply: resolved.blockers.length === 0 && resolved.boxes.length > 0,
  }
}

export const unitsOrDefault = (units: Partial<PackingUnits>, detected: PackingUnits | null): PackingUnits => ({
  length: units.length ?? detected?.length ?? DEFAULT_PACKING_UNITS.length,
  weight: units.weight ?? detected?.weight ?? DEFAULT_PACKING_UNITS.weight,
})
