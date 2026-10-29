import { RETURN_REASON_LABEL, UNSPECIFIED_REASON_KEY } from './returns-reason-base.js'

// 退货原因三层（P6-13，16 章第 6 节）：亚马逊原因代码 → 中文释义 → 大类。零 zod，前后端共用。
// 预置映射在这里（代码里），企业改过的预置项、自己加的项、导入时发现的新代码存在 ReturnReasonMap 表里，读的时候叠在预置之上。

export { RETURN_REASON_LABEL, UNSPECIFIED_REASON_KEY }

/** 大类（12 个，含“未分类”）。表单只允许从这里选，保证汇总口径稳定。 */
export const RETURN_REASON_CATEGORIES = [
  '商品质量',
  '与描述不符',
  '缺件与错发',
  '物流与配送',
  '仓库问题',
  '买家改变主意',
  '订单操作',
  '价格因素',
  '兼容性',
  '尺码与款式',
  '其他原因',
  '未分类',
] as const
export type ReturnReasonCategory = (typeof RETURN_REASON_CATEGORIES)[number]
/** 映射表里没有的新代码自动加入时用的大类，也是页面提醒“去补全”的依据。 */
export const UNCLASSIFIED_CATEGORY: ReturnReasonCategory = '未分类'
/** 报告里原因列为空时的显示。 */
export const UNSPECIFIED_REASON_LABEL = '未提供原因'
/** 每个企业映射表最多多少行（预置之外）。 */
export const RETURN_REASON_MAP_LIMIT = 500
/** 一次保存最多改多少行。 */
export const RETURN_REASON_PUT_MAX = 50
export const RETURN_REASON_MAP_PERMISSION = 'returns.read'
export const RETURN_REASON_MAP_WRITE = 'settings.write'
export const RETURN_REASON_MAP_ACTION = 'RETURN_REASON_MAP_UPDATED'
export const RETURN_REASON_BLOCKED_NO_PERMISSION = '你没有维护退货原因映射的权限（需要“企业设置”的修改权限）'

/** 预置代码对应的大类（与 RETURN_REASON_LABEL 一一对应，returns-reason.test.ts 逐项核对）。 */
const PRESET_CATEGORY: Readonly<Record<string, ReturnReasonCategory>> = {
  DEFECTIVE: '商品质量',
  NOT_AS_DESCRIBED: '与描述不符',
  QUALITY_UNACCEPTABLE: '商品质量',
  MISSING_PARTS: '缺件与错发',
  DAMAGED_BY_FC: '仓库问题',
  DAMAGED_BY_CARRIER: '物流与配送',
  WRONG_ITEM: '缺件与错发',
  EXTRA_ITEM: '缺件与错发',
  UNWANTED_ITEM: '买家改变主意',
  UNAUTHORIZED_PURCHASE: '订单操作',
  ORDERED_WRONG_ITEM: '订单操作',
  NOT_COMPATIBLE: '兼容性',
  FOUND_BETTER_PRICE: '价格因素',
  NO_REASON_GIVEN: '其他原因',
  SWITCHEROO: '其他原因',
  UNDELIVERABLE_REFUSED: '物流与配送',
  UNDELIVERABLE_UNKNOWN: '物流与配送',
  APPAREL_TOO_SMALL: '尺码与款式',
  APPAREL_TOO_LARGE: '尺码与款式',
  APPAREL_STYLE: '尺码与款式',
  EXCESSIVE_INSTALLATION: '其他原因',
  ARRIVED_LATE: '物流与配送',
}

export interface ReturnReasonPreset {
  labelZh: string
  category: ReturnReasonCategory
}
export const RETURN_REASON_PRESETS: Readonly<Record<string, ReturnReasonPreset>> = Object.fromEntries(
  Object.entries(RETURN_REASON_LABEL).map(([code, labelZh]) => [code, { labelZh, category: PRESET_CATEGORY[code] ?? UNCLASSIFIED_CATEGORY }]),
)

/** 原因代码的归并键：去空白并转大写；空值是“未提供”。 */
export function reasonKey(raw: string | null | undefined): string {
  const text = raw?.trim().toUpperCase()
  return text ? text : UNSPECIFIED_REASON_KEY
}

export type ReturnReasonSource = 'PRESET' | 'PRESET_EDITED' | 'CUSTOM' | 'AUTO' | 'UNMAPPED' | 'NONE'

export interface ReturnReasonView {
  /** 归并键（大写；没有原因是 UNSPECIFIED）。 */
  code: string
  label: string
  category: string
  /** 是否有明确的中文释义与大类（未分类、没登记过的新代码都是 false）。 */
  mapped: boolean
  source: ReturnReasonSource
}

export interface ReasonOverride {
  labelZh: string
  category: string
  isSystem: boolean
}

/**
 * 解析一个原因代码：企业自己的映射优先，其次预置；都没有时原样显示代码并标“未分类”（mapped = false，由页面提醒补全）。
 * 企业映射里大类是“未分类”的（导入时自动加入、还没人补全）同样 mapped = false。
 */
export function resolveReason(raw: string | null | undefined, overrides: ReadonlyMap<string, ReasonOverride> | null = null): ReturnReasonView {
  const code = reasonKey(raw)
  if (code === UNSPECIFIED_REASON_KEY) return { code, label: UNSPECIFIED_REASON_LABEL, category: UNCLASSIFIED_CATEGORY, mapped: false, source: 'NONE' }
  const own = overrides?.get(code)
  const preset = RETURN_REASON_PRESETS[code]
  if (own) {
    const mapped = own.category !== UNCLASSIFIED_CATEGORY
    const source: ReturnReasonSource = preset ? 'PRESET_EDITED' : own.isSystem ? 'CUSTOM' : mapped ? 'CUSTOM' : 'AUTO'
    return { code, label: own.labelZh, category: own.category, mapped, source }
  }
  if (preset) return { code, label: preset.labelZh, category: preset.category, mapped: true, source: 'PRESET' }
  return { code, label: raw?.trim() ?? code, category: UNCLASSIFIED_CATEGORY, mapped: false, source: 'UNMAPPED' }
}

// ---- 映射表接口 ----

export interface ReturnReasonMapRow {
  code: string
  labelZh: string
  category: string
  source: Exclude<ReturnReasonSource, 'UNMAPPED' | 'NONE'>
  /** 预置项的出厂释义与大类（企业改过时用来看差别、恢复）；自己加的项为空。 */
  presetLabelZh: string | null
  presetCategory: string | null
  /** 是否还是“未分类”（要提醒补全）。 */
  unclassified: boolean
  updatedAt: string | null
}

export interface ReturnReasonMapListResponse {
  items: ReturnReasonMapRow[]
  page: number
  pageSize: number
  total: number
  summary: { total: number; unclassified: number; edited: number; custom: number }
  categories: readonly string[]
  canManage: boolean
  manageBlockedReason: string | null
}

export interface ReturnReasonMapPutResponse {
  saved: number
  items: ReturnReasonMapRow[]
}
