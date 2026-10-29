import { Injectable } from '@nestjs/common'
import {
  DryRunBodySchema,
  NO_LIMITS,
  normalizeMatrix,
  PRICING_LIMITS,
  PRICING_RULE_WRITE,
  evaluatePricingRule,
  scopeIncludes,
  type DryRunDay,
  type DryRunHit,
  type DryRunResponse,
  type PricingParams,
  type PricingStrategy,
  type PricingTargetScope,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { daysAgo, keyOf, loadGuardrails, loadProducts, loadUnits, num, ROW_CAP, unitOf, ymd } from './pricing-load'
import { limitsOf } from './pricing-rows'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const BASIS = '按每天结束时已有的价格、推荐报价预期价格与竞争报价逐日重新评估；每件经济取近 30 天的最新值（历史日的利润率没有重算）。试运行不考虑每日次数与熔断，不生成建议、不改价。'

interface Point {
  t: number
  v: number
}
const group = <T>(rows: readonly T[], keyFn: (row: T) => string, pointFn: (row: T) => Point): Map<string, Point[]> => {
  const out = new Map<string, Point[]>()
  for (const row of rows) {
    const key = keyFn(row)
    const list = out.get(key)
    if (list) list.push(pointFn(row))
    else out.set(key, [pointFn(row)])
  }
  return out
}
/** 不晚于 t 的最后一个值（序列按时间升序）；二分查找。 */
function lastAt(points: readonly Point[] | undefined, t: number): number | null {
  if (!points || points.length === 0) return null
  let low = 0
  let high = points.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (points[mid]!.t <= t) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found < 0 ? null : points[found]!.v
}

/** 规则试运行（05 章 5.5）：只读（冻结表要求 pricing.rule.write 权限并写审计）。把规则按过去若干天每天结束时的数据逐日评估一遍，再按最新数据给出每个商品的结果，让人在启用之前看到“会命中多少、被护栏拦多少”。 */
@Injectable()
export class PricingRuleDryRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async dryRun(req: RequestWithContext, ruleId: string, rawBody: unknown, now = new Date()): Promise<DryRunResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PRICING_RULE_WRITE, {})
    const body = DryRunBodySchema.parse(rawBody ?? {})
    if (!ID_PATTERN.test(ruleId)) throw appError('RESOURCE_NOT_FOUND', '定价规则不存在')
    const tenantId = context.tenantId
    const rule = await this.prisma.pricingRule.findFirst({ where: { id: ruleId, tenantId, ...storeWhere(scope) } })
    if (!rule) throw appError('RESOURCE_NOT_FOUND', '定价规则不存在')
    const storeId = rule.sellerAccountId
    const target = rule.targetScopeJson as unknown as PricingTargetScope
    const spec = {
      strategy: rule.strategy as PricingStrategy,
      params: rule.paramsJson as unknown as PricingParams,
      maxChangePct: Number(rule.maxChangePct.toString()),
      matrix: normalizeMatrix(rule.scenarioMatrix),
    }
    const { rows } = await loadProducts(this.prisma, tenantId, scope, { storeId })
    const inScope = rows.filter(product => scopeIncludes(target, product.sellerSku, product.asin))
    const products = inScope.slice(0, PRICING_LIMITS.ruleSkusMax)
    const empty = (note: string): DryRunResponse => ({ ruleId, days: body.days, daily: [], current: [], evaluated: 0, note, basis: BASIS })
    if (products.length === 0) return empty('规则的适用范围内没有商品，无法试运行')
    const skus = products.map(product => product.sellerSku)
    const asins = [...new Set(products.map(product => product.asin).filter(asin => asin !== ''))]
    const since = daysAgo(now, body.days + 2)
    const [priceRows, expectedRows, offerRows, units, guardrails] = await Promise.all([
      this.prisma.priceSnapshot.findMany({
        where: { tenantId, sellerAccountId: storeId, sellerSku: { in: skus }, observedAt: { gte: since } },
        select: { sellerSku: true, price: true, observedAt: true },
        orderBy: { observedAt: 'asc' },
        take: ROW_CAP,
      }),
      this.prisma.featuredOfferExpectedPrice.findMany({
        where: { tenantId, sellerAccountId: storeId, sellerSku: { in: skus }, observedAt: { gte: since } },
        select: { sellerSku: true, expectedPrice: true, observedAt: true },
        orderBy: { observedAt: 'asc' },
        take: ROW_CAP,
      }),
      asins.length === 0
        ? Promise.resolve([])
        : this.prisma.competitiveOffer.findMany({
            where: { tenantId, sellerAccountId: storeId, asin: { in: asins }, isOwn: false, observedAt: { gte: since } },
            select: { asin: true, price: true, observedAt: true },
            orderBy: { observedAt: 'asc' },
            take: ROW_CAP,
          }),
      loadUnits(this.prisma, tenantId, scope, now),
      loadGuardrails(this.prisma, tenantId, [storeId]),
    ])
    if (priceRows.length === 0) return empty('这些商品还没有价格记录（定价同步后才能试运行）')
    const prices = group(
      priceRows,
      row => row.sellerSku,
      row => ({ t: row.observedAt.getTime(), v: Number(row.price.toString()) }),
    )
    const expected = group(
      expectedRows.filter(row => row.expectedPrice !== null),
      row => row.sellerSku,
      row => ({ t: row.observedAt.getTime(), v: num(row.expectedPrice) as number }),
    )
    // 每个 ASIN 每次观察里其他卖家的最低报价。
    const lowestByTime = new Map<string, Map<number, number>>()
    for (const row of offerRows) {
      const times = lowestByTime.get(row.asin) ?? new Map<number, number>()
      const t = row.observedAt.getTime()
      times.set(t, Math.min(times.get(t) ?? Infinity, Number(row.price.toString())))
      lowestByTime.set(row.asin, times)
    }
    const lowest = new Map<string, Point[]>([...lowestByTime].map(([asin, times]) => [asin, [...times].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t)]))
    const limits = new Map(products.map(product => [product.sellerSku, limitsOf(guardrails, { storeId, sku: product.sellerSku, asin: product.asin, productType: product.productType }) ?? NO_LIMITS]))
    const evaluate = (product: (typeof products)[number], t: number) => {
      const currentPrice = lastAt(prices.get(product.sellerSku), t)
      if (currentPrice === null) return null
      const result = evaluatePricingRule(spec, {
        sku: product.sellerSku,
        asin: product.asin,
        currentPrice,
        expectedPrice: lastAt(expected.get(product.sellerSku), t),
        lowestOtherPrice: product.asin ? lastAt(lowest.get(product.asin), t) : null,
        unit: unitOf(units, keyOf(storeId, product.sellerSku)),
        limits: limits.get(product.sellerSku) ?? NO_LIMITS,
      })
      return { currentPrice, result }
    }
    const daily: DryRunDay[] = []
    for (let back = body.days - 1; back >= 0; back -= 1) {
      const day = daysAgo(now, back)
      const t = back === 0 ? now.getTime() : new Date(`${ymd(day)}T23:59:59.999Z`).getTime()
      let evaluated = 0
      let hits = 0
      let blocked = 0
      for (const product of products) {
        const out = evaluate(product, t)
        if (!out || out.result.result === 'NO_INPUT') continue
        evaluated += 1
        if (out.result.hit) hits += 1
        if (out.result.blocked) blocked += 1
      }
      daily.push({ date: ymd(day), evaluated, hits, blocked })
    }
    const current: DryRunHit[] = []
    for (const product of products) {
      const out = evaluate(product, now.getTime())
      if (!out) continue
      current.push({
        sku: product.sellerSku,
        asin: product.asin,
        currentPrice: out.currentPrice,
        rawPrice: out.result.rawPrice,
        suggestedPrice: out.result.suggestedPrice,
        guardrailResult: out.result.result,
        guardrailText: out.result.text,
        hit: out.result.hit,
      })
    }
    const note = inScope.length > products.length ? `规则范围内有 ${inScope.length} 个商品，只试运行前 ${products.length} 个（按 SKU 排序）` : `按 ${body.days} 天逐日评估，不会生成建议也不会改价`
    return { ruleId, days: body.days, daily, current, evaluated: current.filter(item => item.guardrailResult !== 'NO_INPUT').length, note, basis: BASIS }
  }
}
