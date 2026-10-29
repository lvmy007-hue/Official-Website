import { isoDaysBetween } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit, AlertRuleView } from '../platform/alert-evaluate'
import type { InventoryFact } from './inventory-fact'
import { loadInventoryFacts, type InventoryFactSet } from './inventory-facts'
import { choiceListParam, numberParam, scopeFilter } from './params'

// 库存类预警评估器（P2a-15，09 章 9.1 库存域）：断货风险、冗余、库龄附加费即将跨档、低库存水平费风险、滞留。
// 判断与库存健康页同源（见 inventory-fact.ts）；命中对象是库存记录（点进去是库存详情页）。
// 每条规则最多 500 个命中（评估框架的上限），所以每个评估器都把最需要处理的排在前面。

const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2)
const base = (fact: InventoryFact) => ({ entityType: 'INVENTORY', entityId: fact.recordId, sellerAccountId: fact.sellerAccountId, entityLabel: `${fact.sku}（${fact.storeName}）` })
const identity = (fact: InventoryFact) => ({ sku: fact.sku, asin: fact.asin, storeName: fact.storeName, title: fact.title })

type Build = (set: InventoryFactSet, rule: AlertRuleView) => AlertHit[]

const evaluator = (type: string, build: Build): AlertEvaluator => ({
  type,
  async evaluate({ db, tenantId, rule, now }) {
    return build(await loadInventoryFacts(db, tenantId, now), rule)
  },
})

const scoped = (set: InventoryFactSet, rule: AlertRuleView) => {
  const scope = scopeFilter(rule)
  return set.facts.filter(fact => scope.allows({ sellerAccountId: fact.sellerAccountId, sku: fact.sku }))
}

const byCover = (a: InventoryFact, b: InventoryFact) => (a.assessment.daysOfCover ?? Number.POSITIVE_INFINITY) - (b.assessment.daysOfCover ?? Number.POSITIVE_INFINITY)

/** 断货风险：库存规则判为高风险（可选加上中风险）。没有库存规则时不判定。 */
export const buildStockoutHits: Build = (set, rule) => {
  const levels = choiceListParam(rule, 'levels', ['HIGH', 'MEDIUM'] as const, ['HIGH'])
  return scoped(set, rule)
    .filter(fact => fact.assessment.state === 'OK' && fact.assessment.risk !== null && (levels as string[]).includes(fact.assessment.risk))
    .sort(byCover)
    .map(fact => {
      const a = fact.assessment
      const high = a.risk === 'HIGH'
      return {
        ...base(fact),
        title: `${fact.sku} ${high ? '将断货' : '库存已低于安全库存'}${a.stockoutDate ? `（预计 ${a.stockoutDate}）` : ''}`,
        suggestedAction: high
          ? `现有库存加计入的在途只够 ${a.daysOfCover} 天，短于最快补货到仓的 ${a.fastestLeadDays} 天，请尽快补货或加急入仓`
          : `库存只够 ${a.daysOfCover} 天，已进入安全库存范围（最快到仓 ${a.fastestLeadDays} 天），请安排补货`,
        evidence: {
          ...identity(fact),
          risk: a.risk,
          sellable: fact.sellable,
          inboundCounted: fact.inboundCounted,
          dailyDemand: fact.demandMid,
          daysOfCover: a.daysOfCover,
          stockoutDate: a.stockoutDate,
          fastestLeadDays: a.fastestLeadDays,
          fastestReplenishDate: a.fastestReplenishDate,
          policyVersion: a.policyVersion,
        },
      }
    })
}

/** 冗余：覆盖天数超过目标覆盖天数 × 冗余倍数，或近期没有销量但仍有库存。 */
export const buildExcessHits: Build = (set, rule) =>
  scoped(set, rule)
    .filter(fact => fact.assessment.state === 'OK' && fact.assessment.risk === 'EXCESS')
    .sort((a, b) => (b.assessment.daysOfCover ?? Number.POSITIVE_INFINITY) - (a.assessment.daysOfCover ?? Number.POSITIVE_INFINITY) || b.sellable - a.sellable)
    .map(fact => {
      const a = fact.assessment
      return {
        ...base(fact),
        title: a.noDemand ? `${fact.sku} 近期没有销量，库存冗余` : `${fact.sku} 库存冗余（可售 ${a.daysOfCover} 天）`,
        suggestedAction: '暂停补货，并考虑促销、调价或申请移除，避免继续产生仓储费',
        evidence: {
          ...identity(fact),
          sellable: fact.sellable,
          inboundCounted: fact.inboundCounted,
          dailyDemand: fact.demandMid,
          daysOfCover: a.daysOfCover,
          noDemand: a.noDemand,
          targetDays: a.targetDays,
          nextMonthStorage: fact.nextMonthStorage,
          policyVersion: a.policyVersion,
        },
      }
    })

