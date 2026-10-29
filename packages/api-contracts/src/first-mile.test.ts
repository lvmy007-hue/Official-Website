import { describe, expect, it } from 'vitest'
import {
  FirstMileAllocateBodySchema,
  FirstMileCostBodySchema,
  FirstMileCreateBodySchema,
  FirstMileUpdateBodySchema,
  firstMileActions,
  firstMileStage,
  percentileOf,
  shipmentDateIssues,
} from './first-mile.js'

// 头程物流契约：请求体校验、阶段与可用动作、分位数。

const base = {
  forwarderId: 'f1',
  waybillNo: 'WB-1',
  mode: 'SEA',
  customsStatus: 'NOT_STARTED',
  currency: 'usd',
  linkedInboundShipmentIds: [],
  items: [{ sku: 'SKU-A', quantity: 10 }],
}

describe('运单请求体', () => {
  it('最小合法体通过；币种转大写', () => {
    const parsed = FirstMileCreateBodySchema.parse(base)
    expect(parsed.currency).toBe('USD')
  })

  it('至少一个明细；同一 SKU 不能重复；数量至少为 1', () => {
    expect(FirstMileCreateBodySchema.safeParse({ ...base, items: [] }).success).toBe(false)
    expect(
      FirstMileCreateBodySchema.safeParse({
        ...base,
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'A', quantity: 2 },
        ],
      }).success,
    ).toBe(false)
    expect(FirstMileCreateBodySchema.safeParse({ ...base, items: [{ sku: 'A', quantity: 0 }] }).success).toBe(false)
    expect(FirstMileCreateBodySchema.safeParse({ ...base, items: [{ sku: 'A', quantity: 1, volumeCbm: -1 }] }).success).toBe(false)
  })

  it('日期先后：到港与交付不能早于发货日，实际交付不能早于实际到港', () => {
    expect(FirstMileCreateBodySchema.safeParse({ ...base, shipDate: '2026-10-10', etaPort: '2026-10-09' }).success).toBe(false)
    expect(FirstMileCreateBodySchema.safeParse({ ...base, shipDate: '2026-10-10', ataPort: '2026-10-20', ataDelivery: '2026-10-19' }).success).toBe(false)
    expect(FirstMileCreateBodySchema.safeParse({ ...base, shipDate: '2026-10-10', etaPort: '2026-10-30', ataDelivery: '2026-11-10' }).success).toBe(true)
    expect(shipmentDateIssues({ shipDate: '2026-10-10', etaDelivery: '2026-10-01' })).toEqual([{ path: 'etaDelivery', message: '预计交付不能早于发货日' }])
  })

  it('修改只需要版本号；传了的字段才校验，明细传了就不能为空', () => {
    expect(FirstMileUpdateBodySchema.safeParse({ version: 1 }).success).toBe(true)
    expect(FirstMileUpdateBodySchema.safeParse({ version: 1, estimatedCost: null, containerNo: null }).success).toBe(true)
    expect(FirstMileUpdateBodySchema.safeParse({ version: 1, items: [] }).success).toBe(false)
    expect(FirstMileUpdateBodySchema.safeParse({ estimatedCost: 1 }).success).toBe(false)
    expect(FirstMileUpdateBodySchema.safeParse({ version: 1, mode: 'TRUCK' }).success).toBe(false)
  })

  it('费用金额必须大于 0；分摊口径只认四种', () => {
    const cost = { version: 1, item: 'FREIGHT', amount: 100, incurredAt: '2026-10-01' }
    expect(FirstMileCostBodySchema.safeParse(cost).success).toBe(true)
    expect(FirstMileCostBodySchema.safeParse({ ...cost, amount: 0 }).success).toBe(false)
    expect(FirstMileCostBodySchema.safeParse({ ...cost, item: 'TIP' }).success).toBe(false)
    expect(FirstMileAllocateBodySchema.safeParse({ version: 1, method: 'WEIGHT' }).success).toBe(true)
    expect(FirstMileAllocateBodySchema.safeParse({ version: 1, method: 'AVERAGE' }).success).toBe(false)
  })
})

describe('阶段、动作与分位数', () => {
  it('阶段按实际日期推出：交付 > 到港 > 发货 > 待发运', () => {
    expect(firstMileStage({ shipDate: null, ataPort: null, ataDelivery: null })).toBe('PLANNED')
    expect(firstMileStage({ shipDate: '2026-10-01', ataPort: null, ataDelivery: null })).toBe('IN_TRANSIT')
    expect(firstMileStage({ shipDate: '2026-10-01', ataPort: '2026-10-20', ataDelivery: null })).toBe('ARRIVED')
    expect(firstMileStage({ shipDate: '2026-10-01', ataPort: '2026-10-20', ataDelivery: '2026-10-25' })).toBe('DELIVERED')
  })

  it('可用动作：分摊后费用锁定只能撤销；没选国内仓或已出库不能出库；没有费用不能分摊', () => {
    const open = { hasCosts: true, hasItems: true, allocated: false, outbound: false, hasWarehouse: true }
    expect(firstMileActions(open)).toEqual(['EDIT', 'ADD_MILESTONE', 'ADD_COST', 'ALLOCATE', 'OUTBOUND'])
    expect(firstMileActions({ ...open, allocated: true })).toEqual(['EDIT', 'ADD_MILESTONE', 'UNALLOCATE', 'OUTBOUND'])
    expect(firstMileActions({ ...open, hasCosts: false, hasWarehouse: false })).toEqual(['EDIT', 'ADD_MILESTONE', 'ADD_COST'])
    expect(firstMileActions({ ...open, outbound: true })).not.toContain('OUTBOUND')
  })

  it('分位数：最近邻法，没有样本为 null', () => {
    expect(percentileOf([], 0.5)).toBeNull()
    expect(percentileOf([5, 1, 3], 0.5)).toBe(3)
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9)
  })
})
