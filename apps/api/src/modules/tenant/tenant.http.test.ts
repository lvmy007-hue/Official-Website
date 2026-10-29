import { BASE_PERMISSIONS } from '@nova/authz'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

function tenantPrisma(permissions: string[]) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    user: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'user-1', email: 'a@b.cn', displayName: '张三' }) },
    tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'tenant-1', name: '企业', slug: 'qy', mode: 'LIVE', timezone: 'America/Los_Angeles', defaultCurrency: 'USD' }) },
    tenantOnboarding: { findUnique: vi.fn().mockResolvedValue(null) },
    membership: { findFirst: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } }), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  }
  return prisma
}

// 法律主体的接口测试在 modules/entities（P5-07 起），成员与角色在 modules/members（P5-08 起）。
describe('租户', () => {
  it('当前用户接口返回用户、租户与权限', async () => {
    harness = await createTestApp(tenantPrisma(['orders.read']))
    const res = await harness.call('GET', '/auth/me')
    expect(res.status).toBe(200)
    // 返回的是有效权限：旧点位展开后的新点位 + 基础权限，前后端看到同一份
    expect(res.json.data.permissions).toEqual(expect.arrayContaining(['orders.read', 'returns.read', ...BASE_PERMISSIONS]))
    expect(res.json.data.permissions).not.toContain('field.cost')
    expect(res.json.data.tenant.defaultCurrency).toBe('USD')
  })
})
