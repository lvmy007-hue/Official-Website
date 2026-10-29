import { csvDelimiterOf, splitCsvLine } from './csv-table.js'
import type { PackingField, PackingUnits } from './packing-list.js'

// 外部货号映射与供应商装箱单列映射的契约（P6-11，16 章 5.1）：行类型、列表响应、常量与导入文件的解析。零 zod，前后端共用；请求体校验在 packing-list-query.ts。

export const SKU_ALIAS_READ = 'inbound.read'
export const SKU_ALIAS_MANAGE = 'skualias.manage'
export const SKU_ALIAS_PATH = '/app/settings/sku-aliases'
export const SKU_ALIAS_SOURCES = ['MANUAL', 'IMPORT'] as const
export type SkuAliasSource = (typeof SKU_ALIAS_SOURCES)[number]
export const SKU_ALIAS_SOURCE_LABEL: Record<SkuAliasSource, string> = { MANUAL: '人工', IMPORT: '文件导入' }
/** 每个企业最多保存多少条外部货号映射（防止无上限增长；装箱单再多也不会超过）。 */
export const SKU_ALIAS_TENANT_LIMIT = 50_000
export const SKU_ALIAS_IMPORT_MAX_ROWS = 2000
export const SKU_ALIAS_IMPORT_MAX_CHARS = 400_000
/** 导出最多多少行（单次查询上限 20000，多取一行用来判断是否被截断，所以这里是 19999）。 */
export const SKU_ALIAS_EXPORT_MAX_ROWS = 19_999
export const SKU_ALIAS_BLOCKED_NO_PERMISSION = '你没有维护外部货号映射的权限（需要“维护外部货号映射与装箱单列映射”），请联系管理员'
export const SKU_ALIAS_ACTIONS = {
  created: 'SKU_ALIAS_CREATED',
  updated: 'SKU_ALIAS_UPDATED',
  deleted: 'SKU_ALIAS_DELETED',
  imported: 'SKU_ALIAS_IMPORTED',
  mappingSaved: 'PACKING_LIST_MAPPING_SAVED',
  mappingDeleted: 'PACKING_LIST_MAPPING_DELETED',
  packingPreviewed: 'FBA_INBOUND_PACKING_LIST_PREVIEWED',
  packingApplied: 'FBA_INBOUND_PACKING_LIST_APPLIED',
} as const

export const SKU_ALIAS_SORTABLE = ['externalCode', 'sku', 'updatedAt'] as const
export type SkuAliasSortField = (typeof SKU_ALIAS_SORTABLE)[number]

export interface SkuAliasRow {
  id: string
  /** 空表示通用映射（所有供应商的装箱单都可用）。 */
  supplierId: string | null
  supplierCode: string | null
  supplierName: string | null
  externalCode: string
  sku: string
  /** 商品目录里这个 SKU 的标题（目录里没有时为 null）。 */
  skuTitle: string | null
  source: SkuAliasSource
  version: number
  updatedAt: string
}
export interface SkuAliasListResponse {
  items: SkuAliasRow[]
  page: number
  pageSize: number
  total: number
  summary: { total: number; general: number; supplier: number }
  canManage: boolean
  manageBlockedReason: string | null
}
export interface SkuAliasImportResponse {
  total: number
  created: number
  updated: number
}
export interface SkuAliasExportResponse {
  fileName: string
  /** UTF-8 带 BOM 的 CSV，列与导入模板一致。 */
  content: string
  rows: number
  truncated: boolean
}

export interface PackingMappingRow {
  supplierId: string
  supplierCode: string
  supplierName: string
  /** 标准列 → 该供应商装箱单里的表头文字。 */
  columns: Partial<Record<PackingField, string>>
  units: Partial<PackingUnits> | null
  version: number
  updatedAt: string
}
export interface PackingMappingListResponse {
  items: PackingMappingRow[]
  canManage: boolean
  manageBlockedReason: string | null
}
export interface PackingMappingOneResponse {
  supplier: { id: string; code: string; name: string }
  mapping: PackingMappingRow | null
  canManage: boolean
  manageBlockedReason: string | null
}

// ---------------------------------------------------------------- 导入文件（CSV：供应商编码、外部货号、SKU）
export const SKU_ALIAS_FILE_HEADER = ['供应商编码', '外部货号', 'SKU'] as const
export const SKU_ALIAS_FILE_HINT =
  '每行一条对应关系：供应商编码留空表示通用映射；外部货号是供应商装箱单里的货号或条码；SKU 必须是商品目录里已有的卖家 SKU。同一个供应商同一个外部货号已有映射的，按文件更新。'
