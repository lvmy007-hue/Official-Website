import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from './harness'

// 页码列表接口的共同契约：租户条件、权限点、分页参数校验、分页信息。
// 每个领域模块在自己的测试里调用，保证列表接口行为一致。
export function describeListEndpoint(options: { path: string; permission: string; model: string; label: string }) {
  const { path, permission, model, label } = options
  let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  const prismaWith = (permissions: string[]): Record<string, any> => ({
    ...sessionStub(permissions),
    [model]: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  })

  describe(`${label}列表 GET ${path}`, () => {
    it('按租户过滤、按页取数，并返回分页信息', async () => {
      const prisma = prismaWith([permission])
      harness = await createTestApp(prisma)
      const res = await harness.call('GET', `${path}?page=3&pageSize=10&marketplaceId=ATVPDKIKX0DER&q=abc`)
      expect(res.status).toBe(200)
      expect(res.json.data).toMatchObject({ page: 3, pageSize: 10, total: 0, marketplaceId: 'ATVPDKIKX0DER' })
      const args = (prisma[model] as { findMany: ReturnType<typeof vi.fn> }).findMany.mock.calls[0][0]
      expect(args).toMatchObject({ skip: 20, take: 10 })
      expect(args.where).toMatchObject({ tenantId: 'tenant-1', marketplaceId: 'ATVPDKIKX0DER' })
    })

    it('无权限 403、未登录 401、页大小超过 200 为 422', async () => {
      harness = await createTestApp(prismaWith(['member.read']))
      expect((await harness.call('GET', path)).status).toBe(403)
      expect((await harness.call('GET', path, { auth: false })).status).toBe(401)
      await harness.close()
      harness = await createTestApp(prismaWith([permission]))
      expect((await harness.call('GET', `${path}?pageSize=201`)).status).toBe(422)
    })
  })
}
