import type { InboundPlanRow } from './inbound-views.js'
import type { PackingAnalysis } from './packing-list-analyze.js'

// 供应商装箱单预览与应用的响应与常量（P6-11）。零 zod；请求体校验在 packing-list-query.ts（前端不引用）。

export const PACKING_FILE_FORMATS = ['CSV', 'XLSX'] as const
export type PackingFileFormat = (typeof PACKING_FILE_FORMATS)[number]
/** CSV 文本上限（与装箱文件导入一致）。 */
export const PACKING_CSV_MAX_CHARS = 400_000
/** XLSX 的 base64 上限：全局请求体上限是 1MB，留出其余字段的余量，约合 640KB 的原文件。 */
export const PACKING_XLSX_MAX_BASE64 = 880_000
export const PACKING_FILE_HINT = '支持 Excel（.xlsx）与 CSV 文件，读取第一个工作表（有多个时可以选）；一次最多 2000 行，文件不超过约 600 KB。'
export const PACKING_MATCH_HINT =
  '匹配顺序：先与计划里的 SKU、FNSKU、ASIN 精确比对，再查外部货号映射，最后给出相似的候选（最多 5 个，只作提示，不会自动采用）。商品条码（UPC、EAN）目录里还没有，尚未接入，可以先把条码记到外部货号映射里。'

export interface PackingPreviewResponse extends PackingAnalysis {
  planId: string
  fileName: string
  format: PackingFileFormat
  /** 读取的工作表名（CSV 为 null）。 */
  sheet: string | null
  sheets: string[]
  supplier: { id: string; code: string; name: string } | null
  /** 该供应商保存过列映射。 */
  savedMapping: boolean
  canApply: boolean
  applyBlockedReason: string | null
  /** 计划里现有的箱型数（应用会整体替换）。 */
  existingBoxTypes: number
  /** 当前账号能不能把“外部货号 → SKU”记进映射表。 */
  canRemember: boolean
  rememberBlockedReason: string | null
}

export interface PackingApplyResponse {
  plan: InboundPlanRow
  state: 'SAVED'
  imported: { boxTypes: number; boxes: number; units: number }
  ignored: number
  remembered: number
}
