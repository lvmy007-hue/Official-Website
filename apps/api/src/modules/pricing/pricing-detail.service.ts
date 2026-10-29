import { Injectable } from '@nestjs/common'
import {
  BREAKER_OBSERVE_DAYS,
  LISTING_RUN_STATUS_LABEL,
  PRICE_CHANGE_SOURCE_LABEL,
  PRICING_BASIS,
  PRICING_ELASTICITY_NOTE,
  PRICING_FRESHNESS_KEY,
  PRICING_LIMITS,
  PRICING_MARGIN_BASIS,
  PRICING_READ,
  PriceSimulationBodySchema,
  PricingStoreQuerySchema,
  breakEvenOf,
  checkGuardrails,
  compareSideOf,
  estimateElasticity,
  marginAtPrice,
  netAtPrice,
  priceCompareOf,
  projectAt,
  round2,
  type PriceAdjustmentRow,
  type PriceSimulationBody,
  type PriceChangeSource,
  type PriceCompare,
  type PriceSimulationResponse,
  type PricingDetailResponse,
  type PricingOfferRow,
  type RuleRunView,
  type TrafficDay,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService } from '../../platform/write'
import { assertStoreInScope, ContextService, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { eventsOf, historyOf, priceUnitsPoints, type Stamped } from './pricing-detail-math'
import { writeStatusesOf } from './pricing-common'
import { daysAgo, keyOf, loadBuyBoxPct, loadGuardrails, loadLatestExpected, loadLatestPrices, loadLatestSummaries, loadProducts, loadUnits, num, ymd, type ProductRow } from './pricing-load'
import { buildRow, limitsOf } from './pricing-rows'
import { guardrailViewOf, ruleRunViewOf } from './pricing-rule-view'

const DAY_MS = 86_400_000
const NOTE_NO_HISTORY = '还没有这个商品的价格记录；定价同步（每 2 小时）读到报价后才会出现曲线'
const NOTE_HISTORY = '价格类数据只在变化或每 24 小时记录一次；某天没有新记录就按上一次的值延续，不代表当天重新抓取过'
const NOTE_NO_OFFERS = '还没有这个 ASIN 的竞争报价记录（竞争摘要同步后显示）'
const NOTE_PROJECTION_NEED = '预测日销量与日利润需要价格弹性估算可信、近 30 天有销量并且能折算每件经济；其中一项不满足时不给，不用别的数字代替'

interface Target {
  tenantId: string
  scope: ResolvedScope
  storeId: string
  storeName: string
  product: ProductRow
  canProfit: boolean
  context: Awaited<ReturnType<ContextService['authorizeScoped']>>['context']
}

/** 价格详情与调价模拟器（05 章 5.5）：历史曲线、竞争报价、事件、调价历史（含前后各 7 天对照），以及按目标价估算的利润与销量（估算，不是预测保证）。 */
@Injectable()
export class PricingDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
  ) {}

  /** 权限先于参数：先确认有权限，再解析店铺参数（storeIdOf 里会做 zod 校验，失败 422）。 */
  private async resolve(req: RequestWithContext, sku: string, storeIdOf: () => string): Promise<Target> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_READ, {})
    const storeId = storeIdOf()
    assertStoreInScope(scope, storeId)
    const [store, products] = await Promise.all([
      this.prisma.sellerAccount.findFirst({ where: { id: storeId, tenantId: context.tenantId }, select: { displayName: true } }),
      loadProducts(this.prisma, context.tenantId, scope, { storeId, sku }),
    ])
    const product = products.rows[0]
    if (!store || !product) throw appError('RESOURCE_NOT_FOUND', '商品不存在')
    return { tenantId: context.tenantId, scope, storeId, storeName: store.displayName, product, canProfit: canSeeField(context.permissions, 'profit'), context }
  }

  private async trafficOf(target: Target, asin: string, from: Date): Promise<TrafficDay[]> {
    if (!asin) return []
    const rows = await this.prisma.salesTrafficAsinDaily.findMany({
      where: { tenantId: target.tenantId, sellerAccountId: target.storeId, asin, asinGranularity: 'CHILD', currency: 'USD', date: { gte: new Date(`${ymd(from)}T00:00:00.000Z`) } },
      select: { date: true, source: true, units: true, sessions: true, buyBoxPct: true },
      orderBy: [{ date: 'asc' }, { source: 'asc' }],
      take: 2000,
    })
    return rows.map(row => ({ date: ymd(row.date), source: row.source, units: row.units, sessions: row.sessions, buyBoxPct: num(row.buyBoxPct) }))
  }

  private async adjustments(target: Target, asin: string, now: Date): Promise<PriceAdjustmentRow[]> {
    const runs = await this.prisma.listingWriteRun.findMany({
      where: { tenantId: target.tenantId, sellerAccountId: target.storeId, sellerSku: target.product.sellerSku, kind: 'PRICE_PATCH' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: PRICING_LIMITS.adjustmentsMax,
    })
    if (runs.length === 0) return []
    const oldest = runs[runs.length - 1]!.createdAt
    const [traffic, users] = await Promise.all([
      this.trafficOf(target, asin, new Date(oldest.getTime() - PRICING_LIMITS.compareDays * DAY_MS)),
      memberNames(
        this.prisma,
        target.tenantId,
        runs.map(run => run.requestedBy),
      ),
    ])
    const between = (from: Date, to: Date) => traffic.filter(day => day.date >= ymd(from) && day.date <= ymd(to))
    return runs.map(run => {
      const body = (run.requestJson && typeof run.requestJson === 'object' ? run.requestJson : {}) as Record<string, unknown>
      const at = run.finishedAt ?? run.createdAt
      const ok = run.status === 'SUCCEEDED'
      const compare: PriceCompare = ok
        ? priceCompareOf({
            changedAt: at,
            now,
            observeDays: BREAKER_OBSERVE_DAYS,
            before: compareSideOf(between(new Date(at.getTime() - PRICING_LIMITS.compareDays * DAY_MS), new Date(at.getTime() - DAY_MS))),
            after: compareSideOf(between(new Date(at.getTime() + DAY_MS), new Date(at.getTime() + PRICING_LIMITS.compareDays * DAY_MS))),
          })
        : { state: 'NO_DATA', note: '这次改价没有成功，没有前后对照', before: null, after: null }
      const source: PriceChangeSource = body.source === 'RULE_AUTO' ? 'RULE_AUTO' : body.ruleRunId ? 'RULE_CONFIRMED' : 'MANUAL'
      return {
        runId: run.id,
        at: at.toISOString(),
        source,
        sourceLabel: PRICE_CHANGE_SOURCE_LABEL[source],
        from: typeof body.previousPrice === 'number' ? body.previousPrice : null,
        to: typeof body.price === 'number' ? body.price : 0,
        status: run.status,
        statusLabel: LISTING_RUN_STATUS_LABEL[run.status as keyof typeof LISTING_RUN_STATUS_LABEL] ?? run.status,
        by: run.requestedBy ? (users.get(run.requestedBy) ?? null) : null,
        compare,
      }
    })
  }

  async detail(req: RequestWithContext, sku: string, rawQuery: Record<string, string>, now = new Date()): Promise<PricingDetailResponse> {
    const target = await this.resolve(req, sku, () => PricingStoreQuerySchema.parse(rawQuery).storeId)
    const { storeId } = target
    const { tenantId, product } = target
    const since = daysAgo(now, PRICING_LIMITS.historyDays)
    const [prices, expected] = await Promise.all([loadLatestPrices(this.prisma, tenantId, [storeId], now, sku), loadLatestExpected(this.prisma, tenantId, [storeId], now, sku)])
    const price = prices.get(keyOf(storeId, sku))
    const asin = product.asin || price?.asin || ''
    const asinFilter = asin ? { asin } : { asin: '\u0000' }
    const [summaries, units, buyBox, guardrails, freshness, write, priceRows, expectedRows, summaryRows, boxRows, offerRows, pendingRows, adjustments] = await Promise.all([
      loadLatestSummaries(this.prisma, tenantId, [storeId], now, asin || undefined),
      target.canProfit ? loadUnits(this.prisma, tenantId, target.scope, now, sku) : Promise.resolve(new Map()),
      loadBuyBoxPct(this.prisma, tenantId, target.scope, now, asin || undefined),
      loadGuardrails(this.prisma, tenantId, [storeId]),
      sourceFreshness(this.prisma, tenantId, target.scope, [PRICING_FRESHNESS_KEY], now),
      writeStatusesOf(this.guard, target.context),
      this.prisma.priceSnapshot.findMany({
        where: { tenantId, sellerAccountId: storeId, sellerSku: sku, observedAt: { gte: since } },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: PRICING_LIMITS.historyRowsMax,
      }),
      this.prisma.featuredOfferExpectedPrice.findMany({
        where: { tenantId, sellerAccountId: storeId, sellerSku: sku, observedAt: { gte: since } },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: PRICING_LIMITS.historyRowsMax,
      }),
      this.prisma.competitiveSummarySnapshot.findMany({
        where: { tenantId, sellerAccountId: storeId, ...asinFilter, observedAt: { gte: since } },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: PRICING_LIMITS.historyRowsMax,
      }),
      this.prisma.buyBoxSnapshot.findMany({ where: { tenantId, sellerAccountId: storeId, ...asinFilter, observedAt: { gte: since } }, orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: 2000 }),
      this.prisma.competitiveOffer.findMany({
        where: { tenantId, sellerAccountId: storeId, ...asinFilter, observedAt: { gte: new Date(now.getTime() - PRICING_LIMITS.freshWindowMs) } },
        orderBy: [{ observedAt: 'desc' }, { price: 'asc' }],
        take: 200,
      }),
      this.prisma.pricingRuleRun.findMany({
        where: { tenantId, sellerAccountId: storeId, sku, outcome: 'SUGGESTED' },
        include: { rule: { select: { name: true } } },
        orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
        take: 20,
      }),
      this.adjustments(target, asin, now),
    ])
    const row = buildRow({
      product,
      storeName: target.storeName,
      price,
      expected: expected.get(keyOf(storeId, sku)),
      summary: summaries.get(keyOf(storeId, asin)),
      buyBoxPct: buyBox.get(keyOf(storeId, asin)) ?? null,
      unit: units.get(keyOf(storeId, sku)),
      canProfit: target.canProfit,
      guardrails,
    })
    const stamped = <T extends { observedAt: Date }>(items: readonly T[], value: (item: T) => number | null): Stamped[] => items.map(item => ({ at: item.observedAt, value: value(item) }))
    const points = historyOf(
      {
        own: stamped(priceRows, item => Number(item.price.toString())),
        featured: stamped(summaryRows, item => num(item.featuredPrice)),
        lowest: stamped(summaryRows, item => num(item.lowestPrice)),
        expected: stamped(expectedRows, item => num(item.expectedPrice)),
      },
      now,
    )
    const newest = offerRows[0]?.observedAt.getTime()
    const offers: PricingOfferRow[] = offerRows
      .filter(item => item.observedAt.getTime() === newest)
      .map(item => ({
        offerKey: item.offerKey,
        isOwn: item.isOwn,
        isFeatured: item.isFeatured,
        price: Number(item.price.toString()),
        shipping: num(item.shipping),
        condition: item.condition,
        fulfillment: item.fulfillment,
      }))
    const pendingRuns: RuleRunView[] = pendingRows.map(item => ruleRunViewOf(item, item.rule.name, null))
    const applicable = guardrails.filter(
      item =>
        item.sellerAccountId === storeId &&
        (item.scope === 'STORE' ||
          (item.scope === 'SKU' && item.scopeRef === sku) ||
          (item.scope === 'ASIN' && item.scopeRef === asin) ||
          (item.scope === 'CATEGORY' && item.scopeRef === (product.productType ?? '\u0000'))),
    )
    return {
      row,
      history: points.length > 0 ? { state: 'OK', note: NOTE_HISTORY, points } : { state: 'NO_DATA', note: NOTE_NO_HISTORY, points: [] },
      offers:
        offers.length > 0 ? { state: 'OK', note: null, observedAt: offerRows[0]!.observedAt.toISOString(), rows: offers } : { state: 'NO_DATA', note: NOTE_NO_OFFERS, observedAt: null, rows: [] },
      events: eventsOf(
        priceRows.map(item => ({ at: item.observedAt, price: Number(item.price.toString()), source: item.source })),
        boxRows.map(item => ({ at: item.observedAt, ownIsFeatured: item.ownIsFeatured, source: item.source, lostReason: item.lostReason })),
      ),
      adjustments,
      limits: row.limits,
      guardrails: applicable.map(item => guardrailViewOf(item, target.storeName)),
      pendingRuns,
      write,
      basis: PRICING_BASIS,
      freshness,
    }
  }

  async simulate(req: RequestWithContext, sku: string, rawBody: unknown, now = new Date()): Promise<PriceSimulationResponse> {
    let parsed: PriceSimulationBody | undefined
    const target = await this.resolve(req, sku, () => (parsed = PriceSimulationBodySchema.parse(rawBody)).storeId)
    const body = parsed as PriceSimulationBody
    const { tenantId, product } = target
    if (!target.canProfit) throw appError('TENANT_ACCESS_DENIED', '调价模拟需要利润字段权限（field.profit）')
    const [prices, expected] = await Promise.all([loadLatestPrices(this.prisma, tenantId, [body.storeId], now, sku), loadLatestExpected(this.prisma, tenantId, [body.storeId], now, sku)])
    const price = prices.get(keyOf(body.storeId, sku))
    const asin = product.asin || price?.asin || ''
    const [units, guardrails, traffic, priceRows] = await Promise.all([
      loadUnits(this.prisma, tenantId, target.scope, now, sku),
      loadGuardrails(this.prisma, tenantId, [body.storeId]),
      this.trafficOf(target, asin, daysAgo(now, PRICING_LIMITS.historyDays)),
      this.prisma.priceSnapshot.findMany({
        where: { tenantId, sellerAccountId: body.storeId, sellerSku: sku, observedAt: { gte: daysAgo(now, PRICING_LIMITS.historyDays) } },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: PRICING_LIMITS.historyRowsMax,
      }),
    ])
    const result = units.get(keyOf(body.storeId, sku))
    const unit = result?.unit ?? null
    const limits = limitsOf(guardrails, { storeId: body.storeId, sku, asin, productType: product.productType })
    const expectedPrice = num(expected.get(keyOf(body.storeId, sku))?.expectedPrice)
    const violations = limits ? checkGuardrails({ price: body.price, currentPrice: price?.price ?? null, limits, unit }) : []
    const history = historyOf({ own: priceRows.map(item => ({ at: item.observedAt, value: Number(item.price.toString()) })), featured: [], lowest: [], expected: [] }, now)
    const sold = new Map<string, number>()
    const preferred = new Map<string, TrafficDay>()
    for (const day of traffic) {
      const kept = preferred.get(day.date)
      if (!kept || (kept.source !== 'DATA_KIOSK' && day.source === 'DATA_KIOSK')) preferred.set(day.date, day)
    }
    for (const day of preferred.values()) if (day.units !== null) sold.set(day.date, day.units)
    const elasticity = estimateElasticity(priceUnitsPoints(history, sold))
    const baseline = [...sold.entries()].filter(([date]) => date >= ymd(daysAgo(now, 30)))
    const baselineUnits = baseline.length > 0 ? baseline.reduce((sum, [, value]) => sum + value, 0) / baseline.length : null
    const current = price?.price ?? null
    const can = unit !== null && elasticity.state === 'OK' && elasticity.value !== null && baselineUnits !== null && baselineUnits > 0 && current !== null
    const projected = can ? projectAt({ elasticity: elasticity.value as number, baselinePrice: current as number, baselineUnits: baselineUnits as number, price: body.price, unit }) : null
    const net = unit ? netAtPrice(unit, body.price) : null
    return {
      state: result === undefined ? 'NO_DATA' : result.state,
      note: result === undefined ? '近 30 天这个商品没有利润数据，无法折算每件经济' : result.note,
      price: body.price,
      currentPrice: current,
      net,
      margin: marginAtPrice(unit, body.price),
      deltaNet: unit && current !== null ? round2((net as number) - netAtPrice(unit, current)) : null,
      breakEvenPrice: unit ? breakEvenOf(unit) : null,
      expectedPrice,
      reachesExpected: expectedPrice === null ? null : body.price <= expectedPrice + 0.005,
      guardrail: { ok: violations.length === 0, violations },
      elasticity: {
        state: elasticity.state,
        value: elasticity.value,
        samples: elasticity.samples,
        note: elasticity.state === 'OK' ? PRICING_ELASTICITY_NOTE : `${elasticity.note}。${PRICING_ELASTICITY_NOTE}`,
      },
      projection: projected
        ? { state: 'OK', note: PRICING_MARGIN_BASIS, unitsPerDay: projected.unitsPerDay, profitPerDay: projected.profitPerDay, baselineUnitsPerDay: round2(baselineUnits as number) }
        : { state: 'UNAVAILABLE', note: NOTE_PROJECTION_NEED, unitsPerDay: null, profitPerDay: null, baselineUnitsPerDay: baselineUnits === null ? null : round2(baselineUnits) },
      basis: PRICING_MARGIN_BASIS,
    }
  }
}
