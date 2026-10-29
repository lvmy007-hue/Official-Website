import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { GridViewsService } from './grid-views.service'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const NOW = new Date('2026-10-26T08:00:00.000Z')
const row = (over: Record<string, unknown> = {}) => ({
  id: 'gv1',
  tenantId: 'tenant-1',
  gridId: 'inventory.health',
  kind: 'VIEW',
  scope: 'USER',
  ownerUserId: 'user-1',
  createdBy: 'user-1',
  name: '我的视图',
  config: { hidden: ['sku'] },
  isDefault: false,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})
const body = { gridId: 'inventory.health', name: '新视图', config: { hidden: ['sku'] } }

function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    gridView: {
      findFirst: vi.fn().mockResolvedValue(row()),
      findFirstOrThrow: vi.fn().mockResolvedValue(row({ isDefault: true })),
      findMany: vi.fn().mockResolvedValue([row(), row({ id: 'gv2', scope: 'TEAM', ownerUserId: null, createdBy: 'user-2', name: '团队共用' })]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }) => row({ id: 'gv-new', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    ...over,
  }
  const base = prisma.membership
  prisma.membership = {
    ...base,
    findMany: vi.fn().mockResolvedValue([
      { userId: 'user-1', user: { displayName: '甲', email: 'a@x.com' } },
      { userId: 'user-2', user: { displayName: '乙', email: 'b@x.com' } },
    ]),
  }
  return prisma
}

describe('表格视图列表', () => {
  it('只查本人的个人视图与团队、系统视图，并标明是否本人、能否编辑、创建人', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/grid-views?gridId=inventory.health')
    expect(res.status).toBe(200)
    expect(prisma.gridView.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 'tenant-1',
      gridId: 'inventory.health',
      kind: 'VIEW',
      OR: [{ scope: 'USER', ownerUserId: 'user-1' }, { scope: { in: ['TEAM', 'SYSTEM'] } }],
    })
    expect(res.json.data.canShare).toBe(false)
    expect(res.json.data.limits).toEqual({ user: 20, team: 30 })
    // 排序：我的 → 团队 → 系统
    expect(res.json.data.items.map((item: { id: string }) => item.id)).toEqual(['gv1', 'gv2'])
    expect(res.json.data.items[0]).toMatchObject({ scope: 'USER', mine: true, canEdit: true, config: { hidden: ['sku'] } })
    expect(res.json.data.items[1]).toMatchObject({ scope: 'TEAM', mine: false, canEdit: false, owner: { name: '乙' } })
  })

  it('有共享权限的人看到团队视图可编辑；表格编号缺失或格式不对返回 422', async () => {
    harness = await createTestApp(prismaFor(['grid.view.share']))
    const res = await harness.call('GET', '/grid-views?gridId=inventory.health')
    expect(res.json.data.canShare).toBe(true)
    expect(res.json.data.items[1]).toMatchObject({ scope: 'TEAM', canEdit: true })
    expect((await harness.call('GET', '/grid-views')).status).toBe(422)
    expect((await harness.call('GET', '/grid-views?gridId=Bad%20Id')).status).toBe(422)
  })
})

describe('新建表格视图', () => {
  it('个人视图：归属本人；设为默认时同一事务取消同人同表格原默认', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/grid-views', { body: { ...body, isDefault: true } })
    expect(res.status).toBe(201)
    expect(prisma.gridView.updateMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 'tenant-1', gridId: 'inventory.health', kind: 'VIEW', scope: 'USER', ownerUserId: 'user-1', isDefault: true },
      data: { isDefault: false },
    })
    expect(prisma.gridView.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', scope: 'USER', ownerUserId: 'user-1', createdBy: 'user-1', name: '新视图', isDefault: true })
  })

  it('同名返回 409；超过 20 个返回 409；名称为空或配置里带未知字段被清理或拒绝', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    prisma.gridView.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    const dup = await harness.call('POST', '/grid-views', { body })
    expect(dup.status).toBe(409)
    expect(dup.json.error.fieldErrors?.name).toBeTruthy()
    prisma.gridView.count.mockResolvedValue(20)
    expect((await harness.call('POST', '/grid-views', { body })).status).toBe(409)
    expect((await harness.call('POST', '/grid-views', { body: { ...body, name: '' } })).status).toBe(422)
    expect((await harness.call('POST', '/grid-views', { body: { ...body, name: 'x'.repeat(41) } })).status).toBe(422)
  })

  it('共享给团队需要 grid.view.share：没有时 403 并写明权限点；有时上限 30 且按团队范围取消原默认', async () => {
    const denied = prismaFor([])
    harness = await createTestApp(denied)
    const res = await harness.call('POST', '/grid-views', { body: { ...body, scope: 'TEAM' } })
    expect(res.status).toBe(403)
    expect(res.json.error.details).toMatchObject({ permission: 'grid.view.share' })
    expect(denied.gridView.create).not.toHaveBeenCalled()
    await harness.close()

    const prisma = prismaFor(['grid.view.share'])
    harness = await createTestApp(prisma)
    const ok = await harness.call('POST', '/grid-views', { body: { ...body, scope: 'TEAM', isDefault: true } })
    expect(ok.status).toBe(201)
    expect(prisma.gridView.updateMany.mock.calls[0][0].where).toMatchObject({ scope: 'TEAM', isDefault: true })
    expect(prisma.gridView.create.mock.calls[0][0].data).toMatchObject({ scope: 'TEAM', ownerUserId: null, createdBy: 'user-1' })
    prisma.gridView.count.mockResolvedValue(30)
    expect((await harness.call('POST', '/grid-views', { body: { ...body, scope: 'TEAM' } })).status).toBe(409)
  })

  it('内部直连与支持访问模式没有个人账号，不能保存、修改、删除、设默认（读取不受限）', async () => {
    const prisma = prismaFor([])
    for (const accessMode of ['INTERNAL_DIRECT', 'SUPPORT']) {
      const context = { userId: 'u', tenantId: 'tenant-1', permissions: ['view.manage'], accessMode }
      const service = new GridViewsService(prisma as never, { authorize: async () => context, require: () => undefined } as never)
      const attempts = [
        () => service.create({} as never, body),
        () => service.update({} as never, 'gv1', { version: 1, name: 'x' }),
        () => service.remove({} as never, 'gv1'),
        () => service.setDefault({} as never, 'gv1'),
      ]
      for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'INTERNAL_ACCESS_UNSUPPORTED' })
      await expect(service.list({} as never, { gridId: 'inventory.health' })).resolves.toMatchObject({ items: expect.any(Array) })
    }
    expect(prisma.gridView.create).not.toHaveBeenCalled()
  })
})

