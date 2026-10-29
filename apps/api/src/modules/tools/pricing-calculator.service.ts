import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  FEES_ESTIMATE_FRESHNESS_KEY,
  PRICING_CALC_ACTIONS,
  PRICING_CALC_CACHE_MS,
  PRICING_CALC_RATE_PER_MINUTE,
  PRICING_FEE_ESTIMATE_JOB,
  TOOLS_READ,
  PricingEstimateBodySchema,
  PricingRecordQuerySchema,
  PricingSaveBodySchema,
  estimateFromRateCard,
  pricingInputCanonical,
  type PricingCalcResult,
  type PricingEstimateBody,
  type PricingEstimateView,
  type PricingInput,
  type PricingRecordList,
  type PricingRecordRow,
} from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'

const MINUTE = 60_000

const NO_STORE = '未选择店铺，无法调用费用预估接口。下面的佣金与配送费按公开费率表估算（模型估算）。'
const NO_ASIN = '没有参考 ASIN。未上架的新品官方费用预估接口无法计算，已按公开费率表估算（模型估算）。'
const NO_PERMISSION = '没有费用预估权限：这家店的卖家接口尚未获批“定价”或“商品刊登”角色，费用预估接口被拒绝。下面的数字按公开费率表估算（模型估算）。'
const NO_CONNECTION = '这家店没有已授权的卖家接口连接，无法调用费用预估接口。下面的数字按公开费率表估算（模型估算）。'
const QUEUED = '已提交费用预估。完成后再次用同样参数试算即可看到接口结果。当前数字按公开费率表估算（模型估算）。'

const round2 = (value: number) => Math.round(value * 100) / 100
const asResult = (value: Prisma.JsonValue): PricingCalcResult => value as unknown as PricingCalcResult
const json = (value: unknown) => value as Prisma.InputJsonValue

const normalize = (body: PricingEstimateBody): PricingInput => ({
  purchaseCost: round2(body.purchaseCost),
  firstMile: { method: body.firstMile.method, unitPrice: body.firstMile.method === 'NONE' ? 0 : round2(body.firstMile.unitPrice) },
  lengthCm: round2(body.lengthCm * 10) / 10,
  widthCm: round2(body.widthCm * 10) / 10,
  heightCm: round2(body.heightCm * 10) / 10,
  weightG: Math.round(body.weightG),
  category: body.category,
  prices: [...new Set(body.prices.map(round2))].sort((a, b) => a - b),
  referenceAsin: body.referenceAsin ?? null,
  storeId: body.storeId ?? null,
})

/** 排队超过这段时间还没有回写，视为任务丢了，不再复用，下次试算重新排队。 */
const QUEUED_REUSE_MS = 15 * MINUTE

/** 失败、没有权限、没有连接的结果不复用 24 小时：授权或连接恢复后应能立刻重试。 */
function isReusable(row: { resultJson: Prisma.JsonValue; estimatedAt: Date }, now: Date): boolean {
  const state = asResult(row.resultJson)?.amazon?.state
  if (state === 'FAILED' || state === 'NO_PERMISSION' || state === 'NO_CONNECTION') return false
  if (state === 'QUEUED') return now.getTime() - row.estimatedAt.getTime() <= QUEUED_REUSE_MS
  return true
}

type RecordRow = {
  id: string
  name: string | null
  saved: boolean
  estimatedAt: Date
  createdBy: string
  resultJson: Prisma.JsonValue
}