export const skuAliasFileName = '外部货号映射导入模板.csv'
export const skuAliasTemplateCsv = (): string => `\uFEFF${[SKU_ALIAS_FILE_HEADER.join(','), 'SUP-001,AB-1001,SKU-A', ',条码-6901234567890,SKU-B'].join('\r\n')}\r\n`

const FILE_COLUMNS = {
  supplierCode: ['供应商编码', '供应商代码', '供应商', 'suppliercode', 'supplier'],
  externalCode: ['外部货号', '供应商货号', '货号', '条码', 'externalcode', 'external', 'code'],
  sku: ['sku', '卖家sku', 'sellersku', '我方sku'],
} as const
const normalize = (text: string) => text.toLowerCase().replace(/[\s_()（）-]/g, '')

export interface SkuAliasFileRow {
  line: number
  supplierCode: string | null
  externalCode: string
  sku: string
}
export interface SkuAliasFileParse {
  rows: SkuAliasFileRow[]
  errors: Array<{ line: number; message: string }>
}

/** 解析映射导入文件：表头认中英文别名；整份校验，任何一行有错就整份不导入；同一个（供应商，外部货号）在文件里出现多次且 SKU 不同视为错误。 */
export function parseSkuAliasFile(content: string): SkuAliasFileParse {
  const errors: SkuAliasFileParse['errors'] = []
  const fail = (line: number, message: string) => {
    if (errors.length < 50) errors.push({ line, message })
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
  const index = (key: keyof typeof FILE_COLUMNS) => headers.findIndex(header => FILE_COLUMNS[key].some(alias => normalize(alias) === header))
  const [supplierAt, codeAt, skuAt] = [index('supplierCode'), index('externalCode'), index('sku')]
  if (codeAt < 0) fail(lines[0]!.line, '缺少“外部货号”列')
  if (skuAt < 0) fail(lines[0]!.line, '缺少“SKU”列')
  if (errors.length > 0) return { rows: [], errors }
  if (lines.length === 1) {
    fail(0, '文件里没有数据行（第一行应是表头）')
    return { rows: [], errors }
  }
  if (lines.length - 1 > SKU_ALIAS_IMPORT_MAX_ROWS) {
    fail(0, `一次最多导入 ${SKU_ALIAS_IMPORT_MAX_ROWS} 行，现在有 ${lines.length - 1} 行`)
    return { rows: [], errors }
  }
  const rows: SkuAliasFileRow[] = []
  const seen = new Map<string, { sku: string; line: number }>()
  for (const entry of lines.slice(1)) {
    const cells = splitCsvLine(entry.raw, delimiter)
    const supplierCode = supplierAt >= 0 ? (cells[supplierAt] ?? '') : ''
    const externalCode = cells[codeAt] ?? ''
    const sku = cells[skuAt] ?? ''
    if (!externalCode) fail(entry.line, '外部货号必填')
    else if (externalCode.length > 120) fail(entry.line, '外部货号太长（最多 120 个字）')
    if (!sku) fail(entry.line, 'SKU 必填')
    else if (sku.length > 120) fail(entry.line, 'SKU 太长（最多 120 个字）')
    if (supplierCode.length > 60) fail(entry.line, '供应商编码太长')
    if (!externalCode || !sku) continue
    const key = `${supplierCode}\u0000${externalCode}`
    const earlier = seen.get(key)
    if (earlier && earlier.sku !== sku) fail(entry.line, `外部货号 ${externalCode} 与第 ${earlier.line} 行重复，但 SKU 不同`)
    else if (earlier) continue
    else seen.set(key, { sku, line: entry.line })
    rows.push({ line: entry.line, supplierCode: supplierCode || null, externalCode, sku })
  }
  return { rows: errors.length > 0 ? [] : rows, errors }
}

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
/** 导出内容：列与导入模板一致，导出的文件可以直接再导入。 */
export const skuAliasExportCsv = (rows: ReadonlyArray<Pick<SkuAliasRow, 'supplierCode' | 'externalCode' | 'sku'>>): string =>
  `\uFEFF${[SKU_ALIAS_FILE_HEADER.join(','), ...rows.map(row => [row.supplierCode ?? '', row.externalCode, row.sku].map(csvCell).join(','))].join('\r\n')}\r\n`
