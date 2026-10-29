import type { ReplenishPolicy } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { demand, TODAY } from '../inventory/inventory-fixtures.test-helper'
import { computeReplenishment, modeLeads, type EngineInput } from './replenishment-engine'

const policy = (over: Partial<ReplenishPolicy> = {}): ReplenishPolicy => ({
  versionNo: 4,
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
  // 旧用例的数字是“必断货量计入”时的结果；默认关闭的行为见 replenishment-supply.test.ts
  includeUnavoidableShortage: true,
  ...over,
})

const input = (over: Partial<EngineInput> = {}): EngineInput => ({
  today: TODAY,
  policy: policy(),
  quantity: { sellable: 200, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 },
  demand: demand(),
  subscribe: null,
  supply: { awd: null, domestic: null, purchaseInTransit: null },
  ...over,
})

describe('补货计算链：状态', () => {
  it('没有策略 / 没有库存数量 / 没有销量 / 参数不全：各给明确的原因，不产出数量', () => {
    expect(computeReplenishment(input({ policy: null }))).toMatchObject({ state: 'NO_POLICY', recommendedQty: 0, steps: [] })
    expect(computeReplenishment(input({ quantity: { sellable: null, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 } })).state).toBe('NO_QUANTITY')
    expect(computeReplenishment(input({ demand: demand({ mid: null, low: null, high: null }) })).state).toBe('NO_DEMAND')
    expect(computeReplenishment(input({ policy: policy({ serviceLevel: null }) })).state).toBe('POLICY_INCOMPLETE')
    expect(computeReplenishment(input({ policy: policy({ productionDays: null }) })).state).toBe('POLICY_INCOMPLETE')
  })

  it('没有设置运输选项时不要求拆分的提前期，直接用策略总提前期', () => {
    expect(modeLeads(policy({ transportOptions: [], productionDays: null }))).toEqual({ leads: [], split: false })
    const calc = computeReplenishment(input({ policy: policy({ transportOptions: [], productionDays: null, domesticDays: null, receivingDays: null }) }))
    expect(calc.state).toBe('OK')
    expect(calc.shipments).toMatchObject([{ mode: 'DEFAULT', leadDays: 30, shipDate: null }])
  })
})

describe('补货计算链：8 步', () => {
  const calc = computeReplenishment(input())

  it('每一步都有标题、公式与结果，共 8 步，顺序固定', () => {
    expect(calc.steps.map(step => step.key)).toEqual(['DEMAND', 'SUPPLY', 'LEAD_TIME', 'SAFETY', 'TARGET', 'QTY', 'TRANSPORT', 'TIMING'])
    for (const step of calc.steps) {
      expect(step.formula.length).toBeGreaterThan(5)
      expect(step.result.length).toBeGreaterThan(2)
    }
  })

  it('数值：日销 10；安全库存 = max(统计 0, 14 天 × 10) = 140；目标 = max(600, 10 × 50 + 140) = 640；缺口 440', () => {
    expect(calc).toMatchObject({ state: 'OK', dailyDemand: 10, rawQty: 440, recommendedQty: 440, purchaseQty: 440, daysOfCover: 20, stockoutDate: '2026-11-11' })
    const byKey = Object.fromEntries(calc.steps.map(step => [step.key, step]))
    expect(byKey.SAFETY.result).toContain('140')
    expect(byKey.TARGET.result).toContain('640.0')
    expect(byKey.QTY.details[0].value).toBe('640.0 − 200 = 440.0')
  })

  it('时间：来不及断货前到仓时今天下单，到仓日 = 下单日 + 提前期（生产 10 + 国内 3 + 接收 7 + 头程 30 = 50）', () => {
    expect(calc).toMatchObject({ orderDate: TODAY, shipDate: '2026-11-04', arriveDate: '2026-12-11' })
    expect(calc.shipments[0]).toMatchObject({ mode: 'SEA', qty: 440, leadDays: 50, lateDays: 30, unitCost: 0.5 })
    expect(calc.landedCost).toBe(220)
  })

  it('未接入的供给来源在步骤里写“尚未接入”，不当 0', () => {
    const supply = calc.steps.find(step => step.key === 'SUPPLY')
    expect(supply?.details.filter(detail => detail.value === '尚未接入')).toHaveLength(2)
    expect(supply?.details.find(detail => detail.label.startsWith('上游仓储'))?.value).toContain('没有记录')
    expect(calc.steps.find(step => step.key === 'QTY')?.details[2].value).toBe('尚未接入')
  })

  it('上游仓储有数时在供给步骤里显示数字，只减少采购量，不改变补到亚马逊物流的建议量', () => {
    const result = computeReplenishment(input({ supply: { awd: 120, domestic: null, purchaseInTransit: null } }))
    expect(result.steps.find(step => step.key === 'SUPPLY')?.details.find(detail => detail.label.startsWith('上游仓储'))?.value).toBe('120')
    expect(result.recommendedQty).toBe(calc.recommendedQty)
    expect(result.purchaseQty).toBeLessThan(calc.purchaseQty)
  })

  it('同一份输入永远得到同一份结果', () => {
    expect(computeReplenishment(input())).toEqual(calc)
  })
})

