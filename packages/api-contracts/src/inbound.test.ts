import { describe, expect, it } from 'vitest'
import {
  INBOUND_ACTIONS,
  INBOUND_STAGES,
  INBOUND_STEP_CHAIN,
  INBOUND_SWITCH_KEYS,
  InboundBoxesBodySchema,
  InboundPlanCreateBodySchema,
  InboundTrackingBodySchema,
  inboundPlanActions,
  parseBoxLines,
  placementTotalCost,
  recommendPlacement,
  shippingModeOf,
  validateBoxes,
  voidDeadlineOf,
  voidWindowOf,
  type InboundStage,
} from './index'

const shipment = (destinationFc: string | null, units: number | null) => ({ destinationFc, units }) as never
const NOW = new Date('2026-10-22T08:00:00Z')

describe('入仓计划动作可用性（前后端共用）', () => {
  const allowed = (stage: InboundStage, over: { pendingOp?: string | null; voidDeadlineAt?: Date | null } = {}) => {
    const actions = inboundPlanActions({ stage, pendingOp: over.pendingOp ?? null, voidDeadlineAt: over.voidDeadlineAt ?? null }, NOW)
    return INBOUND_ACTIONS.filter(action => actions[action].allowed)
  }

  it('每个阶段只开放这一阶段该做的动作', () => {
    expect(allowed('DRAFT')).toEqual(['ELIGIBILITY', 'CANCEL'])
    expect(allowed('ELIGIBILITY')).toEqual(['ELIGIBILITY', 'SUBMIT', 'CANCEL'])
    expect(allowed('CREATED')).toEqual(['GENERATE_PACKING', 'CONFIRM_PACKING', 'CANCEL'])
    expect(allowed('PACKING_CONFIRMED')).toEqual(['SAVE_BOXES', 'SUBMIT_PACKING_INFO', 'CANCEL'])
    expect(allowed('PACKING_INFO_SUBMITTED')).toEqual(['GENERATE_PLACEMENT', 'CONFIRM_PLACEMENT', 'CANCEL'])
    expect(allowed('PLACEMENT_CONFIRMED')).toEqual(['GENERATE_TRANSPORT', 'GENERATE_WINDOWS', 'CONFIRM_WINDOW', 'CONFIRM_TRANSPORT', 'CANCEL'])
    expect(allowed('SHIPPED')).toEqual(['UPDATE_TRACKING'])
    expect(allowed('RECEIVING')).toEqual(['UPDATE_TRACKING'])
    expect(allowed('COMPLETED')).toEqual([])
    expect(allowed('CANCELLED')).toEqual([])
  })

  it('有操作处理中时一律不可做，并说明原因', () => {
    const actions = inboundPlanActions({ stage: 'CREATED', pendingOp: 'GENERATE_PACKING', voidDeadlineAt: null }, NOW)
    for (const action of INBOUND_ACTIONS) expect(actions[action]).toMatchObject({ allowed: false, reason: expect.stringContaining('正在处理') })
  })

  it('运输方案确认后：作废窗口内可以取消，窗口已过或没取到窗口信息不能取消；货件发出后不能取消', () => {
    const future = new Date(NOW.getTime() + 3_600_000)
    const past = new Date(NOW.getTime() - 1000)
    expect(allowed('TRANSPORT_CONFIRMED', { voidDeadlineAt: future })).toContain('CANCEL')
    expect(allowed('LABELS_PRINTED', { voidDeadlineAt: future })).toEqual(['PRINT_LABELS', 'MARK_SHIPPED', 'UPDATE_TRACKING', 'CANCEL'])
    expect(allowed('TRANSPORT_CONFIRMED', { voidDeadlineAt: past })).not.toContain('CANCEL')
    const unknown = inboundPlanActions({ stage: 'TRANSPORT_CONFIRMED', pendingOp: null, voidDeadlineAt: null }, NOW)
    expect(unknown.CANCEL).toMatchObject({ allowed: false, reason: expect.stringContaining('作废窗口') })
    expect(inboundPlanActions({ stage: 'SHIPPED', pendingOp: null, voidDeadlineAt: future }, NOW).CANCEL.allowed).toBe(false)
  })

  it('没到那一步时提示先做哪一步', () => {
    const actions = inboundPlanActions({ stage: 'TRANSPORT_CONFIRMED', pendingOp: null, voidDeadlineAt: null }, NOW)
    expect(actions.MARK_SHIPPED.reason).toContain('标签')
    expect(inboundPlanActions({ stage: 'DRAFT', pendingOp: null, voidDeadlineAt: null }, NOW).SUBMIT.reason).toContain('资格预检')
  })

  it('阶段链：十三个阶段，步骤条不含已取消；写入开关只有五个', () => {
    expect(INBOUND_STAGES).toHaveLength(13)
    expect(INBOUND_STEP_CHAIN).toHaveLength(12)
    expect(INBOUND_STEP_CHAIN).not.toContain('CANCELLED')
    expect([...INBOUND_SWITCH_KEYS].sort()).toEqual([
      'sw.inbound.packing.confirm',
      'sw.inbound.packinginfo.submit',
      'sw.inbound.placement.confirm',
      'sw.inbound.plan.create',
      'sw.inbound.transport.confirm',
    ])
  })
})

