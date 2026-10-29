import { missingFreightFields, type FillSuggestion, type LinkedInboundView, type QtyCheck } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../../platform/prisma.service'

// 头程预估的缺失字段提示与“三处已发数量”核对（P6-26）。

type ItemLike = { sku: string; quantity: number; weightKg: Prisma.Decimal | number | null; volumeCbm: Prisma.Decimal | number | null }
const num = (value: Prisma.Decimal | number | null) => (value === null ? null : Number(value))
const round4 = (value: number) => Math.round((value + Number.EPSILON) * 10_000) / 10_000

/** 逐个 SKU 找缺的重量或体积，并按商品档案里的单件重量与包装尺寸（厘米）乘数量给出建议值；档案没有就不给建议。 */
export async function loadFillSuggestions(prisma: Pick<PrismaService, 'fbaProduct'>, tenantId: string, items: readonly ItemLike[]): Promise<FillSuggestion[]> {
  const missing = missingFreightFields(items.map(item => ({ sku: item.sku, quantity: item.quantity, weightKg: num(item.weightKg), volumeCbm: num(item.volumeCbm) })))
  if (missing.length === 0) return []
  const products = await prisma.fbaProduct.findMany({
    where: { tenantId, sellerSku: { in: missing.map(row => row.sku) } },
    select: { sellerSku: true, packageLengthCm: true, packageWidthCm: true, packageHeightCm: true, packageWeightKg: true },
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  })
  const quantity = new Map(items.map(item => [item.sku, item.quantity]))
  return missing.map(row => {
    const qty = quantity.get(row.sku) ?? 0
    const product = products.find(candidate => candidate.sellerSku === row.sku)
    const unitKg = product?.packageWeightKg ? Number(product.packageWeightKg) : null
    const dims = product ? [product.packageLengthCm, product.packageWidthCm, product.packageHeightCm].map(value => (value ? Number(value) : null)) : []
    const unitCbm = dims.length === 3 && dims.every(value => value !== null && value > 0) ? (dims as number[]).reduce((product3, value) => product3 * value, 1) / 1_000_000 : null
    return {
      ...row,
      suggestedWeightKg: row.missing.includes('WEIGHT') && unitKg !== null && unitKg > 0 ? round4(unitKg * qty) : null,
      suggestedVolumeCbm: row.missing.includes('VOLUME') && unitCbm !== null ? round4(unitCbm * qty) : null,
    }
  })
}

/**
 * 三处“已发数量”：国内仓出库流水合计、运单明细合计、关联入仓货件的已发合计。
 * 没关联货件、关联的货件没同步到或没有明细时不下结论；出库流水与明细都有时必须相等（出库按明细一条条记，不等说明有人改过流水）。
 */
export function qtyCheckOf(input: { firstMileUnits: number; outboundUnits: number | null; linked: readonly LinkedInboundView[] }): QtyCheck {
  const { firstMileUnits, outboundUnits, linked } = input
  const base = { firstMileUnits, outboundUnits }
  if (linked.length === 0) return { ...base, state: 'NOT_LINKED', inboundShippedUnits: null, note: '没有关联入仓货件，无法核对已发数量；在“编辑”里填写亚马逊入仓货件编号后可核对。' }
  if (linked.some(row => row.shippedUnits === null)) {
    return { ...base, state: 'INCOMPLETE', inboundShippedUnits: null, note: '关联的入仓货件有的还没同步到或没有发货明细，暂不能核对。' }
  }
  const inboundShippedUnits = linked.reduce((sum, row) => sum + (row.shippedUnits ?? 0), 0)
  const outboundOk = outboundUnits === null || outboundUnits === firstMileUnits
  const match = outboundOk && inboundShippedUnits === firstMileUnits
  return {
    ...base,
    state: match ? 'MATCH' : 'MISMATCH',
    inboundShippedUnits,
    note: match
      ? '运单明细、国内仓出库与关联入仓货件的已发数量一致。'
      : `三处数量对不上：运单明细 ${firstMileUnits}${outboundUnits === null ? '' : `、国内仓出库 ${outboundUnits}`}、入仓货件已发 ${inboundShippedUnits}。一张入仓货件可能分多张运单发出，请结合运单对照。`,
  }
}
