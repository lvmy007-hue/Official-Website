import { FxCostDataSchema } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { parseOnboardingState } from '../lifecycle'

// 国内仓的取用与可退数量。收货、退货、盘点共用。
type StockClient = Pick<Prisma.TransactionClient, 'warehouse' | 'tenantOnboarding' | 'inventoryMovement'>

/**
 * 取收货用的国内仓：显式给了就校验它是本租户有效的国内仓；没给就取第一个有效国内仓；
 * 一个都没有时自动建一个“默认国内仓”，计价方法沿用初始化向导里选的成本口径（没选过则为移动加权平均）。
 */
export async function resolveDomesticWarehouse(tx: StockClient, tenantId: string, warehouseId?: string): Promise<{ id: string; name: string } | null> {
  if (warehouseId) return tx.warehouse.findFirst({ where: { id: warehouseId, tenantId, kind: 'DOMESTIC', status: 'ACTIVE' }, select: { id: true, name: true } })
  const existing = await tx.warehouse.findFirst({ where: { tenantId, kind: 'DOMESTIC', status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true } })
  if (existing) return existing
  const onboarding = await tx.tenantOnboarding.findFirst({ where: { tenantId }, select: { stepStateJson: true } })
  const parsed = FxCostDataSchema.safeParse(parseOnboardingState(onboarding?.stepStateJson).steps.FX_COST.data)
  return tx.warehouse.create({
    data: { tenantId, code: 'CN-MAIN', name: '默认国内仓', countryCode: 'CN', kind: 'DOMESTIC', costMethod: parsed.success ? parsed.data.costMethod : 'WEIGHTED_AVERAGE' },
    select: { id: true, name: true },
  })
}

/** 某仓某 SKU 当前可用数量（在库 − 占用）。 */
export async function availableQty(tx: Pick<Prisma.TransactionClient, 'inventoryMovement'>, tenantId: string, warehouseId: string, sellerSku: string): Promise<number> {
  const sum = await tx.inventoryMovement.aggregate({ where: { tenantId, warehouseId, sellerSku }, _sum: { quantity: true, lockedForShipment: true } })
  return (sum._sum.quantity ?? 0) - (sum._sum.lockedForShipment ?? 0)
}
