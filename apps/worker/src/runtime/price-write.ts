import { PRICE_RUN_KINDS } from '@nova/api-contracts'
import type { ListingWriteRun, PrismaClient } from '@prisma/client'

// 改价写入的公共部分（P4-11）：改价复用刊登写入记录（kind = PRICE_VALIDATE / PRICE_PATCH），请求内容固定为
//   { sku, price, currency, previousPrice, asin, source: 'MANUAL' | 'RULE_SUGGESTION' | 'RULE_AUTO', ruleRunId? }
// 校验预览不改亚马逊的数据；正式提交成功后写一条“已提交”价格快照（之后的同步以真实报价为准），并把关联的规则执行记录标为已执行。

export const isPriceKind = (kind: string): boolean => (PRICE_RUN_KINDS as readonly string[]).includes(kind)

export interface PriceBody {
  price: number
  currency: string
  asin: string
  source: string
  ruleRunId: string | null
}
export function priceBodyOf(value: unknown): PriceBody | null {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const price = typeof body.price === 'number' ? body.price : Number.NaN
  if (!Number.isFinite(price) || price <= 0) return null
  return {
    price,
    currency: typeof body.currency === 'string' && body.currency ? body.currency : 'USD',
    asin: typeof body.asin === 'string' ? body.asin : '',
    source: typeof body.source === 'string' ? body.source : 'MANUAL',
    ruleRunId: typeof body.ruleRunId === 'string' && body.ruleRunId ? body.ruleRunId : null,
  }
}

/** 正式提交成功：流程重放时只回写一次（以状态原子认领为准）。 */
export async function recordPriceSuccess(prisma: PrismaClient, run: ListingWriteRun, now: Date): Promise<void> {
  const body = priceBodyOf(run.requestJson)
  await prisma.$transaction(async tx => {
    const claimed = await tx.listingWriteRun.updateMany({
      where: { id: run.id, tenantId: run.tenantId, status: { not: 'SUCCEEDED' } },
      data: { status: 'SUCCEEDED', failureCode: null, finishedAt: now },
    })
    if (claimed.count === 0) return
    if (body && run.sellerSku) {
      await tx.priceSnapshot.createMany({
        data: [
          {
            tenantId: run.tenantId,
            sellerAccountId: run.sellerAccountId,
            marketplaceId: 'ATVPDKIKX0DER',
            sellerSku: run.sellerSku,
            asin: body.asin,
            price: body.price,
            currency: body.currency,
            source: 'WRITE_SUBMITTED',
            observedAt: now,
          },
        ],
        skipDuplicates: true,
      })
    }
    await tx.pricingRuleRun.updateMany({ where: linkOf(run.tenantId, run.id, body?.ruleRunId ?? null), data: { outcome: 'APPLIED', executed: true, message: '亚马逊已受理这次改价' } })
  })
}

/** 规则执行记录与写入记录的关联：既按写入编号找，也按请求里带的执行记录编号找（提交时两边的编号回写有先后，哪个先到都能对上）。 */
const linkOf = (tenantId: string, runId: string, ruleRunId: string | null) => ({
  tenantId,
  outcome: 'QUEUED',
  OR: [{ writeRunId: runId }, ...(ruleRunId ? [{ id: ruleRunId }] : [])],
})

/** 永久失败：关联的规则执行记录同步标为失败（页面不再显示“等待亚马逊确认”）。 */
export async function markPriceRunFailed(db: PrismaClient, tenantId: string, runId: string, code: string): Promise<void> {
  const run = await db.listingWriteRun.findFirst({ where: { id: runId, tenantId }, select: { requestJson: true } })
  await db.pricingRuleRun.updateMany({ where: linkOf(tenantId, runId, priceBodyOf(run?.requestJson)?.ruleRunId ?? null), data: { outcome: 'FAILED', message: `改价失败（${code}）` } })
}