/** 库龄附加费即将跨档：收费档下一级之前的库存，最迟在预警天数内全部进入收费档。 */
export const buildAgingHits = (set: InventoryFactSet, rule: AlertRuleView): AlertHit[] => {
  const warnDays = numberParam(rule, 'warnDays', 30, { min: 1, max: 365 })
  const hits: Array<{ hit: AlertHit; soonest: number }> = []
  for (const fact of scoped(set, rule)) {
    const tiers = fact.agingTiers
      .filter(tier => !tier.likelyCrossed && isoDaysBetween(set.today, tier.latestDate) <= warnDays)
      .map(tier => ({ ...tier, daysLeft: Math.max(0, isoDaysBetween(set.today, tier.latestDate)) }))
    if (tiers.length === 0) continue
    const soonest = Math.min(...tiers.map(tier => tier.daysLeft))
    const known = tiers.every(tier => tier.estimatedIncrease !== null)
    const total = tiers.reduce((sum, tier) => sum + (tier.estimatedIncrease ?? 0), 0)
    const qty = tiers.reduce((sum, tier) => sum + tier.qty, 0)
    hits.push({
      soonest,
      hit: {
        ...base(fact),
        title: `${fact.sku} 有 ${qty} 件最迟 ${soonest} 天内进入库龄附加费档`,
        suggestedAction: '在跨档前促销清货、调价，或创建移除订单，避免被收取库龄附加费',
        ...(known && total > 0 ? { impact: { min: total, max: total } } : {}),
        evidence: {
          ...identity(fact),
          snapshotDate: fact.agingSnapshotDate,
          tiers: tiers.map(tier => ({
            boundaryDays: tier.boundaryDays,
            toLabel: tier.toLabel,
            qty: tier.qty,
            earliestDate: tier.earliestDate,
            latestDate: tier.latestDate,
            estimatedIncrease: tier.estimatedIncrease,
          })),
          estimatedIncrease: known ? money(total) : null,
        },
      },
    })
  }
  return hits.sort((a, b) => a.soonest - b.soonest).map(item => item.hit)
}

/** 低库存水平费风险：规划报告标明已收取，或预估费用大于 0。 */
export const buildLowFeeHits: Build = (set, rule) =>
  scoped(set, rule)
    .filter(fact => fact.lowFee.atRisk === true)
    .sort((a, b) => (b.lowFee.fee ?? 0) - (a.lowFee.fee ?? 0))
    .map(fact => ({
      ...base(fact),
      title: `${fact.sku} 面临低库存水平费`,
      suggestedAction: '库存覆盖天数低于亚马逊的最低要求，补货到足以覆盖后该费用会消失',
      ...(fact.lowFee.fee !== null && fact.lowFee.fee > 0 ? { impact: { min: fact.lowFee.fee, max: fact.lowFee.fee, currency: fact.lowFee.currency ?? undefined } } : {}),
      evidence: { ...identity(fact), applied: fact.lowFee.applied, fee: fact.lowFee.fee, currency: fact.lowFee.currency, sellable: fact.sellable, planningDate: fact.planningDate },
    }))

/** 滞留：滞留库存报告里有数量，或库存记录带滞留原因。 */
export const buildStrandedHits: Build = (set, rule) =>
  scoped(set, rule)
    .filter(fact => (fact.stranded.qty ?? 0) > 0 || Boolean(fact.stranded.reason))
    .sort((a, b) => (b.stranded.qty ?? 0) - (a.stranded.qty ?? 0))
    .map(fact => ({
      ...base(fact),
      title: fact.stranded.qty ? `${fact.sku} 有 ${fact.stranded.qty} 件滞留` : `${fact.sku} 库存滞留`,
      suggestedAction: fact.stranded.reason ? `滞留原因：${fact.stranded.reason}。修复刊登问题后库存会恢复可售` : '请到卖家后台核对滞留原因并修复刊登问题',
      evidence: { ...identity(fact), strandedQty: fact.stranded.qty, strandedReason: fact.stranded.reason },
    }))

export const inventoryEvaluators = (): AlertEvaluator[] => [
  evaluator('inventory.stockout-risk', buildStockoutHits),
  evaluator('inventory.excess', buildExcessHits),
  evaluator('inventory.aging-tier', buildAgingHits),
  evaluator('inventory.low-level-fee', buildLowFeeHits),
  evaluator('inventory.stranded', buildStrandedHits),
]
