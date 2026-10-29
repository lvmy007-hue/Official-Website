import type { InventoryPolicy, OrderWindows } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import type { AlertRuleView } from '../platform/alert-evaluate'
import { buildInventoryFact, type InventoryFact, type InventoryFactSource } from './inventory-fact'
import { buildAgingHits, buildExcessHits, buildLowFeeHits, buildStockoutHits, buildStrandedHits } from './inventory-evaluators'
import type { InventoryFactSet } from './inventory-facts'

// 库存类预警（P2a-15）：判断与库存健康页同源，这里验证“事实行怎么装配”与“各规则怎么挑出命中并排序”。

const TODAY = '2026-10-22'
const POLICY: InventoryPolicy = {
  versionNo: 3,
  level: 'TENANT',
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED'],
  agingFromDays: 271,
  effectiveFrom: '2026-01-01',
  changeReason: '测试',
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
}
// 近 90 天每天卖 10 件
const STEADY: OrderWindows = { units7: 70, units30: 300, units60: 600, units90: 900, firstSeen: '2026-07-01', stockoutDays30: 0, stockoutUnits30: 0 }
const NO_SALES: OrderWindows = { units7: 0, units30: 0, units60: 0, units90: 0, firstSeen: '2026-07-01', stockoutDays30: 0, stockoutUnits30: 0 }

const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}): AlertRuleView => ({
  id: 'r1',
  code: 'X',
  domain: 'INVENTORY',
  name: '规则',
  severity: 'WARNING',
  cooldownMinutes: 60,
  currentVersion: 1,
  condition: { type: 't', params },
  scope,
})

const fact = (sku: string, over: Partial<Omit<InventoryFactSource, 'store' | 'record'>> & { sellable?: number; strandedReason?: string | null; store?: string } = {}): InventoryFact => {
  const { sellable, strandedReason, store, ...rest } = over
  const record = {
    id: `rec-${sku}`,
    sellerAccountId: store ?? 's1',
    sellerSku: sku,
    asin: `ASIN-${sku}`,
    fulfillableQuantity: sellable ?? 100,
    inboundWorkingQuantity: 0,
    inboundShippedQuantity: 0,
    inboundReceivingQuantity: 0,
    strandedReason: strandedReason ?? null,
  }
  return buildInventoryFact({
    store: { id: store ?? 's1', name: '一店' },
    record: record as never,
    title: `商品 ${sku}`,
    planning: null,
    age: null,
    stranded: null,
    orders: STEADY,
    policy: POLICY,
    today: TODAY,
    ...rest,
  })
}
const setOf = (facts: InventoryFact[], policy: InventoryPolicy | null = POLICY): InventoryFactSet => ({ today: TODAY, policy, facts, truncated: false })
const skus = (hits: Array<{ entityLabel?: string }>) => hits.map(hit => hit.entityLabel?.split('（')[0])

