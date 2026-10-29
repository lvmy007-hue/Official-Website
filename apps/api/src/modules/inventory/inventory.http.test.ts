import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { movementsWhere } from './inventory.queries'

describe('库存查询条件', () => {
  it('库存流水按 SKU 与类型过滤，并带上租户', () => {
    expect(movementsWhere('t1', { unrestricted: true, sellerAccountIds: [] }, { sellerSku: 'A', type: 'RECEIPT' })).toEqual({ tenantId: 't1', sellerSku: 'A', movementType: 'RECEIPT' })
  })
})

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('库存相关接口', () => {
  it('库存流水、仓库都按租户读取并校验卖家读取权限', async () => {
    const prisma = {
      ...sessionStub(['seller.read']),
      inventoryMovement: { findMany: vi.fn().mockResolvedValue([]) },
      warehouse: { findMany: vi.fn().mockResolvedValue([]) },
    }
    harness = await createTestApp(prisma)
    for (const path of ['/inventory/movements?sellerSku=A', '/warehouses']) {
      expect((await harness.call('GET', path)).status).toBe(200)
    }
    expect(prisma.inventoryMovement.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerSku: 'A' })
    await harness.close()
    harness = await createTestApp({ ...prisma, ...sessionStub(['orders.read']) })
    expect((await harness.call('GET', '/warehouses')).status).toBe(403)
  })
})
