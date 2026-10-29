import { describe, expect, it } from 'vitest'
import {
  FEE_CATEGORIES,
  FEE_CATEGORY_LABEL,
  FEE_CATEGORY_NOTE,
  FeeEventListQuerySchema,
  FeeReconcileBodySchema,
  classifyFeeLine,
  feeSourceOf,
  feeSubtypeLabel,
  feeTransactionStatusLabel,
} from './index.js'

// 费用事件契约（P2b-05）：9 类分类器、来源判断、子类型文字、列表查询、对账请求体。

const classify = (path: string, transactionType = 'Shipment', eventType?: string) => classifyFeeLine({ path, transactionType, eventType: eventType ?? path.split('/').pop() })

describe('费用分类器', () => {
  it('9 个类别都有名称与说明，名称与冻结的 9 个页签一致', () => {
    expect(FEE_CATEGORIES.map(category => FEE_CATEGORY_LABEL[category])).toEqual(['配送费', '佣金', '仓储费', '库龄附加费', '入仓配置费', '移除与弃置费', '退款', '赔付', '其他调整'])
    for (const category of FEE_CATEGORIES) expect(FEE_CATEGORY_NOTE[category].length).toBeGreaterThan(5)
  })

  it.each([
    ['Amazon Fees/FBAPerUnitFulfillmentFee', 'FULFILLMENT'],
    ['Amazon Fees/FBA Weight Based Fee', 'FULFILLMENT'],
    ['AmazonFees/Commission', 'COMMISSION'],
    ['Amazon Fees/Referral Fee', 'COMMISSION'],
    ['Amazon Fees/Variable Closing Fee', 'COMMISSION'],
    ['Fees/FBAStorageFee', 'STORAGE'],
    ['Fees/LowInventoryLevelFee', 'STORAGE'],
    ['Fees/AgedInventorySurcharge', 'AGED_SURCHARGE'],
    ['Fees/LongTermStorageFee', 'AGED_SURCHARGE'],
    ['Fees/FBAInboundConvenienceFee', 'INBOUND_PLACEMENT'],
    ['Fees/FBAInboundDefectFee', 'INBOUND_PLACEMENT'],
    ['Fees/FBARemovalFee', 'REMOVAL_DISPOSAL'],
    ['Fees/FBADisposalFee', 'REMOVAL_DISPOSAL'],
    ['Fees/Subscription', 'OTHER'],
    ['Fees', 'OTHER'],
    ['Something/Unrecognized', 'OTHER'],
  ])('%s 归为 %s', (path, category) => {
    expect(classify(path).category).toBe(category)
  })

  it('退款交易下的全部明细都归入退款，包括退还的佣金与商品款', () => {
    for (const path of ['Product Charges/Principle', 'Amazon Fees/Commission', 'Tax/Tax']) expect(classify(path, 'Refund').category).toBe('REFUND')
    expect(classify('Chargeback/Principal', 'Chargeback').category).toBe('REFUND')
  })

  it('赔付与库存调整归入赔付，且先于退款与其他规则', () => {
    expect(classify('Reimbursement/Principal', 'FBAInventoryReimbursement').category).toBe('REIMBURSEMENT')
    expect(classify('Adjustment/WAREHOUSE_DAMAGE', 'Adjustment').category).toBe('REIMBURSEMENT')
    expect(classify('Reimbursement/Refund', 'SAFETReimbursement').category).toBe('REIMBURSEMENT')
  })

  it('销售收入、税、运费收入、促销折扣不是费用（NON_FEE），不进 9 个页签', () => {
    for (const path of ['Product Charges/Principle', 'Product Charges/Tax', 'Shipping/ShippingCharge', 'Promotion/PromotionAmount', 'Product Charges/GiftWrap']) {
      expect(classify(path, 'Shipment').category).toBe('NON_FEE')
    }
  })

  it('报告类的费用事件也能分类（描述与类型来自报告导入器）', () => {
    expect(classifyFeeLine({ path: 'FBA storage 2026-09', eventType: 'STORAGE_FEE' }).category).toBe('STORAGE')
    expect(classifyFeeLine({ path: 'Inbound noncompliance', eventType: 'INBOUND_NONCOMPLIANCE' }).category).toBe('INBOUND_PLACEMENT')
  })

  it('子类型取路径最后一段，没有路径时取类型；都没有为 null', () => {
    expect(classify('Amazon Fees/FBAPerUnitFulfillmentFee').subtype).toBe('FBAPerUnitFulfillmentFee')
    expect(classifyFeeLine({ path: '', eventType: 'ServiceFee' }).subtype).toBe('ServiceFee')
    expect(classifyFeeLine({}).subtype).toBeNull()
  })

  it('子类型转成易读文字', () => {
    expect(feeSubtypeLabel('FBAPerUnitFulfillmentFee')).toBe('FBA Per Unit Fulfillment Fee')
    expect(feeSubtypeLabel('WAREHOUSE_DAMAGE')).toBe('WAREHOUSE DAMAGE')
    expect(feeSubtypeLabel(null)).toBeNull()
  })
})