describe('补货计算链：边界', () => {
  it('库存足够：无需补货，但仍给出风险与可售天数', () => {
    const result = computeReplenishment(input({ quantity: { sellable: 1000, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 } }))
    expect(result).toMatchObject({ state: 'NO_NEED', recommendedQty: 0, purchaseQty: 0, shipments: [], daysOfCover: 100 })
    expect(result.steps).toHaveLength(8)
  })

  it('下单日：断货日足够远时按“断货日 − 最长提前期”晚下单', () => {
    // 可售 600 → 可售 60 天，断货日 +60；缺口 = 640 − 600 = 40；提前期 50 → 下单日 +10
    const result = computeReplenishment(input({ quantity: { sellable: 600, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 } }))
    expect(result).toMatchObject({ recommendedQty: 40, orderDate: '2026-11-01', arriveDate: '2026-12-21' })
    expect(result.shipments[0].lateDays).toBe(0)
  })

  it('计入在途按策略口径：只计入已发货时，处理中的不算', () => {
    const result = computeReplenishment(input({ policy: policy({ inboundCounted: ['SHIPPED'] }), quantity: { sellable: 100, inboundWorking: 50, inboundShipped: 100, inboundReceiving: 0 } }))
    expect(result.rawQty).toBe(440)
    expect(result.steps[1].result).toContain('可用 200 件')
  })

  it('采购量 = 补货量 − 已有采购侧供给，再按最小起订量与箱规取整；供给已覆盖时为 0', () => {
    const covered = computeReplenishment(input({ supply: { awd: 500, domestic: null, purchaseInTransit: null } }))
    expect(covered).toMatchObject({ recommendedQty: 440, purchaseQty: 0 })
    const partial = computeReplenishment(input({ supply: { awd: 400, domestic: null, purchaseInTransit: null } }))
    // 440 − 400 = 40 < 起订量 100 → 100
    expect(partial.purchaseQty).toBe(100)
  })

  it('箱规取整：缺口 441 → 450', () => {
    const result = computeReplenishment(input({ quantity: { sellable: 199, inboundWorking: 0, inboundShipped: 0, inboundReceiving: 0 } }))
    expect(result.rawQty).toBe(441)
    expect(result.recommendedQty).toBe(450)
  })

  it('统计安全库存：销量波动大时 z × σ × √提前期 超过策略下限', () => {
    const volatile = demand({ units7: 140, units30: 300, units60: 600, units90: 900 })
    const result = computeReplenishment(input({ demand: volatile }))
    const safety = result.steps.find(step => step.key === 'SAFETY')
    expect(Number(safety?.details[2].value)).toBeGreaterThan(0)
    expect(result.steps.find(step => step.key === 'SAFETY')?.details[1].value).not.toContain('历史不足')
  })

  it('历史不足以估计波动：统计安全库存按 0，只剩策略下限，并写明', () => {
    const result = computeReplenishment(input({ demand: demand({ historyDays: 20 }) }))
    expect(result.steps.find(step => step.key === 'SAFETY')?.details[1].value).toBe('历史不足，无法估计')
  })

  it('订阅省叠加后在第 1 步体现，并标记已使用', () => {
    const result = computeReplenishment(input({ subscribe: { forecastNext30: 90, shippedUnitsPrevMonth: 60, prevMonthDays: 30, snapshotDate: TODAY, eligibility: 'ELIGIBLE' } }))
    expect(result.subscribeUsed).toBe(true)
    expect(result.dailyDemand).toBe(11)
    expect(computeReplenishment(input()).subscribeUsed).toBe(false)
  })

  it('日销区间：低档与高档给出建议量范围，低 ≤ 中 ≤ 高', () => {
    const result = computeReplenishment(input())
    expect(result.qtyLow).toBeLessThanOrEqual(result.recommendedQty)
    expect(result.qtyHigh).toBeGreaterThanOrEqual(result.recommendedQty)
  })

  it('置信度：订单历史越长越高；报告来源较低；范围 0.2–0.95', () => {
    const long = computeReplenishment(input()).confidence
    const short = computeReplenishment(input({ demand: demand({ historyDays: 35 }) })).confidence
    const report = computeReplenishment(input({ demand: demand({ source: 'AMAZON_REPORT', historyDays: null }) })).confidence
    expect(long).toBeGreaterThan(short)
    expect(short).toBeGreaterThan(report - 0.001)
    expect(long).toBeLessThanOrEqual(0.95)
  })

  it('多运输方式：成本都设置时按成本与断货风险拆分，并写在发运批次里', () => {
    const multi = policy({
      transportOptions: [
        { mode: 'SEA', transitDays: 30, unitCost: 0.5 },
        { mode: 'EXPRESS', transitDays: 3, unitCost: 4 },
      ],
    })
    const result = computeReplenishment(input({ policy: multi }))
    expect(result.shipments.map(shipment => shipment.mode)).toEqual(['EXPRESS', 'SEA'])
    expect(result.shipments.reduce((total, shipment) => total + shipment.qty, 0)).toBe(result.recommendedQty)
    expect(result.landedCost).not.toBeNull()
  })

  it('最小起订金额只提示不校验（商品成本尚未接入）', () => {
    const result = computeReplenishment(input({ policy: policy({ minOrderValue: 500 }) }))
    expect(result.steps.find(step => step.key === 'QTY')?.notes.join('')).toContain('尚未校验')
  })
})
