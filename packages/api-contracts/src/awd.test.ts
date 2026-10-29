import { describe, expect, it } from 'vitest'
import {
  AwdCancelBodySchema,
  AwdListQuerySchema,
  AwdOrderCreateBodySchema,
  AwdOrderUpdateBodySchema,
  awdActionCallsAmazon,
  awdDeliveryMode,
  awdOrderActions,
  awdPackageUnits,
  awdPackagesMissingDimensions,
  type AwdPackageInput,
} from './awd'

const measurements = { weight: { value: 5, unit: 'KILOGRAMS' as const }, dimensions: { length: 40, width: 30, height: 20, unit: 'CENTIMETERS' as const } }
const kase = (over: Partial<AwdPackageInput> = {}): AwdPackageInput => ({ type: 'CASE', count: 10, measurements, products: [{ sku: 'A', quantity: 24 }], ...over })
const address = { name: '深圳仓', addressLine1: '1 Road', stateOrRegion: 'GD', countryCode: 'cn' }

describe('AWD 包装统计', () => {
  it('件数 = 包装数 × 每包装商品数；托盘里的箱同样相乘', () => {
    expect(awdPackageUnits([kase()])).toBe(240)
    const pallet: AwdPackageInput = { type: 'PALLET', count: 2, measurements, packages: [kase({ count: 5, products: [{ sku: 'A', quantity: 10 }] })] }
    expect(awdPackageUnits([pallet])).toBe(2 * 5 * 10)
    expect(awdPackageUnits([])).toBe(0)
  })

  it('包装方式：全箱、全托盘、混合；没有包装为空', () => {
    const pallet: AwdPackageInput = { type: 'PALLET', count: 1, measurements, packages: [kase()] }
    expect(awdDeliveryMode([kase()])).toBe('CASE')
    expect(awdDeliveryMode([pallet])).toBe('PALLET')
    expect(awdDeliveryMode([kase(), pallet])).toBe('MIXED')
    expect(awdDeliveryMode([])).toBeNull()
  })

  it('递归统计缺少长宽高的包装', () => {
    const noDims = kase({ measurements: { weight: measurements.weight } })
    expect(awdPackagesMissingDimensions([kase()])).toBe(0)
    expect(awdPackagesMissingDimensions([noDims, kase()])).toBe(1)
    expect(awdPackagesMissingDimensions([{ type: 'PALLET', count: 1, measurements, packages: [noDims] }])).toBe(1)
  })
})

describe('AWD 订单动作', () => {
  const order = (status: string, pendingAction: string | null = null) => ({ status, orderId: status === 'LOCAL_DRAFT' ? null : 'O1', pendingAction })

  it('按状态给出允许的动作；有后台操作在途时一个都不给', () => {
    expect(awdOrderActions(order('LOCAL_DRAFT'), false)).toEqual(['EDIT', 'SUBMIT', 'CANCEL'])
    expect(awdOrderActions(order('CREATE_FAILED'), false)).toEqual(['EDIT', 'SUBMIT', 'CANCEL'])
    expect(awdOrderActions(order('DRAFT'), false)).toEqual(['EDIT', 'CONFIRM', 'CANCEL'])
    expect(awdOrderActions(order('CONFIRMED'), false)).toEqual(['CANCEL'])
    expect(awdOrderActions(order('CONFIRMED'), true)).toEqual(['CANCEL', 'TRANSPORT'])
    for (const status of ['VALIDATING', 'CLOSED', 'EXPIRED', 'CANCELLED']) expect(awdOrderActions(order(status), true), status).toEqual([])
    expect(awdOrderActions(order('DRAFT', 'CONFIRM'), true)).toEqual([])
  })

  it('哪些动作要调用亚马逊（受写入开关控制）', () => {
    expect(awdActionCallsAmazon('CANCEL', 'LOCAL_DRAFT')).toBe(false)
    expect(awdActionCallsAmazon('CANCEL', 'CREATE_FAILED')).toBe(false)
    expect(awdActionCallsAmazon('CANCEL', 'DRAFT')).toBe(true)
    expect(awdActionCallsAmazon('EDIT', 'LOCAL_DRAFT')).toBe(false)
    expect(awdActionCallsAmazon('EDIT', 'DRAFT')).toBe(true)
    expect(awdActionCallsAmazon('SUBMIT', 'LOCAL_DRAFT')).toBe(true)
    expect(awdActionCallsAmazon('CONFIRM', 'DRAFT')).toBe(true)
  })
})

describe('AWD 请求体', () => {
  const body = (over: Record<string, unknown> = {}) => ({ sellerAccountId: 's1', originAddress: address, packages: [kase()], ...over })

  it('创建：默认直接提交；国家代码转大写', () => {
    const parsed = AwdOrderCreateBodySchema.parse(body())
    expect(parsed.submit).toBe(true)
    expect(parsed.originAddress?.countryCode).toBe('CN')
  })

  it('创建：提交时地址、包装、长宽高缺一不可；只存草稿时都可以不填', () => {
    expect(AwdOrderCreateBodySchema.safeParse(body({ originAddress: undefined })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [] })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ measurements: { weight: measurements.weight } })] })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse({ sellerAccountId: 's1', submit: false }).success).toBe(true)
  })

  it('包装结构：必须且只能装商品或箱；只有托盘能装箱，且不能嵌套', () => {
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ products: undefined })] })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ packages: [kase()] })] })).success).toBe(false)
    const pallet = { type: 'PALLET', count: 1, measurements, packages: [kase()] }
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [pallet] })).success).toBe(true)
    const nested = { type: 'PALLET', count: 1, measurements, packages: [{ type: 'PALLET', count: 1, measurements, packages: [kase()] }] }
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [nested] })).success).toBe(false)
  })

  it('商品数量与托盘数量必须是正整数；到期日格式固定', () => {
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ products: [{ sku: 'A', quantity: 0 }] })] })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ products: [{ sku: 'A', quantity: 1.5 }] })] })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ products: [{ sku: 'A', quantity: 1, expiration: '2027/01/01' }] })] })).success).toBe(false)
    expect(AwdOrderCreateBodySchema.safeParse(body({ packages: [kase({ products: [{ sku: 'A', quantity: 1, expiration: '2027-01-01' }] })] })).success).toBe(true)
  })

  it('修改必须带版本号；运输信息的承运商代码是 2 到 4 位字母', () => {
    expect(AwdOrderUpdateBodySchema.safeParse({ note: 'x' }).success).toBe(false)
    expect(AwdOrderUpdateBodySchema.safeParse({ version: 1, transport: { bookingId: 'B1', carrierCode: 'ups1' } }).success).toBe(false)
    expect(AwdOrderUpdateBodySchema.parse({ version: 1, transport: { bookingId: 'B1', carrierCode: 'upsn' } }).transport?.carrierCode).toBe('UPSN')
  })

  it('取消必须写原因；列表分页有上限', () => {
    expect(AwdCancelBodySchema.safeParse({ version: 1, reason: '' }).success).toBe(false)
    expect(AwdListQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false)
    expect(AwdListQuerySchema.parse({}).pageSize).toBe(50)
  })
})