describe('断货风险', () => {
  const facts = [fact('HIGH', { sellable: 100 }), fact('LOW-COVER', { sellable: 50 }), fact('MID', { sellable: 400 }), fact('OK', { sellable: 600 }), fact('BIG', { sellable: 2000 })]

  it('默认只报高风险，按可售天数从少到多排；证据带可售天数、预计断货日与最快到仓时间', () => {
    const hits = buildStockoutHits(setOf(facts), rule())
    expect(skus(hits)).toEqual(['LOW-COVER', 'HIGH'])
    expect(hits[0]).toMatchObject({ entityType: 'INVENTORY', entityId: 'rec-LOW-COVER', sellerAccountId: 's1' })
    expect(hits[0].title).toContain('将断货（预计 2026-10-27）')
    expect(hits[0].evidence).toMatchObject({ risk: 'HIGH', sellable: 50, dailyDemand: 10, daysOfCover: 5, stockoutDate: '2026-10-27', fastestLeadDays: 30, policyVersion: 3 })
    expect(hits[0].suggestedAction).toContain('只够 5 天')
  })

  it('阈值里加入中风险后一并报出，仍然把最紧的排在前面', () => {
    const hits = buildStockoutHits(setOf(facts), rule({ levels: ['HIGH', 'MEDIUM'] }))
    expect(skus(hits)).toEqual(['LOW-COVER', 'HIGH', 'MID'])
    expect(hits[2].title).toContain('已低于安全库存')
  })

  it('阈值被改坏时回到默认，不让评估失败', () => {
    expect(skus(buildStockoutHits(setOf(facts), rule({ levels: ['NOPE'] })))).toEqual(['LOW-COVER', 'HIGH'])
    expect(skus(buildStockoutHits(setOf(facts), rule({ levels: 'HIGH' })))).toEqual(['LOW-COVER', 'HIGH'])
  })

  it('没有库存规则不判定；没有销量数据不判定（不是“没风险”也不是“有风险”）', () => {
    const noPolicy = [fact('A', { policy: null })]
    expect(buildStockoutHits(setOf(noPolicy, null), rule())).toEqual([])
    const noDemand = [fact('B', { orders: null })]
    expect(noDemand[0].assessment.state).toBe('NO_DATA')
    expect(buildStockoutHits(setOf(noDemand), rule())).toEqual([])
  })

  it('范围：只看指定店铺或 SKU', () => {
    const two = [fact('A', { sellable: 10, store: 's1' }), fact('B', { sellable: 10, store: 's2' })]
    expect(skus(buildStockoutHits(setOf(two), rule({}, { sellerAccountIds: ['s2'] })))).toEqual(['B'])
    expect(skus(buildStockoutHits(setOf(two), rule({}, { skus: ['A'] })))).toEqual(['A'])
    expect(skus(buildStockoutHits(setOf(two), rule({}, { sellerAccountIds: ['s9'] })))).toEqual([])
    // 范围里的字段不是数组时视为不限制
    expect(buildStockoutHits(setOf(two), rule({}, { sellerAccountIds: 's2' }))).toHaveLength(2)
  })
})

describe('库存冗余', () => {
  it('覆盖天数超过目标 × 倍数的才报，最冗余的排前面；近期没有销量但有库存也算', () => {
    const facts = [
      fact('OK', { sellable: 600 }),
      fact('E1', { sellable: 1000 }),
      fact('E2', { sellable: 3000 }),
      fact('IDLE', { sellable: 40, orders: NO_SALES }),
      fact('EMPTY', { sellable: 0, orders: NO_SALES }),
    ]
    const hits = buildExcessHits(setOf(facts), rule())
    expect(skus(hits)).toEqual(['IDLE', 'E2', 'E1'])
    expect(hits[0].title).toBe('IDLE 近期没有销量，库存冗余')
    expect(hits[0].evidence).toMatchObject({ noDemand: true, daysOfCover: null, sellable: 40 })
    expect(hits[1].title).toBe('E2 库存冗余（可售 300 天）')
  })
})

