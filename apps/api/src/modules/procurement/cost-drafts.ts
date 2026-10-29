import { Prisma } from '@prisma/client'

// 收货完成后自动生成成本版本草稿（06 章 6.7）：每个 SKU 一条，单价取该采购单已收数量加权的平均采购单价。
// 草稿只记产品成本；头程与其他成本留空表示“尚未分摊”（P2a-11 写入头程分摊），生效与替换由商品成本页面（P2b-14）负责。
// 同一采购单的同一 SKU 只会生成一次（唯一键 + 先查后建），重复调用不会产生重复版本。

export interface CostLine {
  sellerSku: string
  receivedQuantity: number
  unitCost: Prisma.Decimal | null
  currency: string
}

export interface CostDraft {
  sku: string
  unitProductCost: Prisma.Decimal
  currency: string
}

/** 按 SKU 合并：只用有单价且已收数量大于 0 的行；同一 SKU 出现多种币种时按第一种币种、跳过其余。 */
export function costDraftsOf(lines: readonly CostLine[]): CostDraft[] {
  const groups = new Map<string, { currency: string; qty: number; amount: Prisma.Decimal }>()
  for (const line of lines) {
    if (line.unitCost === null || line.receivedQuantity <= 0) continue
    const group = groups.get(line.sellerSku) ?? { currency: line.currency, qty: 0, amount: new Prisma.Decimal(0) }
    if (group.currency !== line.currency) continue
    group.qty += line.receivedQuantity
    group.amount = group.amount.plus(line.unitCost.mul(line.receivedQuantity))
    groups.set(line.sellerSku, group)
  }
  return [...groups.entries()].map(([sku, group]) => ({ sku, currency: group.currency, unitProductCost: group.amount.div(group.qty).toDecimalPlaces(6) }))
}

type Tx = Pick<Prisma.TransactionClient, 'costVersion'>

/** 为采购单生成缺少的成本版本草稿，返回新建的条数。 */
export async function ensureCostDrafts(tx: Tx, input: { tenantId: string; purchaseOrderId: string; effectiveFrom: Date; lines: readonly CostLine[] }): Promise<number> {
  const drafts = costDraftsOf(input.lines)
  let created = 0
  for (const draft of drafts) {
    const exists = await tx.costVersion.findFirst({ where: { tenantId: input.tenantId, source: 'PURCHASE_RECEIPT', sourceDocId: input.purchaseOrderId, sku: draft.sku }, select: { id: true } })
    if (exists) continue
    const latest = await tx.costVersion.findFirst({ where: { tenantId: input.tenantId, sku: draft.sku }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
    await tx.costVersion.create({
      data: {
        tenantId: input.tenantId,
        sku: draft.sku,
        versionNo: (latest?.versionNo ?? 0) + 1,
        effectiveFrom: input.effectiveFrom,
        currency: draft.currency,
        unitProductCost: draft.unitProductCost,
        source: 'PURCHASE_RECEIPT',
        status: 'DRAFT',
        sourceDocId: input.purchaseOrderId,
      },
    })
    created += 1
  }
  return created
}
