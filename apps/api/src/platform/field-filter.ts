import { canSeeField, type FieldKey } from '@nova/authz'

// 字段级敏感权限的过滤（P1-13，依据 freeze/permissions.md 第三节）。
// 没有对应字段权限时，字段在响应与导出中一律不出现——不是显示为空，是键根本不存在。
// 规则用路径描述：'summary.cogs'、'lines[].unitCost'（数组每个元素）、'[].totalAmount'（根是数组）。

export type FieldRules = Partial<Record<FieldKey, readonly string[]>>

function toSegments(path: string): string[] {
  return path.split('.').flatMap(part => (part.endsWith('[]') && part.length > 2 ? [part.slice(0, -2), '[]'] : [part]))
}

// 写时复制：只复制路径经过的对象，其余原样引用（不破坏小数、日期等实例）。
function omit(value: unknown, segments: readonly string[]): unknown {
  if (segments.length === 0) return value
  const [head, ...rest] = segments
  if (head === '[]') return Array.isArray(value) ? value.map(item => omit(item, rest)) : value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const object = value as Record<string, unknown>
  if (!(head in object)) return value
  if (rest.length === 0) {
    const { [head]: _removed, ...others } = object
    return others
  }
  return { ...object, [head]: omit(object[head], rest) }
}

/** 按成员的字段权限，剔除其无权查看的字段。 */
export function stripSensitiveFields<T>(data: T, permissions: readonly string[], rules: FieldRules): T {
  let result: unknown = data
  for (const [field, paths] of Object.entries(rules) as [FieldKey, readonly string[]][]) {
    if (canSeeField(permissions, field)) continue
    for (const path of paths) result = omit(result, toSegments(path))
  }
  return result as T
}

export interface ExportColumn {
  key: string
  title: string
  /** 该列属于哪类敏感字段；没有字段权限的发起人，文件里不出现这一列。 */
  field?: FieldKey
}

/** 导出：按发起人的字段权限确定列。导出任务执行时必须用发起人当时的权限重新计算。 */
export function visibleColumns<T extends ExportColumn>(columns: readonly T[], permissions: readonly string[]): T[] {
  return columns.filter(column => !column.field || canSeeField(permissions, column.field))
}

// ---- 各业务对象的敏感字段登记（新增返回敏感字段的接口必须在这里登记）----

/** 利润分析：利润类字段属 field.profit，成本类字段属 field.cost。 */
export const PROFIT_FIELD_RULES: FieldRules = {
  profit: ['summary.netProfit', 'summary.margin', 'bySku[].grossProfit', 'bySku[].margin'],
  cost: ['summary.cogs', 'bySku[].unitCost', 'bySku[].cogs', 'coverage'],
}

/** 采购单：单价与金额属 field.cost。 */
export const PURCHASE_ORDER_FIELD_RULES: FieldRules = {
  cost: ['[].totalAmount', '[].lines[].unitCost'],
}

/** 采购单（单条返回）。 */
export const PURCHASE_ORDER_ONE_FIELD_RULES: FieldRules = {
  cost: ['totalAmount', 'lines[].unitCost'],
}

// P2a-10：采购单列表与详情、供应商详情、国内仓库存与流水。金额、单价、成本差异、报价历史、货值都属 field.cost。
export const PURCHASE_ORDER_LIST_RULES: FieldRules = { cost: ['items[].totalAmount', 'items[].paidAmount'] }
export const PURCHASE_ORDER_DETAIL_RULES: FieldRules = {
  cost: ['order.totalAmount', 'order.paidAmount', 'lines[].unitCost', 'lines[].lineAmount', 'lines[].costDiff', 'payments[].amount', 'links.costVersions[].unitProductCost'],
}
export const SUPPLIER_DETAIL_RULES: FieldRules = { cost: ['products[].quotes', 'purchaseOrders[].totalAmount', 'purchaseOrders[].paidAmount'] }
export const WAREHOUSE_STOCK_RULES: FieldRules = { cost: ['items[].value', 'items[].valueCurrency', 'items[].valueNote'] }
export const WAREHOUSE_MOVEMENT_RULES: FieldRules = { cost: ['items[].unitCost', 'items[].currency'] }

// P2a-11：头程运单。预估与实际费用、费用明细、分摊结果、明细货值都属 field.cost。
export const FIRST_MILE_LIST_RULES: FieldRules = { cost: ['items[].estimatedCost', 'items[].actualCost', 'items[].deviationPct'] }
export const FIRST_MILE_DETAIL_RULES: FieldRules = {
  cost: ['shipment.estimatedCost', 'shipment.actualCost', 'shipment.deviationPct', 'items[].goodsValue', 'costs', 'allocation', 'allocationReady'],
}
// P6-26：渠道报价与头程预估金额属 field.cost；没有权限时报价单价、预估金额不返回（重量、体积重、缺失项仍可看）。
export const CARRIER_RATE_RULES: FieldRules = { cost: ['items[].unitPrice'] }
export const FREIGHT_ESTIMATE_RULES: FieldRules = { cost: ['estimate.amount', 'estimate.tier.unitPrice'] }