describe('来源与状态', () => {
  it('报告类的来源编号带固定前缀，其余来自财务接口', () => {
    expect(feeSourceOf('storage:B0:2026-09:SKU')).toBe('STORAGE_REPORT')
    expect(feeSourceOf('noncompliance:FBA1:SKU:x:2026-09-01')).toBe('NONCOMPLIANCE_REPORT')
    expect(feeSourceOf('T1:0:0.1')).toBe('FINANCE_API')
    expect(feeSourceOf(null)).toBe('FINANCE_API')
  })

  it('交易状态：官方三种有中文，新状态显示原值，没有状态为 null', () => {
    expect(feeTransactionStatusLabel('DEFERRED')).toBe('递延')
    expect(feeTransactionStatusLabel('DEFERRED_RELEASED')).toBe('递延后释放')
    expect(feeTransactionStatusLabel('POSTED')).toContain('POSTED')
    expect(feeTransactionStatusLabel(null)).toBeNull()
  })
})

describe('请求校验', () => {
  it('列表查询：类别、状态、对账状态只认枚举值，未知参数拒绝', () => {
    expect(FeeEventListQuerySchema.parse({ category: 'STORAGE', reconciliation: 'DISCREPANCY', status: 'DEFERRED' })).toMatchObject({ category: 'STORAGE', reconciliation: 'DISCREPANCY' })
    expect(FeeEventListQuerySchema.safeParse({ category: 'NON_FEE' }).success).toBe(false)
    expect(FeeEventListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
    expect(FeeEventListQuerySchema.parse({}).sort).toEqual({ field: 'postedAt', dir: 'desc' })
  })

  it('对账请求体：标记有差异必须写备注；至少改一项；不能手工标已对账；必须带版本', () => {
    expect(FeeReconcileBodySchema.safeParse({ version: 1, status: 'DISCREPANCY', note: '多扣了 2.5 美元' }).success).toBe(true)
    expect(FeeReconcileBodySchema.safeParse({ version: 1, status: 'DISCREPANCY' }).success).toBe(false)
    expect(FeeReconcileBodySchema.safeParse({ version: 1, status: 'DISCREPANCY', note: '   ' }).success).toBe(false)
    expect(FeeReconcileBodySchema.safeParse({ version: 1, status: 'UNRECONCILED' }).success).toBe(true)
    expect(FeeReconcileBodySchema.safeParse({ version: 1, note: '只写备注' }).success).toBe(true)
    expect(FeeReconcileBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(FeeReconcileBodySchema.safeParse({ version: 1, status: 'RECONCILED' }).success).toBe(false)
    expect(FeeReconcileBodySchema.safeParse({ status: 'UNRECONCILED' }).success).toBe(false)
  })
})