describe('库龄附加费即将跨档', () => {
  // 快照 8 月 1 日：181-270 天的库存最迟 10 月 30 日（8 天后）全部满 271 天；271-365 天的最迟 11 月 4 日（13 天后）满 366 天
  // 只有 5 段粗粒度（细分段为 null，报告没给）
  const age = {
    snapshotDate: new Date('2026-08-01T00:00:00Z'),
    age0to90: 10,
    age91to180: 30,
    age181to270: 40,
    age271to365: 10,
    age365plus: 5,
    age0to30: null,
    age31to60: null,
    age61to90: null,
    age366to455: null,
    age456plus: null,
  }
  const planning = { snapshotDate: new Date('2026-08-01T00:00:00Z'), aisEst271To300: 10, aisEst301To330: 10, aisEst331To365: 0, aisEst365Plus: 50 }
  const withAge = (sku: string, over: Record<string, unknown> = {}, policy: InventoryPolicy = POLICY) => fact(sku, { age: { ...age, ...over } as never, planning: planning as never, policy })

  it('最迟 30 天内跨入收费档的列出，合计预计新增附加费作为影响金额；库存规则起算天数以下的档不看', () => {
    const hits = buildAgingHits(setOf([withAge('OLD')]), rule())
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('OLD 有 50 件最迟 8 天内进入库龄附加费档')
    const tiers = (hits[0].evidence as { tiers: Array<{ boundaryDays: number; qty: number; estimatedIncrease: number | null }> }).tiers
    // 271 档：40 件 × (20 ÷ 10)；366 档：10 件 × (50 ÷ 5)；181 档（库龄 91-180）低于起算天数 271，不看
    expect(tiers.map(tier => [tier.boundaryDays, tier.qty, tier.estimatedIncrease])).toEqual([
      [271, 40, 80],
      [366, 10, 100],
    ])
    expect(hits[0].impact).toEqual({ min: 180, max: 180 })
  })

  it('预警天数收窄后只剩更近的一档；窗口之外的不报', () => {
    const near = buildAgingHits(setOf([withAge('OLD')]), rule({ warnDays: 10 }))
    expect((near[0].evidence as { tiers: unknown[] }).tiers).toHaveLength(1)
    expect(near[0].impact).toEqual({ min: 80, max: 80 })
    expect(buildAgingHits(setOf([withAge('OLD')]), rule({ warnDays: 5 }))).toEqual([])
  })

  it('没有该档单价可推算时不给影响金额（不写 0）；已经全部跨过的档不报；没有库龄快照不报', () => {
    const noReference = buildAgingHits(setOf([withAge('N', { age365plus: 0 })]), rule())
    expect(noReference[0].impact).toBeUndefined()
    expect((noReference[0].evidence as { estimatedIncrease: unknown }).estimatedIncrease).toBeNull()
    // 快照在一年前：窗口早已过去
    expect(buildAgingHits(setOf([fact('STALE', { age: { ...age, snapshotDate: new Date('2025-01-01T00:00:00Z') } as never, planning: planning as never })]), rule())).toEqual([])
    expect(buildAgingHits(setOf([fact('NONE')]), rule())).toEqual([])
  })

  it('库存规则的起算天数放宽到 181 后，91-180 天的库存也进入判断', () => {
    const wide = { ...POLICY, agingFromDays: 181 as const }
    // 91-180 天的 30 件最迟 10 月 30 日满 181 天；该档没有单价可推算，不给影响金额
    const hits = buildAgingHits(setOf([withAge('W', {}, wide)], wide), rule())
    const tiers = (hits[0].evidence as { tiers: Array<{ boundaryDays: number; qty: number }> }).tiers
    expect(tiers.map(tier => [tier.boundaryDays, tier.qty])).toEqual([
      [181, 30],
      [271, 40],
      [366, 10],
    ])
    expect(hits[0].impact).toBeUndefined()
  })
})

describe('低库存水平费风险', () => {
  const planningWith = (applied: string | null, fee: number | null) =>
    ({ snapshotDate: new Date('2026-10-20T00:00:00Z'), lowInventoryLevelFeeApplied: applied, lowInventoryLevelFee: fee, currency: 'USD' }) as never

  it('报告标明已收取或预估费用大于 0 的才报；没有规划报告不判定；费用大的排前面', () => {
    const facts = [
      fact('A', { planning: planningWith('Yes', 3) }),
      fact('B', { planning: planningWith('No', 0) }),
      fact('C', { planning: planningWith('No', 8.5) }),
      fact('D', { planning: planningWith('是', null) }),
      fact('E'),
    ]
    const hits = buildLowFeeHits(setOf(facts), rule())
    expect(skus(hits)).toEqual(['C', 'A', 'D'])
    expect(hits[0].impact).toEqual({ min: 8.5, max: 8.5, currency: 'USD' })
    expect(hits[2].impact).toBeUndefined() // 报告没给金额：不写影响金额
  })
})

describe('滞留', () => {
  it('滞留库存报告有数量，或库存记录带滞留原因的才报；数量多的排前面', () => {
    const facts = [
      fact('A', { stranded: { qty: 3, reason: '缺少刊登' } }),
      fact('B', { stranded: { qty: 20, reason: null } }),
      fact('C', { strandedReason: 'MISSING_LISTING' }),
      fact('D', { stranded: { qty: 0, reason: null } }),
      fact('E'),
    ]
    const hits = buildStrandedHits(setOf(facts), rule())
    expect(skus(hits)).toEqual(['B', 'A', 'C'])
    expect(hits[0].title).toBe('B 有 20 件滞留')
    expect(hits[1].suggestedAction).toContain('缺少刊登')
    expect(hits[2].title).toBe('C 库存滞留')
  })
})
