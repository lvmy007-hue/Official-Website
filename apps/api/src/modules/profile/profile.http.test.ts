import { defaultNotifyPrefs } from '@nova/api-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 个人账号（P5-11）接口：权限先于参数、读取默认值与已保存值、整体替换与乐观锁、显示名修改。真实库行为见 testing/personal-account.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const savedAt = new Date('2026-10-25T08:00:00.000Z')

function prismaFor(permissions: string[], over: { preference?: Record<string, unknown> | null; user?: Record<string, unknown> } = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue({ localTimezone: 'Asia/Shanghai' }) },
    userPreference: {
      findFirst: vi.fn().mockResolvedValue(over.preference === undefined ? null : over.preference),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ version: 2, updatedAt: savedAt }),
      create: vi.fn().mockResolvedValue({ version: 1, updatedAt: savedAt }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ displayName: '张三', ...over.user }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  }
  return prisma
}

const changed = () => {
  const prefs = defaultNotifyPrefs()
  prefs.domains.ADS.INFO = false
  prefs.dnd = { enabled: true, start: '23:00', end: '07:00' }
  return prefs
}

describe('GET /me/preferences', () => {
  it('没登录 401（profile.manage 是所有成员的基础权限）；没保存过返回默认值（全部接收、免打扰关闭、版本 0）与企业本地时区', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('GET', '/me/preferences', { auth: false })).status).toBe(401)
    await harness.close()
    harness = await createTestApp(prismaFor([]))
    const res = await harness.call('GET', '/me/preferences')
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ notify: defaultNotifyPrefs(), favorites: [], density: 'STANDARD', version: 0, updatedAt: null, zone: 'Asia/Shanghai' })
  })

  it('读取已保存的偏好；库里的坏值按默认处理', async () => {
    const stored = changed()
    harness = await createTestApp(prismaFor([], { preference: { id: 'p1', notifyJson: stored, version: 3, updatedAt: savedAt } }))
    const res = await harness.call('GET', '/me/preferences')
    expect(res.json.data).toMatchObject({ notify: stored, version: 3, updatedAt: savedAt.toISOString() })
    await harness.close()
    harness = await createTestApp(prismaFor([], { preference: { id: 'p1', notifyJson: { domains: 'x', dnd: 7 }, version: 1, updatedAt: savedAt } }))
    expect((await harness.call('GET', '/me/preferences')).json.data.notify).toEqual(defaultNotifyPrefs())
  })
})

describe('PUT /me/preferences', () => {
  it('没登录 401；参数不完整 422；免打扰起止相同 422', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('PUT', '/me/preferences', { body: { nope: 1 }, auth: false })).status).toBe(401)
    await harness.close()
    harness = await createTestApp(prismaFor([]))
    const put = (body: unknown) => harness!.call('PUT', '/me/preferences', { body })
    expect((await put({ notify: { domains: {}, dnd: defaultNotifyPrefs().dnd }, version: 0 })).status).toBe(422)
    expect((await put({ notify: defaultNotifyPrefs() })).status).toBe(422)
    const same = defaultNotifyPrefs()
    same.dnd = { enabled: true, start: '08:00', end: '08:00' }
    expect((await put({ notify: same, version: 0 })).status).toBe(422)
  })

  it('第一次保存：创建记录并写审计（前后值）；返回新版本', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/me/preferences', { body: { notify: changed(), version: 0 } })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ notify: changed(), version: 1, zone: 'Asia/Shanghai' })
    expect(prisma.userPreference.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', userId: expect.any(String), notifyJson: changed() })
    const audit = prisma.auditEvent.create.mock.calls.map((call: any) => call[0].data).find((data: any) => data.action === 'USER_PREFERENCES_UPDATED' && data.beforeJson)
    expect(audit).toMatchObject({ resourceType: 'UserPreference', beforeJson: { notify: defaultNotifyPrefs() }, afterJson: { notify: changed() } })
  })

  it('再次保存：按版本条件更新；版本过期 409；与当前完全相同 422；没有记录却带着旧版本 409', async () => {
    const prisma = prismaFor([], { preference: { id: 'p1', notifyJson: defaultNotifyPrefs(), version: 1, updatedAt: savedAt } })
    harness = await createTestApp(prisma)
    const put = (body: unknown) => harness!.call('PUT', '/me/preferences', { body })
    const ok = await put({ notify: changed(), version: 1 })
    expect(ok.status).toBe(200)
    expect(ok.json.data.version).toBe(2)
    expect(prisma.userPreference.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'p1', version: 1 }, data: { version: { increment: 1 } } })
    prisma.userPreference.updateMany.mockResolvedValue({ count: 0 })
    expect((await put({ notify: changed(), version: 1 })).status).toBe(409)
    expect((await put({ notify: defaultNotifyPrefs(), version: 1 })).status).toBe(422)
    await harness.close()
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('PUT', '/me/preferences', { body: { notify: changed(), version: 4 } })).status).toBe(409)
  })
})

