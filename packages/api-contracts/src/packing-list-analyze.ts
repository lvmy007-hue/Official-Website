import { buildPackingBoxes, type PackingDefaults } from './packing-list-boxes.js'
import {
  DEFAULT_PACKING_UNITS,
  columnsFromSaved,
  detectColumns,
  detectHeaderRow,
  missingPackingFields,
  PACKING_FIELDS,
  PACKING_HEADER_SCAN_ROWS,
  PACKING_MAX_COLUMNS,
  type PackingColumns,
  type PackingField,
  type PackingUnits,
  type PackingUnitsSource,
} from './packing-list.js'
import { aliasLookup, matchKeys, matchPackingRow, type AliasRef, type PackingCandidate, type PackingMatchBasis, type PackingMatchStatus, type PlanItemRef } from './packing-list-match.js'
import { extractPackingRows, type PackingSkippedRow, type PackingSourceRow } from './packing-list-rows.js'

// 装箱单的整体分析（P6-11）：表 → 表头行 → 列映射（手动指定 > 该供应商保存的 > 自动识别）→ 单位 → 逐行读取 → 匹配 SKU → 合并箱子检查。
// 纯函数，不带 zod：服务端的预览与应用都调它，所以两次得到的行号与判断完全一致。

export type PackingColumnSource = 'REQUEST' | 'SAVED' | 'AUTO'

export interface PackingPreviewRow {
  line: number
  boxNo: string | null
  boxNoInherited: boolean
  code: string | null
  name: string | null
  totalQty: number | null
  perBox: number | null
  boxCount: number | null
  weightLb: number | null
  lengthIn: number | null
  widthIn: number | null
  heightIn: number | null
  status: PackingMatchStatus
  basis: PackingMatchBasis | null
  /** 自动匹配到的 SKU（只有“已匹配”才有；候选不会自动采用）。 */
  sku: string | null
  candidates: PackingCandidate[]
  note: string | null
  /** 这一行自己的数据问题（数量读不出、箱号范围颠倒……），有就不能装箱，只能改文件或忽略。 */
  issues: string[]
  /** 合并成箱子后发现的问题（同箱规格不一致、缺箱规、同箱 SKU 重复）。 */
  boxIssues: string[]
  warnings: string[]
  /** 供 resolvePacking 用（与 PackingSourceRow 对齐）。 */
  boxRange: { from: number; to: number } | null
}

export interface PackingSummary {
  rows: number
  matched: number
  candidate: number
  unmatched: number
  /** 有数据问题或箱子问题的行。 */
  problems: number
  units: number
  skipped: number
}

export interface PackingAnalysis {
  /** 表头在第几行（从 1 起）；找不到是 null。 */
  headerLine: number | null
  headers: string[]
  columns: PackingColumns
  columnSources: Partial<Record<PackingField, PackingColumnSource>>
  /** 缺少的必需列（要让用户手动指定）。 */
  missingFields: string[]
  /** 保存的列映射里这份文件找不到的表头。 */
  missingSaved: string[]
  units: PackingUnits
  unitsSource: PackingUnitsSource
  rows: PackingPreviewRow[]
  skipped: PackingSkippedRow[]
  notes: string[]
  /** 整份文件的问题（行数超限、找不到表头），有就没有 rows。 */
  fatal: string | null
  summary: PackingSummary
}

/** 第一步的输入：表与列、单位的各种来源（还不涉及匹配）。 */
export interface PackingPrepareInput {
  table: readonly (readonly string[])[]
  /** 表头在第几行（从 1 起），不给就自动找。 */
  headerLine?: number | null
  /** 手动指定的列：值是列序号（从 0 起），null 表示这一字段没有对应列。 */
  columns?: PackingColumns | null
  savedColumns?: Partial<Record<PackingField, string>> | null
  units?: Partial<PackingUnits> | null
  savedUnits?: Partial<PackingUnits> | null
}
/** 第二步的输入：计划里的商品与外部货号映射。 */
export interface PackingMatchInput {
  defaults?: PackingDefaults | null
  items: readonly PlanItemRef[]
  aliases: readonly AliasRef[]
  supplierId: string | null
}
export type PackingAnalyzeInput = PackingPrepareInput & PackingMatchInput

