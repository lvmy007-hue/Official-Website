import { Prisma } from '@prisma/client'
import { ALLOCATION_METHOD_LABEL, type AllocationMethod } from '@nova/api-contracts'

// 头程费用分摊（06 章 6.10）：把运单的实际费用合计按体积、重量、货值或件数分摊到 SKU。纯函数。
// 体积、重量、货值都是“这个 SKU 这批货的合计”；所选口径下任何一个 SKU 缺数据都不分摊（不拿 0 或平均数顶替）。
// 金额精确到 6 位小数；舍入余数全部加到权重最大的 SKU（并列取 SKU 字典序靠前的），保证各行之和恰好等于合计。

export interface AllocationInput {
  sku: string
  quantity: number
  volumeCbm: Prisma.Decimal | number | null
  weightKg: Prisma.Decimal | number | null
  goodsValue: Prisma.Decimal | number | null
}

export interface AllocationLine {
  sku: string
  quantity: number
  amount: Prisma.Decimal
  /** 每件分摊的头程成本，写入成本版本草稿。 */
  unitCost: Prisma.Decimal
}

const MISSING: Record<AllocationMethod, string> = { VOLUME: '体积', WEIGHT: '重量', VALUE: '货值', QTY: '件数' }
const dec = (value: Prisma.Decimal | number | null): Prisma.Decimal | null => (value === null ? null : new Prisma.Decimal(value))

function weightOf(item: AllocationInput, method: AllocationMethod): Prisma.Decimal | null {
  if (method === 'QTY') return new Prisma.Decimal(item.quantity)
  return dec(method === 'VOLUME' ? item.volumeCbm : method === 'WEIGHT' ? item.weightKg : item.goodsValue)
}

/** 某个口径能不能用：缺数据时返回原因（写明缺哪些 SKU），可用返回 null。 */
export function allocationReadiness(items: readonly AllocationInput[], method: AllocationMethod): string | null {
  if (items.length === 0) return '运单没有明细'
  const missing = items.filter(item => weightOf(item, method) === null).map(item => item.sku)
  if (missing.length > 0) return `${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个 SKU` : ''} 没有填写${MISSING[method]}`
  const total = items.reduce((sum, item) => sum.plus(weightOf(item, method) as Prisma.Decimal), new Prisma.Decimal(0))
  return total.gt(0) ? null : `${ALLOCATION_METHOD_LABEL[method]}合计为 0，无法分摊`
}

export function allocateCost(
  items: readonly AllocationInput[],
  method: AllocationMethod,
  total: Prisma.Decimal | number | string,
): { ok: true; lines: AllocationLine[] } | { ok: false; reason: string } {
  const reason = allocationReadiness(items, method)
  if (reason) return { ok: false, reason }
  const amount = new Prisma.Decimal(total)
  const rows = [...items].sort((a, b) => a.sku.localeCompare(b.sku)).map(item => ({ item, weight: weightOf(item, method) as Prisma.Decimal }))
  const weightSum = rows.reduce((sum, row) => sum.plus(row.weight), new Prisma.Decimal(0))
  const lines = rows.map(row => ({ ...row, amount: amount.mul(row.weight).div(weightSum).toDecimalPlaces(6, Prisma.Decimal.ROUND_DOWN) }))
  const remainder = amount.minus(lines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)))
  if (remainder.gt(0)) {
    const heaviest = lines.reduce((best, line) => (line.weight.gt(best.weight) ? line : best), lines[0])
    heaviest.amount = heaviest.amount.plus(remainder)
  }
  return {
    ok: true,
    lines: lines.map(line => ({ sku: line.item.sku, quantity: line.item.quantity, amount: line.amount, unitCost: line.amount.div(line.item.quantity).toDecimalPlaces(6) })),
  }
}