describe('作废窗口', () => {
  it('按运输方式：小包裹 24 小时，零担与整车 1 小时；亚马逊给了截止时间就以它为准', () => {
    expect(voidDeadlineOf(NOW, 'SPD')?.toISOString()).toBe('2026-10-23T08:00:00.000Z')
    expect(voidDeadlineOf(NOW, 'LTL')?.toISOString()).toBe('2026-10-22T09:00:00.000Z')
    expect(voidDeadlineOf(NOW, 'FTL')?.toISOString()).toBe('2026-10-22T09:00:00.000Z')
    expect(voidDeadlineOf(NOW, null)).toBeNull()
    const given = new Date('2026-10-22T08:30:00Z')
    expect(voidDeadlineOf(NOW, 'SPD', given)).toBe(given)
    expect(voidDeadlineOf(NOW, 'SPD', new Date('2026-10-22T07:00:00Z'))?.toISOString()).toBe('2026-10-23T08:00:00.000Z')
  })

  it('倒计时：未知、剩余、已过', () => {
    expect(voidWindowOf(null, NOW)).toMatchObject({ known: false, remainingMs: null, expired: false })
    expect(voidWindowOf(new Date(NOW.getTime() + 5000), NOW)).toMatchObject({ known: true, remainingMs: 5000, expired: false })
    expect(voidWindowOf(new Date(NOW.getTime() - 5000), NOW)).toMatchObject({ known: true, remainingMs: 0, expired: true })
  })

  it('亚马逊运输方式映射', () => {
    expect(shippingModeOf('GROUND_SMALL_PARCEL')).toBe('SPD')
    expect(shippingModeOf('freight_ltl')).toBe('LTL')
    expect(shippingModeOf('FREIGHT_FTL_53')).toBe('FTL')
    expect(shippingModeOf('AIR')).toBeNull()
    expect(shippingModeOf(null)).toBeNull()
  })
})