/** 第一步的结果：读完表头与各行（sourceRows 为空表示停在了这一步，analysis 里写明原因）。分两步是因为服务端要先知道有哪些货号，才能一次查出映射。 */
export interface PackingPrepared {
  analysis: PackingAnalysis
  sourceRows: PackingSourceRow[] | null
}

const emptySummary: PackingSummary = { rows: 0, matched: 0, candidate: 0, unmatched: 0, problems: 0, units: 0, skipped: 0 }

export function preparePacking(input: PackingPrepareInput): PackingPrepared {
  const { table } = input
  const stop = (analysis: PackingAnalysis): PackingPrepared => ({ analysis, sourceRows: null })
  const base = {
    headerLine: null,
    headers: [] as string[],
    columns: {} as PackingColumns,
    columnSources: {},
    missingFields: [] as string[],
    missingSaved: [] as string[],
    rows: [],
    skipped: [],
    notes: [],
    summary: emptySummary,
  }
  const empty = { ...base, units: DEFAULT_PACKING_UNITS, unitsSource: 'DEFAULT' as PackingUnitsSource }
  if (table.every(cells => cells.every(cell => cell.trim() === ''))) return stop({ ...empty, fatal: '文件是空的' })

  const requested = input.headerLine ? input.headerLine - 1 : null
  if (requested !== null && (requested < 0 || requested >= table.length)) return stop({ ...empty, fatal: `表头行 ${input.headerLine} 超出了文件范围（共 ${table.length} 行）` })
  const found = requested ?? detectHeaderRow(table)
  const headerRow =
    found >= 0
      ? found
      : Math.max(
          0,
          table.findIndex(cells => cells.some(cell => cell.trim() !== '')),
        )
  const headerAuto = found < 0
  const headers = (table[headerRow] ?? []).slice(0, PACKING_MAX_COLUMNS).map(cell => cell.trim())
  if ((table[headerRow] ?? []).length > PACKING_MAX_COLUMNS) return stop({ ...empty, headerLine: headerRow + 1, fatal: `列太多（超过 ${PACKING_MAX_COLUMNS} 列），请删掉多余的列` })

  // 列：自动识别打底，保存的映射覆盖，手动指定最后覆盖
  const detected = detectColumns(headers)
  const saved = input.savedColumns ? columnsFromSaved(headers, input.savedColumns) : { columns: {} as PackingColumns, missing: [] as string[] }
  const columns: PackingColumns = { ...detected.columns }
  const columnSources: PackingAnalysis['columnSources'] = {}
  for (const field of PACKING_FIELDS) if (typeof detected.columns[field] === 'number') columnSources[field] = 'AUTO'
  for (const field of PACKING_FIELDS) {
    if (typeof saved.columns[field] === 'number') {
      columns[field] = saved.columns[field]
      columnSources[field] = 'SAVED'
    }
  }
  for (const field of PACKING_FIELDS) {
    const given = input.columns?.[field]
    if (given === undefined) continue
    if (given === null || given < 0 || given >= headers.length) {
      delete columns[field]
      delete columnSources[field]
    } else {
      columns[field] = given
      columnSources[field] = 'REQUEST'
    }
  }
  // 同一列只能给一个字段：手动指定 > 保存的 > 自动识别，同级别时排在前面的字段先占
  const priority: Record<PackingColumnSource, number> = { REQUEST: 3, SAVED: 2, AUTO: 1 }
  const owners = new Map<number, PackingField>()
  for (const field of PACKING_FIELDS) {
    const index = columns[field]
    if (typeof index !== 'number') continue
    const owner = owners.get(index)
    if (!owner) owners.set(index, field)
    else if (priority[columnSources[field] ?? 'AUTO'] > priority[columnSources[owner] ?? 'AUTO']) {
      delete columns[owner]
      delete columnSources[owner]
      owners.set(index, field)
    } else {
      delete columns[field]
      delete columnSources[field]
    }
  }

  const missingFields = missingPackingFields(columns)
  const lengthHint = detected.unitHints.length
  const weightHint = detected.unitHints.weight
  const requestedUnits = input.units ?? null
  const savedUnits = input.savedUnits ?? null
  const units: PackingUnits = {
    length: requestedUnits?.length ?? savedUnits?.length ?? lengthHint ?? DEFAULT_PACKING_UNITS.length,
    weight: requestedUnits?.weight ?? savedUnits?.weight ?? weightHint ?? DEFAULT_PACKING_UNITS.weight,
  }
  const unitsSource: PackingUnitsSource =
    requestedUnits?.length || requestedUnits?.weight ? 'REQUEST' : savedUnits?.length || savedUnits?.weight ? 'SAVED' : lengthHint || weightHint ? 'HEADER' : 'DEFAULT'
  const common = { headerLine: headerRow + 1, headers, columns, columnSources, missingFields, missingSaved: saved.missing, units, unitsSource, skipped: [] as PackingSkippedRow[] }
  const notes: string[] = headerAuto ? [`没有认出表头，暂按第 ${headerRow + 1} 行当表头；认错了请指定表头在第几行（前 ${PACKING_HEADER_SCAN_ROWS} 行里找）`] : []
  if (missingFields.length > 0) return stop({ ...common, rows: [], notes, fatal: null, summary: emptySummary })

  const extract = extractPackingRows(table, { headerRow, columns, units })
  if (extract.fatal) return stop({ ...common, rows: [], notes, fatal: extract.fatal, summary: emptySummary })
  notes.push(...extract.notes)
  return { analysis: { ...common, skipped: extract.skipped, rows: [], notes, fatal: null, summary: emptySummary }, sourceRows: extract.rows }
}