describe('收藏与密度（P6-01）', () => {
  const stored = { id: 'p1', notifyJson: changed(), favoriteRoutes: ['/app/overview', '/app/orders'], density: 'COMPACT', version: 4, updatedAt: savedAt }

  it('读取已保存的收藏与密度；库里的坏值与重复值被丢掉，认不出的密度按标准', async () => {
    harness = await createTestApp(prismaFor([], { preference: stored }))
    expect((await harness.call('GET', '/me/preferences')).json.data).toMatchObject({ favorites: ['/app/overview', '/app/orders'], density: 'COMPACT', version: 4 })
    await harness.close()
    harness = await createTestApp(prismaFor([], { preference: { ...stored, favoriteRoutes: ['/app/a', '/app/a', '/app/x/:id', 5], density: 'HUGE' } }))
    expect((await harness.call('GET', '/me/preferences')).json.data).toMatchObject({ favorites: ['/app/a'], density: 'STANDARD' })
  })

  it('只传收藏：只写收藏列，不动通知偏好与密度；审计只记收藏的前后值；返回合并后的完整偏好', async () => {
    const prisma = prismaFor([], { preference: stored })
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/me/preferences', { body: { favorites: ['/app/orders', '/app/overview', '/app/alerts'], version: 4 } })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ notify: changed(), density: 'COMPACT', favorites: ['/app/orders', '/app/overview', '/app/alerts'], version: 2 })
    const call = prisma.userPreference.updateMany.mock.calls[0][0]
    expect(call).toMatchObject({ where: { id: 'p1', version: 4 }, data: { favoriteRoutes: ['/app/orders', '/app/overview', '/app/alerts'], version: { increment: 1 } } })
    expect(call.data).not.toHaveProperty('notifyJson')
    expect(call.data).not.toHaveProperty('density')
    const audit = prisma.auditEvent.create.mock.calls.map((c: any) => c[0].data).find((data: any) => data.action === 'USER_PREFERENCES_UPDATED' && data.beforeJson)
    expect(audit.beforeJson).toEqual({ favorites: ['/app/overview', '/app/orders'] })
    expect(audit.afterJson).toEqual({ favorites: ['/app/orders', '/app/overview', '/app/alerts'] })
  })

  it('第一次保存只有密度：创建记录，只带密度；清空收藏是合法的修改', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('PUT', '/me/preferences', { body: { density: 'COMPACT', version: 0 } })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ density: 'COMPACT', favorites: [], notify: defaultNotifyPrefs() })
    expect(prisma.userPreference.create.mock.calls[0][0].data).toEqual({ tenantId: 'tenant-1', userId: expect.any(String), density: 'COMPACT' })
    await harness.close()
    harness = await createTestApp(prismaFor([], { preference: stored }))
    expect((await harness.call('PUT', '/me/preferences', { body: { favorites: [], version: 4 } })).status).toBe(200)
  })

  it('不合格的请求：超过 30 个、重复、带对象参数的页面、密度不认识、什么都不带，一律 422 且不写库', async () => {
    const prisma = prismaFor([], { preference: stored })
    harness = await createTestApp(prisma)
    const put = (body: unknown) => harness!.call('PUT', '/me/preferences', { body })
    const many = Array.from({ length: 31 }, (_, index) => `/app/page-${index}`)
    expect((await put({ favorites: many, version: 4 })).status).toBe(422)
    expect((await put({ favorites: ['/app/a', '/app/a'], version: 4 })).status).toBe(422)
    expect((await put({ favorites: ['/app/inventory/:id'], version: 4 })).status).toBe(422)
    expect((await put({ favorites: ['https://evil.example/app/a'], version: 4 })).status).toBe(422)
    expect((await put({ density: 'HUGE', version: 4 })).status).toBe(422)
    expect((await put({ version: 4 })).status).toBe(422)
    expect(prisma.userPreference.updateMany).not.toHaveBeenCalled()
    expect(prisma.userPreference.create).not.toHaveBeenCalled()
  })

  it('与当前完全相同 422；版本过期 409；没登录 401', async () => {
    const prisma = prismaFor([], { preference: stored })
    harness = await createTestApp(prisma)
    const put = (body: unknown) => harness!.call('PUT', '/me/preferences', { body })
    expect((await put({ favorites: ['/app/overview', '/app/orders'], version: 4 })).status).toBe(422)
    expect((await put({ density: 'COMPACT', version: 4 })).status).toBe(422)
    prisma.userPreference.updateMany.mockResolvedValue({ count: 0 })
    expect((await put({ density: 'STANDARD', version: 3 })).status).toBe(409)
    expect((await harness.call('PUT', '/me/preferences', { body: { density: 'STANDARD', version: 4 }, auth: false })).status).toBe(401)
  })
})

describe('PATCH /auth/me', () => {
  it('没登录 401；显示名为空或过长 422', async () => {
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('PATCH', '/auth/me', { body: { displayName: '李四' }, auth: false })).status).toBe(401)
    await harness.close()
    harness = await createTestApp(prismaFor([]))
    expect((await harness.call('PATCH', '/auth/me', { body: { displayName: '   ' } })).status).toBe(422)
    expect((await harness.call('PATCH', '/auth/me', { body: { displayName: 'a'.repeat(61) } })).status).toBe(422)
    expect((await harness.call('PATCH', '/auth/me', { body: {} })).status).toBe(422)
  })

  it('修改显示名：去首尾空白后写入，写审计（前后值）；没有变化不写库也不写审计', async () => {
    const prisma = prismaFor([])
    harness = await createTestApp(prisma)
    const res = await harness.call('PATCH', '/auth/me', { body: { displayName: '  李四  ' } })
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ displayName: '李四', changed: true })
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({ displayName: '李四' })
    const audits = prisma.auditEvent.create.mock.calls.map((call: any) => call[0].data).filter((data: any) => data.action === 'PROFILE_UPDATED' && data.beforeJson)
    expect(audits[0]).toMatchObject({ resourceType: 'User', beforeJson: { displayName: '张三' }, afterJson: { displayName: '李四' } })
    prisma.user.update.mockClear()
    const same = await harness.call('PATCH', '/auth/me', { body: { displayName: '张三' } })
    expect(same.json.data).toEqual({ displayName: '张三', changed: false })
    expect(prisma.user.update).not.toHaveBeenCalled()
  })
})