describe('分仓方案总成本与推荐', () => {
  const params = { freightPerLb: 0.5, freightPerShipment: 10, dailyStockoutCost: 100, transitDaysByFc: { ONT8: 2, PHX6: 5 } }

  it('总成本 = 分仓费 − 折扣 + 预估运费 + 断货风险成本', () => {
    const cost = placementTotalCost({ fees: 20, discounts: 5, shipments: [shipment('ONT8', 60), shipment('PHX6', 40)] }, { totalWeightLb: 200, params })
    // 运费 0.5×200 + 10×2 = 120；断货：最快 2 天，PHX6 多 3 天×占比 0.4×100 = 120
    expect(cost).toEqual({ fees: 20, discounts: 5, freight: 120, stockout: 120, total: 255, missing: [] })
  })

  it('没填的项为 null 并列出缺什么，不当成 0', () => {
    const none = placementTotalCost({ fees: 20, discounts: 5, shipments: [shipment('ONT8', 60)] }, { totalWeightLb: 200, params: null })
    expect(none).toMatchObject({ freight: null, stockout: null, total: 15 })
    expect(none.missing).toHaveLength(2)
    const noWeight = placementTotalCost({ fees: 0, discounts: 0, shipments: [shipment('ONT8', 60)] }, { totalWeightLb: null, params: { freightPerLb: 1 } })
    expect(noWeight.freight).toBeNull()
    expect(noWeight.missing[0]).toContain('重量')
    const unknownFc = placementTotalCost({ fees: 0, discounts: 0, shipments: [shipment('ONT8', 60), shipment('ZZZ9', 40)] }, { totalWeightLb: 10, params })
    expect(unknownFc.stockout).toBeNull()
    expect(unknownFc.missing.join('')).toContain('ZZZ9')
  })

  it('推荐：只在未过期的可选方案里选总成本最低，并列取货件少的；依据是否完整都要明说', () => {
    const cost = (total: number, missing: string[] = []) => ({ fees: 0, discounts: 0, freight: null, stockout: null, total, missing })
    const option = (placementOptionId: string, total: number, extra: Record<string, unknown> = {}) => ({
      placementOptionId,
      status: 'OFFERED',
      expiresAt: null as string | null,
      shipmentCount: 2,
      cost: cost(total),
      ...extra,
    })
    const full = recommendPlacement([option('A', 50), option('B', 30), option('C', 30, { shipmentCount: 1 })], NOW)
    expect(full).toMatchObject({ placementOptionId: 'C', basis: 'FULL', missing: [] })
    const partial = recommendPlacement([option('A', 50, { cost: cost(50, ['预估运费']) }), option('B', 30)], NOW)
    expect(partial).toMatchObject({ placementOptionId: 'B', basis: 'PARTIAL', missing: ['预估运费'] })
    expect(partial.note).toContain('依据不完整')
    const expired = recommendPlacement([option('A', 10, { expiresAt: '2026-10-22T07:00:00Z' }), option('B', 99, { status: 'ACCEPTED' })], NOW)
    expect(expired).toMatchObject({ placementOptionId: null, basis: 'NONE' })
  })
})

describe('箱内物品校验与批量导入', () => {
  const plan = [
    { sku: 'A', quantity: 10 },
    { sku: 'B', quantity: 4 },
  ]
  const box = (items: Array<{ sku: string; quantity: number }>, quantity = 1, extra: Record<string, unknown> = {}) => ({ quantity, items, ...extra })

  it('每个 SKU 的装箱总数必须等于计划数量（相同箱数要乘进去）', () => {
    expect(
      validateBoxes(plan, [
        box(
          [
            { sku: 'A', quantity: 5 },
            { sku: 'B', quantity: 2 },
          ],
          2,
        ),
      ]),
    ).toMatchObject({ ok: true, problems: [] })
    const short = validateBoxes(plan, [box([{ sku: 'A', quantity: 5 }], 1), box([{ sku: 'B', quantity: 4 }])])
    expect(short.ok).toBe(false)
    expect(short.rows[0]).toEqual({ sku: 'A', planned: 10, packed: 5, diff: -5 })
    expect(short.problems[0]).toContain('少 5')
    expect(
      validateBoxes(plan, [
        box([
          { sku: 'A', quantity: 11 },
          { sku: 'B', quantity: 4 },
        ]),
      ]).problems[0],
    ).toContain('多 1')
  })

  it('没有箱子不通过；计划外的 SKU 不能装', () => {
    expect(validateBoxes(plan, []).ok).toBe(false)
    const unknown = validateBoxes(plan, [
      box([
        { sku: 'A', quantity: 10 },
        { sku: 'B', quantity: 4 },
        { sku: 'Z', quantity: 1 },
      ]),
    ])
    expect(unknown.ok).toBe(false)
    expect(unknown.unknownSkus).toEqual(['Z'])
  })

  it('多个装箱组时每箱必须指明装箱组，且每组数量与组内商品一致', () => {
    const groups = [
      { packingGroupId: 'G1', items: [{ sku: 'A', quantity: 10 }] },
      { packingGroupId: 'G2', items: [{ sku: 'B', quantity: 4 }] },
    ]
    expect(validateBoxes(plan, [box([{ sku: 'A', quantity: 10 }], 1, { packingGroupId: 'G1' }), box([{ sku: 'B', quantity: 4 }], 1, { packingGroupId: 'G2' })], groups).ok).toBe(true)
    const missingGroup = validateBoxes(plan, [box([{ sku: 'A', quantity: 10 }]), box([{ sku: 'B', quantity: 4 }], 1, { packingGroupId: 'G2' })], groups)
    expect(missingGroup.ok).toBe(false)
    expect(missingGroup.problems.join('')).toContain('装箱组')
    const crossed = validateBoxes(plan, [box([{ sku: 'A', quantity: 10 }], 1, { packingGroupId: 'G2' }), box([{ sku: 'B', quantity: 4 }], 1, { packingGroupId: 'G1' })], groups)
    expect(crossed.ok).toBe(false)
  })

  it('批量导入：同箱号多行合并成一个箱子；表头可有可无；出错的行逐行说明原因', () => {
    const text = ['箱号,SKU,每箱数量,重量,长,宽,高,相同箱数', 'BOX-1,A,5,10,10,10,10,2', 'BOX-1,B,2,10,10,10,10,2'].join('\n')
    expect(parseBoxLines(text)).toEqual({
      boxes: [
        {
          boxId: 'BOX-1',
          quantity: 2,
          weightLb: 10,
          lengthIn: 10,
          widthIn: 10,
          heightIn: 10,
          items: [
            { sku: 'A', quantity: 5 },
            { sku: 'B', quantity: 2 },
          ],
        },
      ],
      errors: [],
    })
    // 有任何一行出错，整份拒绝（不导入一半）
    const broken = parseBoxLines(`${text}\nBOX-2\tA,x`)
    expect(broken.boxes).toEqual([])
    expect(broken.errors).toEqual([{ line: 4, message: expect.stringContaining('列数不够') }])
    expect(parseBoxLines('BOX-1,A,5,10,10,10,10').boxes[0].quantity).toBe(1)
    // 表头行跳过；但 SKU 名字里带 sku 的第一行数据不是表头，不能被丢掉
    expect(parseBoxLines('箱号,SKU,每箱数量,重量,长,宽,高\nBOX-1,A,5,10,10,10,10').boxes).toHaveLength(1)
    expect(parseBoxLines('BOX-1,SKU-A,5,10,10,10,10').boxes[0].items).toEqual([{ sku: 'SKU-A', quantity: 5 }])
    expect(parseBoxLines('BOX-1,A,0,10,10,10,10').errors[0].message).toContain('每箱数量')
    expect(parseBoxLines('BOX-1,A,1,0,10,10,10').errors[0].message).toContain('重量')
    expect(parseBoxLines('BOX-1,A,1,10,10,10,10\nBOX-1,B,1,12,10,10,10').errors[0].line).toBe(2)
  })
})

