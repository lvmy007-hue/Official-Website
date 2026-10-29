import type { ReplenishPolicy } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { demand, TODAY } from '../inventory/inventory-fixtures.test-helper'
import { computeReplenishment, type EngineInput } from './replenishment-engine'
import { planDemand, type ResolvedOverride } from './replenishment-override'
import { splitSupply, unavoidableShortage } from './replenishment-supply'

// P6-09：提前期内 / 提前期外供给、必断货量与人工预测规则（纯函数，不读数据库）。
const basePolicy = (over: Partial<ReplenishPolicy> = {}): ReplenishPolicy => ({
  versionNo: 1,
  level: 'TENANT',
  levelRef: 'ALL',
  leadTimeDays: 30,
  awdLeadTimeDays: null,
  safetyDays: 14,
  coverageDays: 60,
  redundancyMultiplier: 1.5,
  inboundCounted: ['WORKING', 'SHIPPED', 'RECEIVING'],
  agingFromDays: 271,
  effectiveFrom: '2026-10-01',
  changeReason: '测试',
  createdBy: '测试成员',
  createdAt: '2026-10-01T00:00:00.000Z',
  productionDays: 10,
  domesticDays: 3,
  receivingDays: 7,
  serviceLevel: 0.95,
  transportPreference: 'AUTO',
  transportOptions: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
  casePackQty: 10,
  moq: 100,
  minOrderValue: null,
  includeUnavoidableShortage: false,
  ...over,
})

const input = (over: Partial<EngineInput> = {}): EngineInput => ({
  today: TODAY,
  policy: basePolicy(),
  quantity: { sellable: 100, inboundWorking: 0, inboundShipped: 100, inboundReceiving: 0 },
  demand: demand(),
  subscribe: null,
  supply: { awd: null, domestic: null, purchaseInTransit: null },
  ...over,
})

// “提前期外”场景：固定偏好空运（主提前期 23 天），已发货的在途要 37 天才到，晚于主提前期
const beyond = (include: boolean) =>
  input({
    policy: basePolicy({
      transportPreference: 'AIR',
      transportOptions: [
        { mode: 'SEA', transitDays: 30, unitCost: 0.5 },
        { mode: 'AIR', transitDays: 3, unitCost: 4 },
      ],
      includeUnavoidableShortage: include,
    }),
  })
// “提前期内”场景：只有海运（主提前期 50 天），已发货的在途 37 天到，在主提前期内
const inside = (include: boolean) => input({ policy: basePolicy({ includeUnavoidableShortage: include }) })

describe('供给拆成提前期内与提前期外', () => {
  it('已发货在途晚于主提前期到仓：不算提前期内供给，单独列出', () => {
    const result = computeReplenishment(beyond(false))
    expect(result).toMatchObject({ supplyInLeadTime: 100, supplyBeyondLeadTime: 100 })
    const supply = result.steps.find(step => step.key === 'SUPPLY')
    expect(supply?.result).toContain('提前期内')
    expect(supply?.result).toContain('提前期外')
  })

  it('在途在主提前期内到仓：全部算提前期内供给', () => {
    expect(computeReplenishment(inside(false))).toMatchObject({ supplyInLeadTime: 200, supplyBeyondLeadTime: 0 })
  })

  it('同样的库存与在途，晚到的在途不抵缺口：提前期外的建议量更大（必断货量计入时对比）', () => {
    expect(computeReplenishment(inside(true)).recommendedQty).toBe(440)
    expect(computeReplenishment(beyond(true)).recommendedQty).toBe(500)
  })

  it('没有设置运输选项：无法估算到仓时间，在途一律按提前期内处理并写明', () => {
    const result = computeReplenishment(input({ policy: basePolicy({ transportOptions: [], productionDays: null, domesticDays: null, receivingDays: null }) }))
    expect(result).toMatchObject({ supplyInLeadTime: 200, supplyBeyondLeadTime: 0 })
    expect(JSON.stringify(result.steps[1])).toContain('无法估算')
  })

  it('splitSupply：处理中 = 国内 + 最慢头程 + 接收；接收中 = 接收天数；策略没计入的类型不出现', () => {
    const policy = basePolicy({ inboundCounted: ['WORKING', 'RECEIVING'] })
    const split = splitSupply({
      policy,
      leads: [{ mode: 'SEA', leadDays: 50, unitCost: 0.5 }],
      split: true,
      refDays: 45,
      sellable: 10,
      inbound: { WORKING: 5, SHIPPED: 7, RECEIVING: 3 },
    })
    expect(split.parts.map(part => [part.kind, part.offsetDays, part.inLead])).toEqual([
      ['SELLABLE', 0, true],
      ['WORKING', 40, true],
      ['RECEIVING', 7, true],
    ])
    expect(split.inLeadQty).toBe(18)
    expect(split.availableBy(10)).toBe(13)
  })
})

