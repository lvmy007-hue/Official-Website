import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { purchaseOrderCreateData } from './procurement.queries'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('采购单写入数据', () => {
  it('币种默认取供应商币种；单价缺省保持为空而不是 0', () => {
    const data = purchaseOrderCreateData('t1', { id: 's1', currency: 'CNY' }, 'PO-1', {}, [
      { sellerSku: 'A', quantity: 10 },
      { sellerSku: 'B', quantity: 5, unitCost: '3.5', currency: 'USD' },
    ])
    expect(data).toMatchObject({ tenantId: 't1', supplierId: 's1', number: 'PO-1', status: 'DRAFT', currency: 'CNY' })
    expect(data.lines.create[0]).toMatchObject({ sellerSku: 'A', unitCost: undefined, currency: 'CNY' })
    expect(data.lines.create[1]).toMatchObject({ sellerSku: 'B', unitCost: 3.5, currency: 'USD' })
  })
})

function procurementPrisma(permissions: string[]) {
  return {
    ...sessionStub(permissions),
    supplier: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue({ id: 's1', currency: 'CNY' }) },
    purchaseOrder: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({ id: 'po-1' }) },
  }
}

describe('采购接口', () => {
  it('列表按租户读取', async () => {
    const prisma = procurementPrisma(['seller.read'])
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/procurement/suppliers')).status).toBe(200)
    expect((await harness.call('GET', '/procurement/purchase-orders?q=PO')).status).toBe(200)
    expect(prisma.purchaseOrder.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', number: { contains: 'PO' } })
  })

  it('新建采购单：需要写权限，供应商必须属于当前租户', async () => {
    const prisma = procurementPrisma(['seller.write'])
    harness = await createTestApp(prisma)
    const ok = await harness.call('POST', '/procurement/purchase-orders', { body: { supplierId: 's1', number: 'PO-1', lines: [{ sellerSku: 'A', quantity: 3 }] } })
    expect(ok.status).toBe(201)
    expect(prisma.supplier.findFirst.mock.calls[0][0].where).toEqual({ id: 's1', tenantId: 'tenant-1' })

    prisma.supplier.findFirst.mockResolvedValueOnce(null)
    const missing = await harness.call('POST', '/procurement/purchase-orders', { body: { supplierId: 'other', number: 'PO-2', lines: [{ sellerSku: 'A', quantity: 1 }] } })
    expect(missing.status).toBe(404)

    const invalid = await harness.call('POST', '/procurement/purchase-orders', { body: { number: 'PO-3', lines: [] } })
    expect(invalid.status).toBe(400)
    expect(invalid.json.error.code).toBe('PURCHASE_ORDER_INVALID')
  })

  it('采购单金额与单价属成本字段：没有 field.cost 的响应里没有这些键', async () => {
    const order = { id: 'po-1', number: 'PO-1', totalAmount: 120, lines: [{ sellerSku: 'A', quantity: 3, unitCost: 40 }] }
    const prisma = procurementPrisma(['purchase.read'])
    prisma.purchaseOrder.findMany.mockResolvedValue([order])
    harness = await createTestApp(prisma)
    const hidden = await harness.call('GET', '/procurement/purchase-orders')
    expect(hidden.json.data[0]).not.toHaveProperty('totalAmount')
    expect(hidden.json.data[0].lines[0]).not.toHaveProperty('unitCost')
    expect(hidden.json.data[0].lines[0]).toMatchObject({ sellerSku: 'A', quantity: 3 })
    await harness.close()

    const withCost = procurementPrisma(['purchase.read', 'field.cost'])
    withCost.purchaseOrder.findMany.mockResolvedValue([order])
    harness = await createTestApp(withCost)
    const visible = await harness.call('GET', '/procurement/purchase-orders')
    expect(visible.json.data[0]).toMatchObject({ totalAmount: 120 })
    expect(visible.json.data[0].lines[0]).toMatchObject({ unitCost: 40 })
  })

  it('只有读权限不能新建', async () => {
    harness = await createTestApp(procurementPrisma(['seller.read']))
    expect((await harness.call('POST', '/procurement/purchase-orders', { body: {} })).status).toBe(403)
  })
})
