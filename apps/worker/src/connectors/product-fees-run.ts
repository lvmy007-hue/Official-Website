import { FEES_ESTIMATE_FRESHNESS_KEY, FEES_ROLE_PENDING, withAmazonFees, type PricingCalcResult } from '@nova/api-contracts'
import type { Prisma, PrismaClient } from '@prisma/client'
import { recordFreshness } from '../freshness/record'
import { ProductFeesApi, isFeesForbidden, readFeeEstimate } from './product-fees-api'

const NO_PERMISSION = '没有费用预估权限：费用预估接口被拒绝（尚未获批“定价”或“商品刊登”角色）。下面的数字仍按公开费率表估算（模型估算）。'

/** 把费用预估接口的结果写回试算记录。403 记新鲜度为未授权，并成功返回，避免任务死循环重试。 */
export async function runProductFeeEstimate(
  db: Pick<PrismaClient, 'pricingCalcRecord' | 'dataFreshness'>,
  api: Pick<ProductFeesApi, 'estimate'>,
  input: { tenantId: string; sellerAccountId: string; recordId: string; referenceAsin: string; price: number },
) {
  const row = await db.pricingCalcRecord.findFirst({ where: { id: input.recordId, tenantId: input.tenantId } })
  if (!row) return { skipped: true as const, reason: 'RECORD_MISSING' }
  const current = row.resultJson as unknown as PricingCalcResult
  try {
    const payload = await api.estimate(input.referenceAsin, input.price)
    const fees = readFeeEstimate(payload)
    if (fees.status !== 'Success' || (fees.referral === null && fees.fulfillment === null)) {
      const failed: PricingCalcResult = {
        ...current,
        amazon: { state: 'FAILED', message: `费用预估接口没有返回可用结果（${fees.status}）。下面的数字仍按公开费率表估算（模型估算）。`, priceUsed: input.price },
      }
      await db.pricingCalcRecord.update({ where: { id: row.id }, data: { resultJson: failed as unknown as Prisma.InputJsonValue } })
      return { ok: false as const, status: fees.status }
    }
    const next = withAmazonFees(current, fees.referral, fees.fulfillment, input.price)
    await db.pricingCalcRecord.update({ where: { id: row.id }, data: { resultJson: next as unknown as Prisma.InputJsonValue } })
    await recordFreshness(db, { tenantId: input.tenantId, sellerAccountId: input.sellerAccountId, sourceKey: FEES_ESTIMATE_FRESHNESS_KEY, ok: true, rowCount: 1 })
    return { ok: true as const }
  } catch (error) {
    if (!isFeesForbidden(error)) throw error
    await recordFreshness(db, { tenantId: input.tenantId, sellerAccountId: input.sellerAccountId, sourceKey: FEES_ESTIMATE_FRESHNESS_KEY, ok: false, errorCode: FEES_ROLE_PENDING })
    const blocked: PricingCalcResult = { ...current, amazon: { state: 'NO_PERMISSION', message: NO_PERMISSION, priceUsed: input.price } }
    await db.pricingCalcRecord.update({ where: { id: row.id }, data: { resultJson: blocked as unknown as Prisma.InputJsonValue } })
    return { ok: true as const, roleMissing: true }
  }
}