describe('必断货量：四种组合（供给在提前期内 / 提前期外 × 计入开关 关 / 开）', () => {
  it('提前期内 × 关：必断货量 300 不计入，建议量 = 440 − 300 = 140', () => {
    expect(computeReplenishment(inside(false))).toMatchObject({ unavoidableShortage: 300, unavoidableIncluded: false, recommendedQty: 140, rawQty: 140 })
  })

  it('提前期内 × 开：必断货量仍单独显示，但计入建议量 440', () => {
    expect(computeReplenishment(inside(true))).toMatchObject({ unavoidableShortage: 300, unavoidableIncluded: true, recommendedQty: 440 })
  })

  it('提前期外 × 关：最快 23 天内需求 230 − 可售 100 = 必断货量 130；建议量 = 500 − 130 = 370', () => {
    expect(computeReplenishment(beyond(false))).toMatchObject({ unavoidableShortage: 130, unavoidableIncluded: false, recommendedQty: 370 })
  })

  it('提前期外 × 开：必断货量 130 计入，建议量 500', () => {
    expect(computeReplenishment(beyond(true))).toMatchObject({ unavoidableShortage: 130, unavoidableIncluded: true, recommendedQty: 500 })
  })

  it('计算链第 6 步写明必断货量与开关状态', () => {
    const off = computeReplenishment(beyond(false)).steps.find(step => step.key === 'QTY')
    expect(JSON.stringify(off)).toContain('必断货量')
    expect(JSON.stringify(off)).toContain('不计入')
    const on = computeReplenishment(beyond(true)).steps.find(step => step.key === 'QTY')
    expect(JSON.stringify(on)).toContain('已计入')
  })

  it('缺口全部是必断货量且开关关闭：无需补货，原因里点明', () => {
    const result = computeReplenishment(input({ quantity: { sellable: 300, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 }, policy: basePolicy({ coverageDays: 20, safetyDays: 0 }) }))
    expect(result.unavoidableShortage).toBeGreaterThan(0)
    expect(result.state).toBe('NO_NEED')
  })

  it('库存充足时没有必断货量', () => {
    const result = computeReplenishment(input({ quantity: { sellable: 2000, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 } }))
    expect(result.unavoidableShortage).toBe(0)
  })

  it('unavoidableShortage：需求不足以耗尽供给时为 0；用逐日需求函数计算', () => {
    const supply = splitSupply({ policy: basePolicy(), leads: [], split: false, refDays: 30, sellable: 100, inbound: { WORKING: 0, SHIPPED: 0, RECEIVING: 0 } })
    expect(unavoidableShortage({ fastestLead: 30, demandOver: days => days * 3, supply })).toBe(0)
    expect(unavoidableShortage({ fastestLead: 30, demandOver: days => days * 4, supply })).toBe(20)
  })
})