/** 新品定价试算（P6-29）：费率表现算，有参考 ASIN 且店铺已授权时再排队打费用预估接口。 */
@Injectable()
export class PricingCalculatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly queue: QueueService,
    private readonly audit: AuditWriter,
  ) {}

  async estimate(req: RequestWithContext, rawBody: unknown): Promise<PricingEstimateView> {
    const { context, scope } = await this.context.authorizeScoped(req, TOOLS_READ, {})
    const input = normalize(PricingEstimateBodySchema.parse(rawBody))
    if (input.storeId) assertStoreInScope(scope, input.storeId)
    const tenantId = context.tenantId
    const inputHash = createHash('sha256').update(pricingInputCanonical(input)).digest('hex')
    const now = new Date()
    const candidates = await this.prisma.pricingCalcRecord.findMany({
      where: { tenantId, inputHash, estimatedAt: { gte: new Date(now.getTime() - PRICING_CALC_CACHE_MS) } },
      orderBy: { estimatedAt: 'desc' },
      take: 20,
    })
    const reusable = candidates.filter(row => isReusable(row, now))
    const mine = reusable.find(row => row.createdBy === context.userId)
    if (mine) return this.view(mine, context.userId, true)
    const theirs = reusable[0]
    if (theirs) {
      // 别人 24 小时内算过同样参数：复用结果，但给本人复制一行（保留原时间，不占本分钟的新参数额度），这样才能保存成“我的记录”。
      const copy = await this.prisma.pricingCalcRecord.create({
        data: { tenantId, inputHash, inputJson: json(theirs.inputJson), resultJson: json(theirs.resultJson), estimatedAt: theirs.estimatedAt, createdBy: context.userId, saved: false },
      })
      return this.view(copy, context.userId, true)
    }
    const recent = await this.prisma.pricingCalcRecord.count({ where: { tenantId, estimatedAt: { gte: new Date(now.getTime() - MINUTE) } } })
    if (recent >= PRICING_CALC_RATE_PER_MINUTE) throw appError('RATE_LIMITED', '试算过于频繁，请一分钟后再试。同样参数在 24 小时内会直接复用，不计入次数。')
    const plan = await this.plan(tenantId, input)
    let result = estimateFromRateCard(input, plan)
    const row = await this.prisma.pricingCalcRecord.create({
      data: { tenantId, inputHash, inputJson: json(input), resultJson: json(result), estimatedAt: now, createdBy: context.userId, saved: false },
    })
    if (plan.state === 'QUEUED' && plan.jobId === undefined && input.storeId && input.referenceAsin) {
      result = await this.enqueue(req, tenantId, input.storeId, input.referenceAsin, input.prices[0] ?? 0, row.id, result)
    }
    return this.view({ ...row, resultJson: result as unknown as Prisma.JsonValue }, context.userId, false)
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<PricingRecordList> {
    const { context } = await this.context.authorizeScoped(req, TOOLS_READ, rawQuery)
    const query = PricingRecordQuerySchema.parse(rawQuery)
    const where = { tenantId: context.tenantId, createdBy: context.userId, saved: true }
    const [total, rows] = await Promise.all([
      this.prisma.pricingCalcRecord.count({ where }),
      this.prisma.pricingCalcRecord.findMany({
        where,
        orderBy: { estimatedAt: query.sort.dir },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ])
    return { items: rows.map(rowOf), total, page: query.page, pageSize: query.pageSize }
  }

  async save(req: RequestWithContext, rawBody: unknown): Promise<PricingRecordRow> {
    const { context } = await this.context.authorizeScoped(req, TOOLS_READ, {})
    const body = PricingSaveBodySchema.parse(rawBody)
    const existing = await this.prisma.pricingCalcRecord.findFirst({ where: { id: body.id, tenantId: context.tenantId, createdBy: context.userId } })
    if (!existing) throw appError('RESOURCE_NOT_FOUND', '找不到这条试算，或它不是你提交的')
    const row = await this.prisma.pricingCalcRecord.update({ where: { id: existing.id }, data: { saved: true, ...(body.name ? { name: body.name } : {}) } })
    await this.audit.record(req, { action: PRICING_CALC_ACTIONS.saved, resourceType: 'PricingCalcRecord', resourceId: row.id })
    return rowOf(row)
  }

  private async plan(tenantId: string, input: PricingInput): Promise<PricingCalcResult['amazon']> {
    if (!input.storeId) return { state: 'NOT_REQUESTED', message: NO_STORE }
    if (!input.referenceAsin) return { state: 'NOT_REQUESTED', message: NO_ASIN }
    const blocked = await this.prisma.dataFreshness.findFirst({
      where: { tenantId, sellerAccountId: input.storeId, sourceKey: FEES_ESTIMATE_FRESHNESS_KEY, status: 'UNAUTHORIZED' },
      select: { id: true },
    })
    if (blocked) return { state: 'NO_PERMISSION', message: NO_PERMISSION }
    const connection = await this.prisma.platformConnection.findFirst({
      where: { tenantId, sellerAccountId: input.storeId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED' },
      select: { id: true },
    })
    if (!connection) return { state: 'NO_CONNECTION', message: NO_CONNECTION }
    return { state: 'QUEUED', message: QUEUED, priceUsed: input.prices[0] }
  }

  private async enqueue(req: RequestWithContext, tenantId: string, storeId: string, referenceAsin: string, price: number, recordId: string, result: PricingCalcResult): Promise<PricingCalcResult> {
    const connection = await this.prisma.platformConnection.findFirst({
      where: { tenantId, sellerAccountId: storeId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED' },
      select: { id: true },
    })
    if (!connection) return { ...result, amazon: { state: 'NO_CONNECTION', message: NO_CONNECTION } }
    const meta = syncJobMeta(connection.id, PRICING_FEE_ESTIMATE_JOB, [recordId])
    const job = await this.prisma.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: PRICING_FEE_ESTIMATE_JOB,
        status: 'PENDING',
        requestId: req.requestId,
        context: { recordId, referenceAsin, price },
        domain: meta.domain,
        sourceKey: meta.sourceKey,
        priority: meta.priority,
      },
    })
    try {
      await this.queue.add('sync', { tenantId, syncJobId: job.id, requestId: req.requestId }, job.id, { type: PRICING_FEE_ESTIMATE_JOB, priority: meta.priority })
    } catch {
      const failed = { ...result, amazon: { state: 'FAILED' as const, message: '费用预估任务没能排上队。下面的数字仍按公开费率表估算（模型估算）。', priceUsed: price } }
      await this.prisma.pricingCalcRecord.update({ where: { id: recordId }, data: { resultJson: json(failed) } })
      return failed
    }
    const queued = { ...result, amazon: { state: 'QUEUED' as const, message: QUEUED, jobId: job.id, priceUsed: price } }
    await this.prisma.pricingCalcRecord.update({ where: { id: recordId }, data: { resultJson: json(queued) } })
    return queued
  }

  private view(row: RecordRow, userId: string, reused: boolean): PricingEstimateView {
    return {
      id: row.id,
      reused,
      canSave: row.createdBy === userId && !row.saved,
      saved: row.saved,
      name: row.name,
      estimatedAt: row.estimatedAt.toISOString(),
      result: asResult(row.resultJson),
    }
  }
}

function rowOf(row: { id: string; name: string | null; saved: boolean; estimatedAt: Date; resultJson: Prisma.JsonValue }): PricingRecordRow {
  const result = asResult(row.resultJson)
  const first = result?.scenarios?.[0]
  return {
    id: row.id,
    name: row.name,
    saved: row.saved,
    estimatedAt: row.estimatedAt.toISOString(),
    price: first?.price ?? null,
    profit: first?.profit ?? null,
    margin: first?.margin ?? null,
    currency: 'USD',
    amazonState: result?.amazon?.state ?? null,
  }
}