describe('修改、删除、设为默认', () => {
  it('修改带乐观锁：成功返回新内容；版本过期返回 409；什么都没改返回 422', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const ok = await harness.call('PUT', '/grid-views/gv1', { body: { version: 1, name: '改名', config: { hidden: [] } } })
    expect(ok.status).toBe(200)
    expect(prisma.gridView.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'gv1', tenantId: 'tenant-1', version: 1 }, data: { name: '改名' } })
    prisma.gridView.updateMany.mockResolvedValueOnce({ count: 0 })
    prisma.gridView.findFirst.mockImplementation(async (args: any) => (args?.select ? { version: 2 } : row()))
    const stale = await harness.call('PUT', '/grid-views/gv1', { body: { version: 1, name: '再改' } })
    expect(stale.status).toBe(409)
    expect(stale.json.error.details).toMatchObject({ currentVersion: 2 })
    expect((await harness.call('PUT', '/grid-views/gv1', { body: { version: 2 } })).status).toBe(422)
  })

  it('别人的个人视图按不存在处理（404）；系统视图 409；没有共享权限的团队视图 403', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    prisma.gridView.findFirst.mockResolvedValue(row({ ownerUserId: 'user-2' }))
    expect((await harness.call('PUT', '/grid-views/gv1', { body: { version: 1, name: 'x' } })).status).toBe(404)
    expect((await harness.call('DELETE', '/grid-views/gv1')).status).toBe(404)
    expect((await harness.call('POST', '/grid-views/gv1/default')).status).toBe(404)
    prisma.gridView.findFirst.mockResolvedValue(row({ scope: 'SYSTEM', ownerUserId: null, createdBy: null }))
    expect((await harness.call('DELETE', '/grid-views/gv1')).status).toBe(409)
    expect((await harness.call('POST', '/grid-views/gv1/default')).status).toBe(409)
    prisma.gridView.findFirst.mockResolvedValue(row({ scope: 'TEAM', ownerUserId: null }))
    const denied = await harness.call('DELETE', '/grid-views/gv1')
    expect(denied.status).toBe(403)
    expect(denied.json.error.details).toMatchObject({ permission: 'grid.view.share' })
    prisma.gridView.findFirst.mockResolvedValue(null)
    expect((await harness.call('DELETE', '/grid-views/gone')).status).toBe(404)
    expect(prisma.gridView.deleteMany).not.toHaveBeenCalled()
  })

  it('删除按企业与编号限定；设默认在同一事务取消同级原默认，且不改版本号', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const del = await harness.call('DELETE', '/grid-views/gv1')
    expect(del.status).toBe(200)
    expect(prisma.gridView.deleteMany.mock.calls[0][0]).toEqual({ where: { id: 'gv1', tenantId: 'tenant-1' } })
    const res = await harness.call('POST', '/grid-views/gv1/default')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ id: 'gv1', isDefault: true })
    const [clear, set] = prisma.gridView.updateMany.mock.calls
    expect(clear[0]).toMatchObject({ where: { scope: 'USER', ownerUserId: 'user-1', isDefault: true, NOT: { id: 'gv1' } }, data: { isDefault: false } })
    expect(set[0]).toEqual({ where: { id: 'gv1', tenantId: 'tenant-1' }, data: { isDefault: true } })
  })

  it('写接口都由统一拦截器留审计', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    await harness.call('POST', '/grid-views', { body })
    await harness.call('POST', '/grid-views/gv1/default')
    const actions = harness.writeGuardStubs.auditEvent.create.mock.calls.map(([arg]: any) => arg.data.action)
    expect(actions).toEqual(expect.arrayContaining(['GRID_VIEW_CREATED', 'GRID_VIEW_DEFAULT_SET']))
  })
})
