import { LISTING_WRITE_JOB, PRICING_AUTO_SWITCH, PRICING_UPDATE_SWITCH, priceChangeText } from '@nova/api-contracts'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { Prisma, PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import type { QueueRegistry } from '../runtime/queues'

// 定价规则的自动执行（P4-11）：自动模式命中的 SKU 提交改价（ListingWriteRun kind=PRICE_PATCH，来源 RULE_AUTO），之后与手动改价走同一条写流程。
// 提交前的检查：改价开关（sw.pricing.update）与规则自动执行开关（sw.pricing.rule.auto）都打开、店铺有可用的卖家授权、SKU 有商品类型。
// 任何一项不满足都不提交，返回原因（调用方把原因记进执行记录，规则降级为生成建议，不当成失败重试）。
// 自动执行不做校验预览（预览要等亚马逊异步返回，规则每小时才评估一次）：提交时亚马逊同步返回 INVALID 的会被标为失败并计入熔断的连续失败次数（CR-086 披露）。

export type AutoPriceResult = { status: 'QUEUED'; runId: string } | { status: 'SKIPPED'; reason: string } | { status: 'FAILED'; reason: string; runId: string }

export interface AutoPriceDeps {
  db: PrismaClient
  queues: Pick<QueueRegistry, 'addSync'>
}
export interface AutoPriceInput {
  tenantId: string
  sellerAccountId: string
  sku: string
  asin: string
  productType: string | null
  price: number
  currency: string
  previousPrice: number
  ruleRunId: string
  requestId: string
}

/** 两个开关是否都打开；返回未打开的开关。 */
export async function offSwitches(db: PrismaClient, tenantId: string): Promise<string[]> {
  const keys = [PRICING_UPDATE_SWITCH, PRICING_AUTO_SWITCH]
  const on = await db.integrationSwitch.findMany({ where: { tenantId, switchKey: { in: keys }, sellerAccountId: null, enabled: true }, select: { switchKey: true }, take: keys.length })
  return keys.filter(key => !on.some(row => row.switchKey === key))
}

export async function submitAutoPrice(deps: AutoPriceDeps, input: AutoPriceInput): Promise<AutoPriceResult> {
  const { db, queues } = deps
  const { tenantId, sellerAccountId } = input
  if (!input.productType) return { status: 'SKIPPED', reason: '没有这个商品的商品类型（刊登同步尚未读到它），没有提交' }
  const off = await offSwitches(db, tenantId)
  if (off.length > 0) return { status: 'SKIPPED', reason: `写入开关未打开（${off.join('、')}），已改为生成建议` }
  const connection = await db.platformConnection.findFirst({
    where: { tenantId, provider: 'AMAZON_SP_API', sellerAccountId, state: 'AUTHORIZED', encryptedRefreshToken: { not: null } },
    select: { id: true },
  })
  if (!connection) return { status: 'SKIPPED', reason: '店铺没有可用的卖家授权，没有提交' }

  const made = await db.$transaction(async tx => {
    const run = await tx.listingWriteRun.create({
      data: {
        tenantId,
        sellerAccountId,
        kind: 'PRICE_PATCH',
        sellerSku: input.sku,
        productType: input.productType,
        requestJson: {
          sku: input.sku,
          asin: input.asin,
          price: input.price,
          currency: input.currency,
          previousPrice: input.previousPrice,
          source: 'RULE_AUTO',
          ruleRunId: input.ruleRunId,
        } as Prisma.InputJsonValue,
        requestHash: createHash('sha256')
          .update(priceChangeText(input.sku, input.productType!, input.price, input.currency))
          .digest('hex'),
        status: 'PENDING',
        requestId: input.requestId,
      },
      select: { id: true },
    })
    const job = await tx.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: LISTING_WRITE_JOB,
        status: 'PENDING',
        requestId: input.requestId,
        context: { listingRunId: run.id },
        domain: syncDomainOf(LISTING_WRITE_JOB),
        sourceKey: syncSourceKey(connection.id, LISTING_WRITE_JOB, run.id),
        priority: PRIORITY.SCHEDULED,
      },
      select: { id: true },
    })
    await tx.listingWriteRun.update({ where: { id: run.id }, data: { syncJobId: job.id } })
    return { runId: run.id, jobId: job.id }
  })
  try {
    await queues.addSync(LISTING_WRITE_JOB, { tenantId, syncJobId: made.jobId, requestId: input.requestId, listingRunId: made.runId }, { jobId: made.jobId, priority: PRIORITY.SCHEDULED })
  } catch {
    const now = new Date()
    await db.listingWriteRun.updateMany({ where: { id: made.runId, tenantId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
    await db.syncJob.updateMany({ where: { id: made.jobId, tenantId }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
    return { status: 'FAILED', reason: '任务队列暂时不可用，本次改价已记为失败', runId: made.runId }
  }
  return { status: 'QUEUED', runId: made.runId }
}
