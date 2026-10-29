import { z } from 'zod'
import type { DashState } from './dashboard.js'
import type { InventoryFreshness } from './inventory.js'

// 仓储容量与费用契约（P2a-09，06 章 6.6；freeze/api.md `/inventory/capacity*`）。
// 利用率来自月度仓储费报告（只有比率，没有限额与已用量）；限额与已用量来自卖家后台“库容管理”导出文件的导入（权限 data.import），逐项标注来源、采集日期、导入人。

export const STORAGE_TYPES = ['STANDARD', 'OVERSIZE', 'APPAREL', 'FOOTWEAR', 'DANGEROUS'] as const
export type StorageType = (typeof STORAGE_TYPES)[number]
export const STORAGE_TYPE_LABEL: Record<StorageType, string> = { STANDARD: '标准尺寸', OVERSIZE: '超大件', APPAREL: '服饰', FOOTWEAR: '鞋靴', DANGEROUS: '危险品' }
export const storageTypeLabel = (value: string) => STORAGE_TYPE_LABEL[value as StorageType] ?? value

export const STORAGE_FEE_KINDS = ['STORAGE', 'OVERAGE', 'LONGTERM', 'UTILIZATION'] as const
export type StorageFeeKind = (typeof STORAGE_FEE_KINDS)[number]
export const STORAGE_FEE_KIND_LABEL: Record<StorageFeeKind, string> = { STORAGE: '月度仓储费', OVERAGE: '超限费', LONGTERM: '长期仓储费', UTILIZATION: '利用率附加费' }

export interface CapacityRow {
  sellerAccountId: string
  storeName: string
  storageType: string
  storageTypeLabel: string
  /** 亚马逊月度报告里的利用率（比率，1.0 = 100%）与对应的月份；没有报告记录为 null。 */
  report: { utilization: number; month: string } | null
  /** 文件导入的限额与已用量（立方英尺，按卖家后台导出原样）；没有导入为 null。 */
  limit: {
    limitQty: number | null
    usedQty: number | null
    usedRatio: number | null
    captureDate: string
    sourceFileName: string | null
    importedBy: string | null
    importedAt: string
  } | null
}

export interface FeeMonth {
  month: string
  /** 某个费用类型这个月没有任何报告记录时为 null（尚无记录），不是 0。 */
  storage: number | null
  overage: number | null
  longTerm: number | null
  utilization: number | null
}

export interface CapacityCrossing {
  sellerAccountId: string
  storeName: string
  sku: string
  boundaryDays: number
  toLabel: string
  qty: number
  earliestDate: string
  latestDate: string
  likelyCrossed: boolean
  estimatedIncrease: number | null
}

export interface CapacitySuggestion {
  sellerAccountId: string
  storeName: string
  sku: string
  title: string | null
  /** 占用体积 = 单件体积 × 可售数量；缺任何一项为 null。 */
  occupiedVolume: number | null
  volumeUnit: string | null
  sellable: number
  daysOfCover: number | null
  nextMonthStorage: number | null
  action: string
  actionLabel: string
  reason: string
}

export interface NotConnectedItem {
  key: string
  label: string
  note: string
  workPackage: string
}

export interface StorageCapacityResponse {
  state: DashState
  note: string | null
  utilization: CapacityRow[]
  fees: { months: FeeMonth[]; latestMonth: string | null }
  forecast: {
    nextMonthStorage: number | null
    storageSkuCount: number
    ageSurchargeEstimate: number | null
    crossings: CapacityCrossing[]
    crossingTotal: number | null
  }
  suggestions: CapacitySuggestion[]
  notConnected: NotConnectedItem[]
  freshness: InventoryFreshness
}

/** 文件导入：浏览器读出 CSV 文本后提交，服务端逐行校验，全部通过才写入（一行有错整份拒绝）。 */
export const StorageLimitImportBodySchema = z
  .object({
    sellerAccountId: z.string().trim().min(1, '请选择店铺').max(64),
    fileName: z.string().trim().min(1, '缺少文件名').max(200),
    content: z.string().min(1, '文件内容为空').max(100_000, '文件过大（上限约 100 KB）'),
  })
  .strict()
export type StorageLimitImportBody = z.infer<typeof StorageLimitImportBodySchema>

export interface StorageLimitImportResponse {
  imported: number
  captureDates: string[]
  sourceFileName: string
}

/** 导入文件的列（中英文表头都认）：存储类型、限额、已用、采集日期。 */
export const STORAGE_LIMIT_COLUMNS = {
  type: ['存储类型', 'storage type', 'storagetype', 'storage_type'],
  limit: ['限额', 'limit', 'capacity limit'],
  used: ['已用', 'used', 'used volume'],
  date: ['采集日期', 'capture date', 'date'],
} as const
