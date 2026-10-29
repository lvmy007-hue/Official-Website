import { describe, expect, it } from 'vitest'
import {
  AttachmentTicketBodySchema,
  PoApprovalBodySchema,
  PoInspectionBodySchema,
  PoPaymentBodySchema,
  PoStatusBodySchema,
  PurchaseOrderCreateBodySchema,
  purchaseOrderActions,
} from './procurement.js'
import { SUPPLIER_RATING_MIN_ORDERS, supplierRating } from './supplier.js'
import { StockCountApprovalBodySchema, StockCountBodySchema } from './warehouse.js'

describe('采购单状态机动作', () => {
  it('草稿可以编辑、提交、取消，不能收货', () => {
    expect(purchaseOrderActions({ status: 'DRAFT', receivedQtyTotal: 0 })).toEqual(expect.arrayContaining(['EDIT', 'SUBMIT', 'CANCEL']))
    expect(purchaseOrderActions({ status: 'DRAFT', receivedQtyTotal: 0 })).not.toContain('RECEIVE')
  })

  it('待审批可以审批，已下单不能再审批', () => {
    expect(purchaseOrderActions({ status: 'PENDING_APPROVAL', receivedQtyTotal: 0 })).toContain('APPROVE')
    expect(purchaseOrderActions({ status: 'ORDERED', receivedQtyTotal: 0 })).not.toContain('APPROVE')
  })

  it('收过货的订单不能直接取消，只能退货或关闭', () => {
    const actions = purchaseOrderActions({ status: 'PARTIALLY_RECEIVED', receivedQtyTotal: 10 })
    expect(actions).not.toContain('CANCEL')
    expect(actions).toEqual(expect.arrayContaining(['RECEIVE', 'INSPECT', 'PAY', 'RETURN', 'CLOSE']))
  })

  it('已关闭、已取消、已退货的订单没有业务动作（关闭后仍可付款）', () => {
    expect(purchaseOrderActions({ status: 'CANCELLED', receivedQtyTotal: 0 })).toEqual(['ATTACH'])
    expect(purchaseOrderActions({ status: 'RETURNED_TO_SUPPLIER', receivedQtyTotal: 3 })).toEqual(['ATTACH'])
    expect(purchaseOrderActions({ status: 'CLOSED', receivedQtyTotal: 3 })).toEqual(['ATTACH', 'PAY'])
  })
})

describe('采购请求校验', () => {
  it('创建采购单至少一行，数量必须是正整数', () => {
    expect(PurchaseOrderCreateBodySchema.safeParse({ supplierId: 's', lines: [] }).success).toBe(false)
    expect(PurchaseOrderCreateBodySchema.safeParse({ supplierId: 's', lines: [{ sellerSku: 'A', quantity: 1.5 }] }).success).toBe(false)
    expect(PurchaseOrderCreateBodySchema.safeParse({ supplierId: 's', lines: [{ sellerSku: 'A', quantity: 2, unitCost: 3 }] }).success).toBe(true)
  })

  it('驳回必须写意见，通过可以不写', () => {
    expect(PoApprovalBodySchema.safeParse({ version: 1, decision: 'REJECTED' }).success).toBe(false)
    expect(PoApprovalBodySchema.safeParse({ version: 1, decision: 'REJECTED', comment: '价格偏高' }).success).toBe(true)
    expect(PoApprovalBodySchema.safeParse({ version: 1, decision: 'APPROVED' }).success).toBe(true)
  })

  it('取消、关闭、退货必须写原因，退货必须给出商品与数量', () => {
    expect(PoStatusBodySchema.safeParse({ version: 1, action: 'START_PRODUCTION' }).success).toBe(true)
    expect(PoStatusBodySchema.safeParse({ version: 1, action: 'CANCEL' }).success).toBe(false)
    expect(PoStatusBodySchema.safeParse({ version: 1, action: 'RETURN', reason: '质量问题' }).success).toBe(false)
    expect(PoStatusBodySchema.safeParse({ version: 1, action: 'RETURN', reason: '质量问题', lines: [{ lineId: 'l1', quantity: 2 }] }).success).toBe(true)
  })

  it('质检：抽检数不超过批量，不良数不超过抽检数', () => {
    const base = { version: 1, result: 'PASS' as const, lotQty: 100, sampleQty: 20, defectQty: 1 }
    expect(PoInspectionBodySchema.safeParse(base).success).toBe(true)
    expect(PoInspectionBodySchema.safeParse({ ...base, sampleQty: 200 }).success).toBe(false)
    expect(PoInspectionBodySchema.safeParse({ ...base, defectQty: 30 }).success).toBe(false)
  })

  it('付款金额必须大于 0', () => {
    expect(PoPaymentBodySchema.safeParse({ version: 1, kind: 'DEPOSIT', amount: 0 }).success).toBe(false)
    expect(PoPaymentBodySchema.safeParse({ version: 1, kind: 'DEPOSIT', amount: 10, paidAt: '2026-01-01' }).success).toBe(true)
  })

  it('附件只允许白名单类型，且不能超过上限', () => {
    expect(AttachmentTicketBodySchema.safeParse({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1000 }).success).toBe(true)
    expect(AttachmentTicketBodySchema.safeParse({ fileName: 'a.exe', contentType: 'application/x-msdownload', sizeBytes: 1000 }).success).toBe(false)
    expect(AttachmentTicketBodySchema.safeParse({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 30 * 1024 * 1024 }).success).toBe(false)
  })

  it('盘点：盘点数不能为负；驳回必须写意见', () => {
    expect(StockCountBodySchema.safeParse({ warehouseId: 'w', countedAt: '2026-01-01', lines: [{ sellerSku: 'A', countedQty: -1 }] }).success).toBe(false)
    expect(StockCountBodySchema.parse({ warehouseId: 'w', countedAt: '2026-01-01', lines: [{ sellerSku: 'A', countedQty: 0 }] }).submit).toBe(true)
    expect(StockCountApprovalBodySchema.safeParse({ decision: 'REJECTED' }).success).toBe(false)
  })
})

describe('供应商评级', () => {
  it('已完成采购单不足时不评级', () => {
    expect(supplierRating({ onTimeRate: 1, qualityPassRate: 1, completedOrders: SUPPLIER_RATING_MIN_ORDERS - 1 })).toBeNull()
    expect(supplierRating({ onTimeRate: null, qualityPassRate: 1, completedOrders: 10 })).toBeNull()
  })

  it('按准时率与合格率的平均值分档（没有质检数据时只看准时率）', () => {
    expect(supplierRating({ onTimeRate: 0.99, qualityPassRate: 0.97, completedOrders: 5 })).toBe('A')
    expect(supplierRating({ onTimeRate: 0.99, qualityPassRate: 0.9, completedOrders: 5 })).toBe('B')
    expect(supplierRating({ onTimeRate: 0.75, qualityPassRate: 0.7, completedOrders: 5 })).toBe('C')
    expect(supplierRating({ onTimeRate: 0.5, qualityPassRate: 0.7, completedOrders: 5 })).toBe('D')
    expect(supplierRating({ onTimeRate: 0.96, qualityPassRate: null, completedOrders: 5 })).toBe('A')
  })
})