const rule = (over: Partial<ResolvedOverride> = {}): ResolvedOverride => ({
  id: 'o1',
  scopeType: 'SKU',
  scopeId: 'SKU-1',
  mode: 'FIXED',
  value: 20,
  from: TODAY,
  to: '2027-12-31',
  rate: 20,
  ...over,
})
const model = { low: 8, mid: 10, high: 12 }

describe('人工预测规则进入计算链', () => {
  it('没有规则：原样返回模型的日销', () => {
    const plan = planDemand(model, TODAY, 60, [])
    expect(plan).toMatchObject({ low: 8, mid: 10, high: 12, changedDays: 0, applied: [] })
  })

  it('规则覆盖整个预测范围：日销取规则值；高中低三档都变成规则值', () => {
    const plan = planDemand(model, TODAY, 60, [rule()])
    expect(plan).toMatchObject({ low: 20, mid: 20, high: 20, changedDays: 60 })
    expect(plan.applied[0]).toMatchObject({ id: 'o1', applied: true, days: 60 })
  })

  it('规则只覆盖前 30 天：范围内的平均日销 = (30 × 20 + 30 × 10) / 60 = 15', () => {
    const plan = planDemand(model, TODAY, 60, [rule({ to: '2026-11-20' })])
    expect(plan.changedDays).toBe(30)
    expect(plan.mid).toBe(15)
  })

  it('SKU 规则优先于品类规则；同一天只用一条', () => {
    const plan = planDemand(model, TODAY, 10, [rule({ id: 'c1', scopeType: 'CATEGORY', scopeId: '耳机', rate: 30 }), rule({ id: 's1', rate: 5 })])
    expect(plan.mid).toBe(5)
    expect(plan.applied.find(item => item.id === 'c1')).toMatchObject({ applied: false, days: 0 })
  })

  it('规则整段在预测范围之外：不改变预测，计算链记录“未生效”', () => {
    const plan = planDemand(model, TODAY, 30, [rule({ from: '2027-06-01', to: '2027-06-30' })])
    expect(plan).toMatchObject({ mid: 10, changedDays: 0, applied: [] })
  })

  it('去年同期没有销量记录（rate 为 null）：规则不生效，按模型预测，不当 0', () => {
    const plan = planDemand(model, TODAY, 60, [rule({ mode: 'YOY_FACTOR', value: 1.2, rate: null })])
    expect(plan.mid).toBe(10)
    expect(plan.applied[0]).toMatchObject({ applied: false })
    expect(plan.applied[0]?.note).toContain('去年同期')
  })

  it('固定日销为 0 表示这段时间不卖：日销取 0，不被当作“没有规则”', () => {
    const plan = planDemand(model, TODAY, 10, [rule({ rate: 0, value: 0 })])
    expect(plan.mid).toBe(0)
    expect(plan.changedDays).toBe(10)
  })

  it('引擎：规则抬高日销，建议量变大，计算链第 1 步写明用了哪条规则，并记录在 appliedOverride', () => {
    const plain = computeReplenishment(inside(true))
    const withRule = computeReplenishment({ ...inside(true), overrides: [rule()] })
    expect(withRule.dailyDemand).toBe(20)
    expect(withRule.recommendedQty).toBeGreaterThan(plain.recommendedQty)
    expect(withRule.appliedOverride).toHaveLength(1)
    expect(withRule.appliedOverride[0]).toMatchObject({ id: 'o1', applied: true })
    expect(JSON.stringify(withRule.steps[0])).toContain('人工预测规则')
    expect(plain.appliedOverride).toEqual([])
  })

  it('引擎：规则让日销降到 0 的几天，预计断货日比纯模型更晚', () => {
    const plain = computeReplenishment(inside(true))
    const quiet = computeReplenishment({ ...inside(true), overrides: [rule({ rate: 0, value: 0, to: '2026-11-10' })] })
    expect((quiet.stockoutDate ?? '') > (plain.stockoutDate ?? '')).toBe(true)
  })
})