describe('请求体校验', () => {
  const address = { name: '仓库', addressLine1: '1 Road', city: 'SZ', stateOrProvinceCode: 'GD', countryCode: 'CN', postalCode: '518000', phoneNumber: '123456' }

  it('创建：SKU 不能重复，数量必须是正整数', () => {
    const ok = InboundPlanCreateBodySchema.safeParse({ name: '计划', sourceAddress: address, items: [{ sku: 'A', quantity: 1 }] })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.sourceType).toBe('MANUAL')
    expect(
      InboundPlanCreateBodySchema.safeParse({
        name: '计划',
        sourceAddress: address,
        items: [
          { sku: 'A', quantity: 1 },
          { sku: 'A', quantity: 2 },
        ],
      }).success,
    ).toBe(false)
    expect(InboundPlanCreateBodySchema.safeParse({ name: '计划', sourceAddress: address, items: [{ sku: 'A', quantity: 1.5 }] }).success).toBe(false)
  })

  it('创建：请求体里没有预处理或贴标由谁负责的选项（固定为卖家）', () => {
    const shape = Object.keys(InboundPlanCreateBodySchema.shape)
    expect(shape.join(',')).not.toMatch(/prep|label|owner/i)
  })

  it('箱子与追踪号的基本校验', () => {
    const box = { quantity: 1, weightLb: 1, lengthIn: 1, widthIn: 1, heightIn: 1, items: [{ sku: 'A', quantity: 1 }] }
    expect(InboundBoxesBodySchema.safeParse({ version: 1, boxes: [box] }).success).toBe(true)
    expect(InboundBoxesBodySchema.safeParse({ version: 1, boxes: [{ ...box, weightLb: 0 }] }).success).toBe(false)
    expect(InboundBoxesBodySchema.safeParse({ version: 1, boxes: [] }).success).toBe(false)
    expect(InboundTrackingBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(InboundTrackingBodySchema.safeParse({ version: 1, items: [{ boxId: 'B1', trackingId: '1Z' }] }).success).toBe(true)
    expect(InboundTrackingBodySchema.safeParse({ version: 1, billOfLadingNumber: 'BOL1' }).success).toBe(true)
  })
})
