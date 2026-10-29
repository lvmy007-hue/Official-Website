import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  PRICE_RUN_KIND_LABEL,
  PRICING_PRICE_WRITE,
  PRICING_SUBMITTED_ACTIONS,
  PRICING_UPDATE_SWITCH,
  PriceUpdateBodySchema,
  PriceValidateBodySchema,
  checkGuardrails,
  priceChangeText,
  type GuardrailViolation,
  type PriceRunKind,
  type PriceWriteSubmitResponse,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService, AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService, type ResolvedScope } from '../auth'
import { ListingJobService, listingRunViewOf } from '../listings'
import { keyOf, loadGuardrails, loadLatestPrices, loadProducts, loadUnits, num, unitOf, type ProductRow } from './pricing-load'
import { limitsOf } from './pricing-rows'

const json = (value: unknown) => value as Prisma.InputJsonValue
const PREVIEW_HOURS_TEXT = '30 分钟'
const priceHash = (sku: string, productType: string, price: number, currency: string) =>
  createHash('sha256')
    .update(priceChangeText(sku, productType, price, currency))
    .digest('hex')

interface Target {
  product: ProductRow
  productType: string
  asin: string
  currentPrice: number | null
  currency: string
  violations: GuardrailViolation[]
}

/** 改价写入口（05 章 5.5）：先校验预览，再提交。顺序：权限 → 参数（422）→ 店铺在范围内（403）→ 动作守卫（权限、卖家连接、开关）→ 商品、护栏与预览令牌（409/422）→ 事务内建记录、任务并写审计 → 提交后登记流程并入队。亚马逊的调用都在后台任务里。 */
@Injectable()
export class PricingWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly audit: AuditWriter,
    private readonly jobs: ListingJobService,
  ) {}

  private async assertStore(tenantId: string, storeId: string): Promise<void> {
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: storeId, tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
  }

  private async target(context: ApiContext, scope: ResolvedScope, storeId: string, sku: string, given: string | undefined, price: number): Promise<Target> {
    assertStoreInScope(scope, storeId)
    const { rows } = await loadProducts(this.prisma, context.tenantId, scope, { storeId, sku })
    const product = rows[0]
    if (!product) throw appError('RESOURCE_NOT_FOUND', '商品不存在')
    const snapshot =
      given || product.productType
        ? null
        : await this.prisma.listingSnapshot.findFirst({ where: { tenantId: context.tenantId, sellerAccountId: storeId, sellerSku: sku, productType: { not: null } }, select: { productType: true } })
    const productType = given ?? product.productType ?? snapshot?.productType ?? ''
    if (!productType) throw appError('VALIDATION_FAILED', `SKU「${sku}」还没有同步到商品类型，请填写商品类型`, { fieldErrors: { productType: ['请填写商品类型'] } })
    const [prices, guardrails, units] = await Promise.all([
      loadLatestPrices(this.prisma, context.tenantId, [storeId], new Date(), sku),
      loadGuardrails(this.prisma, context.tenantId, [storeId]),
      loadUnits(this.prisma, context.tenantId, scope, new Date(), sku),
    ])
    const current = prices.get(keyOf(storeId, sku))
    const asin = product.asin || current?.asin || ''
    const limits = limitsOf(guardrails, { storeId, sku, asin, productType })
    // 护栏在服务端强制执行，与字段权限无关（利润率只用于判断，不返回给没有利润权限的人）。
    const violations = limits ? checkGuardrails({ price, currentPrice: current?.price ?? null, limits, unit: unitOf(units, keyOf(storeId, sku)) }) : []
    return { product, productType, asin, currentPrice: current?.price ?? null, currency: current?.currency ?? 'USD', violations }
  }

  private blocked(target: Target): never {
    throw appError('VALIDATION_FAILED', `价格没有通过护栏：${target.violations.map(item => item.text).join('；')}`, {
      details: { code: 'GUARDRAIL_BLOCKED', violations: target.violations.map(item => item.code).join(',') },
    })
  }

  private async view(tenantId: string, runId: string): Promise<PriceWriteSubmitResponse['run']> {
    const run = await this.prisma.listingWriteRun.findFirstOrThrow({ where: { id: runId, tenantId } })
    const [store, users] = await Promise.all([
      this.prisma.sellerAccount.findFirst({ where: { id: run.sellerAccountId, tenantId }, select: { displayName: true } }),
      memberNames(this.prisma, tenantId, [run.requestedBy]),
    ])
    const view = listingRunViewOf(run, { stores: new Map([[run.sellerAccountId, store?.displayName ?? '']]), users }, new Date())
    return { ...view, kindLabel: PRICE_RUN_KIND_LABEL[run.kind as PriceRunKind] ?? view.kindLabel }
  }

  private async submit(
    req: RequestWithContext,
    context: ApiContext,
    input: {
      kind: PriceRunKind
      storeId: string
      connectionId: string
      sku: string
      productType: string
      requestJson: Record<string, unknown>
      requestHash: string
      previewRunId?: string
      ruleRunId?: string
      writesAmazon: boolean
    },
  ): Promise<PriceWriteSubmitResponse> {
    const { run, job } = await this.prisma.$transaction(async tx => {
      const created = await tx.listingWriteRun.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: input.storeId,
          kind: input.kind,
          sellerSku: input.sku,
          productType: input.productType,
          requestJson: json(input.requestJson),
          requestHash: input.requestHash,
          previewRunId: input.previewRunId ?? null,
          itemCount: 1,
          status: 'PENDING',
          requestedBy: context.userId,
          requestId: req.requestId,
        },
      })
      const queued = await this.jobs.createJob(tx, { tenantId: context.tenantId, connectionId: input.connectionId, requestId: req.requestId, runId: created.id })
      await tx.listingWriteRun.update({ where: { id: created.id }, data: { syncJobId: queued.id } })
      if (input.ruleRunId) {
        const linked = await tx.pricingRuleRun.updateMany({
          where: { id: input.ruleRunId, tenantId: context.tenantId, sellerAccountId: input.storeId, sku: input.sku, outcome: 'SUGGESTED' },
          data: { outcome: 'QUEUED', writeRunId: created.id, message: '已提交改价，等待亚马逊确认' },
        })
        if (linked.count === 0) throw appError('CONFLICT', '这条建议已被处理或已失效，请刷新后再试', { details: { code: 'SUGGESTION_STALE' } })
      }
      await this.audit.record(
        req,
        {
          action: PRICING_SUBMITTED_ACTIONS[input.kind],
          resourceType: 'ListingWriteRun',
          resourceId: created.id,
          after: { kind: input.kind, storeId: input.storeId, sku: input.sku, price: input.requestJson.price, ruleRunId: input.ruleRunId ?? null },
        },
        { client: tx },
      )
      return { run: created, job: queued }
    })
    const queued = await this.jobs.dispatch(req, job, { tenantId: context.tenantId, connectionId: input.connectionId, runId: run.id, writesAmazon: input.writesAmazon })
    return { run: await this.view(context.tenantId, run.id), state: queued ? 'QUEUED' : 'FAILED' }
  }

  async validate(req: RequestWithContext, sku: string, rawBody: unknown): Promise<PriceWriteSubmitResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_PRICE_WRITE, {})
    const body = PriceValidateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    await this.assertStore(context.tenantId, body.storeId)
    await this.guard.assert(context, { permission: PRICING_PRICE_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: body.storeId } })
    const connection = await this.jobs.connectionOf(context.tenantId, body.storeId)
    const target = await this.target(context, scope, body.storeId, sku, body.productType, body.price)
    if (target.violations.length > 0) this.blocked(target)
    return this.submit(req, context, {
      kind: 'PRICE_VALIDATE',
      storeId: body.storeId,
      connectionId: connection.id,
      sku,
      productType: target.productType,
      requestJson: { sku, asin: target.asin, price: body.price, currency: target.currency, previousPrice: target.currentPrice, source: 'MANUAL' },
      requestHash: priceHash(sku, target.productType, body.price, target.currency),
      writesAmazon: false,
    })
  }

  async update(req: RequestWithContext, sku: string, rawBody: unknown): Promise<PriceWriteSubmitResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_PRICE_WRITE, {})
    const body = PriceUpdateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    await this.assertStore(context.tenantId, body.storeId)
    await this.guard.assert(context, { permission: PRICING_PRICE_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: body.storeId }, switchKey: PRICING_UPDATE_SWITCH })
    const connection = await this.jobs.connectionOf(context.tenantId, body.storeId)
    const target = await this.target(context, scope, body.storeId, sku, body.productType, body.price)
    const preview = await this.prisma.listingWriteRun.findFirst({ where: { id: body.previewRunId, tenantId: context.tenantId, sellerAccountId: body.storeId, sellerSku: sku, kind: 'PRICE_VALIDATE' } })
    if (!preview || preview.validation !== 'VALID') throw appError('CONFLICT', '改价前需要先做校验预览并通过', { details: { code: 'PREVIEW_REQUIRED' } })
    if (!preview.expiresAt || preview.expiresAt <= new Date()) throw appError('CONFLICT', `校验预览已过期（${PREVIEW_HOURS_TEXT}内有效），请重新校验`, { details: { code: 'PREVIEW_EXPIRED' } })
    const hash = priceHash(sku, target.productType, body.price, target.currency)
    if (preview.requestHash !== hash) throw appError('CONFLICT', '提交的价格与校验过的不一致，请重新校验', { details: { code: 'PREVIEW_MISMATCH' } })
    if (target.violations.length > 0) this.blocked(target)
    if (body.ruleRunId) {
      const suggestion = await this.prisma.pricingRuleRun.findFirst({
        where: { id: body.ruleRunId, tenantId: context.tenantId, sellerAccountId: body.storeId, sku, outcome: 'SUGGESTED' },
        select: { suggestedPrice: true },
      })
      if (!suggestion) throw appError('CONFLICT', '这条建议已被处理或已失效，请刷新后再试', { details: { code: 'SUGGESTION_STALE' } })
      if (num(suggestion.suggestedPrice) !== body.price)
        throw appError('VALIDATION_FAILED', '确认建议时价格必须与建议价一致；要改成别的价格请按手工改价提交', { fieldErrors: { price: ['与建议价不一致'] } })
    }
    const busy = await this.prisma.listingWriteRun.count({
      where: { tenantId: context.tenantId, sellerAccountId: body.storeId, kind: 'PRICE_PATCH', sellerSku: sku, status: { in: ['PENDING', 'RUNNING'] } },
    })
    if (busy > 0) throw appError('CONFLICT', '这个商品已有未完成的改价，请等它完成后再提交', { details: { code: 'LISTING_RUN_STALE' } })
    return this.submit(req, context, {
      kind: 'PRICE_PATCH',
      storeId: body.storeId,
      connectionId: connection.id,
      sku,
      productType: target.productType,
      requestJson: {
        sku,
        asin: target.asin,
        price: body.price,
        currency: target.currency,
        previousPrice: target.currentPrice,
        source: body.ruleRunId ? 'RULE_CONFIRMED' : 'MANUAL',
        ...(body.ruleRunId ? { ruleRunId: body.ruleRunId } : {}),
      },
      requestHash: hash,
      previewRunId: preview.id,
      ...(body.ruleRunId ? { ruleRunId: body.ruleRunId } : {}),
      writesAmazon: true,
    })
  }
}