/** 这份文件里要拿去查映射的键（货号与品名，去重）。 */
export const packingMatchKeys = (prepared: PackingPrepared): string[] => [...new Set((prepared.sourceRows ?? []).flatMap(row => matchKeys(row)))]

/** 第二步：逐行匹配 SKU，再把同箱的行合并检查（候选与未匹配的行先用占位 SKU，只为检查箱规与箱数）。 */
export function finishPacking(prepared: PackingPrepared, input: PackingMatchInput): PackingAnalysis {
  const { analysis, sourceRows } = prepared
  if (!sourceRows) return analysis
  const aliases = aliasLookup(input.aliases, input.supplierId)
  const rows: PackingPreviewRow[] = sourceRows.map(row => {
    const match = matchPackingRow(row, input.items, aliases)
    return { ...row, boxIssues: [], status: match.status, basis: match.basis, sku: match.sku, candidates: match.candidates, note: match.note }
  })
  const notes = [...analysis.notes]
  const probe = buildPackingBoxes(
    rows.filter(row => row.issues.length === 0).map(row => ({ ...row, sku: row.sku ?? `?${row.line}` })),
    input.defaults ?? null,
  )
  for (const row of rows) row.boxIssues = probe.rowIssues.get(row.line) ?? []
  notes.push(...probe.errors)
  const count = (status: PackingMatchStatus) => rows.filter(row => row.status === status).length
  const summary: PackingSummary = {
    rows: rows.length,
    matched: count('MATCHED'),
    candidate: count('CANDIDATE'),
    unmatched: count('UNMATCHED'),
    problems: rows.filter(row => row.issues.length > 0 || row.boxIssues.length > 0).length,
    units: rows.reduce((sum, row) => sum + (row.perBox !== null && row.boxCount !== null ? row.perBox * row.boxCount : 0), 0),
    skipped: analysis.skipped.length,
  }
  return { ...analysis, rows, notes, fatal: rows.length === 0 ? '没有读到任何商品行（表头下面是空的，或都是合计行）' : null, summary }
}

export const analyzePacking = (input: PackingAnalyzeInput): PackingAnalysis => finishPacking(preparePacking(input), input)
