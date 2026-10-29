import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAVORITES_MAX, defaultNotifyPrefs } from '@nova/api-contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 外壳偏好（P6-01，真实数据库 + 完整应用）：收藏与密度的读写（默认值、部分保存不动其余项、整体替换、顺序、上限、版本冲突、
// 并发保存只有一个成功、审计只记出现的项、企业与成员隔离）、数据库约束兜底、顶栏未读数新形状、迁移回滚重放。

type Member = { userId: string; token: string }
const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261208010000_shell_preferences')

describe('外壳偏好（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let alice: Member
  let bob: Member
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member) => (await h.call(member.token, 'GET', '/me/preferences')).json.data
  const put = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'PUT', '/me/preferences', { body })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'shell_prefs' })
    tenantId = (await h.createTenant('sp-a')).tenantId
    otherTenantId = (await h.createTenant('sp-b')).tenantId
    alice = await h.createMember(tenantId, 'sp-alice', [])
    bob = await h.createMember(tenantId, 'sp-bob', [])
    other = await h.createMember(otherTenantId, 'sp-other', [])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('没保存过：无收藏、标准密度、版本 0；没登录 401', async () => {
    expect((await h.call(null, 'GET', '/me/preferences')).status).toBe(401)
    expect(await get(alice)).toMatchObject({ favorites: [], density: 'STANDARD', version: 0, notify: defaultNotifyPrefs() })
  })

  it('收藏：第一次保存创建记录；再次保存整体替换并保持顺序；只传收藏不动密度与通知偏好', async () => {
    const created = await put(alice, { favorites: ['/app/overview', '/app/orders'], version: 0 })
    expect(created.status).toBe(200)
    expect(created.json.data).toMatchObject({ favorites: ['/app/overview', '/app/orders'], density: 'STANDARD', version: 1 })
    const density = await put(alice, { density: 'COMPACT', version: 1 })
    expect(density.json.data).toMatchObject({ density: 'COMPACT', favorites: ['/app/overview', '/app/orders'], version: 2 })
    const reordered = await put(alice, { favorites: ['/app/orders', '/app/alerts', '/app/overview'], version: 2 })
    expect(reordered.json.data).toMatchObject({ favorites: ['/app/orders', '/app/alerts', '/app/overview'], density: 'COMPACT', version: 3 })
    expect(await get(alice)).toMatchObject({ favorites: ['/app/orders', '/app/alerts', '/app/overview'], density: 'COMPACT', notify: defaultNotifyPrefs(), version: 3 })
    // 通知偏好整体保存不影响收藏与密度
    const dnd = defaultNotifyPrefs()
    dnd.domains.ADS.INFO = false
    expect((await put(alice, { notify: dnd, version: 3 })).json.data).toMatchObject({ notify: dnd, favorites: ['/app/orders', '/app/alerts', '/app/overview'], density: 'COMPACT', version: 4 })
  })

  it('清空收藏是合法修改；与当前完全相同 422；版本过期 409', async () => {
    expect((await put(alice, { favorites: [], version: 4 })).json.data).toMatchObject({ favorites: [], version: 5 })
    expect((await put(alice, { favorites: [], version: 5 })).status).toBe(422)
    expect((await put(alice, { density: 'COMPACT', version: 5 })).status).toBe(422)
    const stale = await put(alice, { density: 'STANDARD', version: 4 })
    expect(stale.status).toBe(409)
    expect(stale.json.error.details).toMatchObject({ currentVersion: 5, expectedVersion: 4 })
    expect((await get(alice)).density).toBe('COMPACT')
  })

  it('同一版本并发保存：只有一个成功，另一个 409，库里不丢也不重复', async () => {
    const [a, b] = await Promise.all([put(bob, { favorites: ['/app/inventory'], version: 0 }), put(bob, { favorites: ['/app/orders'], version: 0 })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const stored = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "UserPreference" WHERE "tenantId" = $1 AND "userId" = $2`, [tenantId, bob.userId])
    expect(stored[0]!.n).toBe(1)
    const winner = await get(bob)
    expect(winner.favorites).toHaveLength(1)
    expect(winner.version).toBe(1)
  })

  it('不合格的请求 422 且不改库：超过上限、重复、带对象参数、密度不认识、什么都不带', async () => {
    const before = await get(bob)
    const many = Array.from({ length: FAVORITES_MAX + 1 }, (_, index) => `/app/page-${index}`)
    for (const body of [{ favorites: many }, { favorites: ['/app/a', '/app/a'] }, { favorites: ['/app/inventory/:id'] }, { favorites: ['/app/a?x=1'] }, { density: 'HUGE' }, {}]) {
      expect((await put(bob, { ...body, version: before.version })).status, JSON.stringify(body)).toBe(422)
    }
    expect(await get(bob)).toEqual(before)
    // 正好 30 个可以
    const full = Array.from({ length: FAVORITES_MAX }, (_, index) => `/app/page-${index}`)
    expect((await put(bob, { favorites: full, version: before.version })).json.data.favorites).toHaveLength(FAVORITES_MAX)
  })

  it('企业与成员隔离：别人的收藏与密度看不到，别的企业里的偏好从默认开始', async () => {
    expect((await get(other)).favorites).toEqual([])
    expect((await put(other, { favorites: ['/app/ads'], density: 'COMPACT', version: 0 })).status).toBe(200)
    expect((await get(alice)).favorites).toEqual([])
    expect((await get(bob)).favorites).toHaveLength(FAVORITES_MAX)
    const mine = await rows<{ tenantId: string; userId: string }>(`SELECT "tenantId", "userId" FROM "UserPreference" WHERE "favoriteRoutes" @> ARRAY['/app/ads']::text[]`)
    expect(mine).toEqual([{ tenantId: otherTenantId, userId: other.userId }])
  })

  it('审计只记这次出现的项：改密度不带通知偏好，改收藏不带密度', async () => {
    const audits = await rows<{ beforeJson: Record<string, unknown>; afterJson: Record<string, unknown> }>(
      `SELECT "beforeJson", "afterJson" FROM "AuditEvent" WHERE "tenantId" = $1 AND "actorId" = $2 AND action = 'USER_PREFERENCES_UPDATED' AND "result" = 'SUCCEEDED' AND "beforeJson" IS NOT NULL ORDER BY "occurredAt", id`,
      [tenantId, alice.userId],
    )
    expect(audits.map(row => Object.keys(row.afterJson))).toEqual([['favorites'], ['density'], ['favorites'], ['notify'], ['favorites']])
    expect(audits[1]).toMatchObject({ beforeJson: { density: 'STANDARD' }, afterJson: { density: 'COMPACT' } })
  })

  it('数据库约束兜底：密度只能是紧凑或标准，收藏不能超过 30 个', async () => {
    await expect(h.client.query(`INSERT INTO "UserPreference" (id, "tenantId", "userId", "updatedAt", density) VALUES ('chk1', $1, 'ghost-1', now(), 'HUGE')`, [tenantId])).rejects.toMatchObject({
      code: '23514',
    })
    const tooMany = Array.from({ length: FAVORITES_MAX + 1 }, (_, index) => `/app/p${index}`)
    await expect(
      h.client.query(`INSERT INTO "UserPreference" (id, "tenantId", "userId", "updatedAt", "favoriteRoutes") VALUES ('chk2', $1, 'ghost-2', now(), $2::text[])`, [tenantId, tooMany]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('顶栏未读数：messages 与旧字段 unreadCount 同值，alerts 尚未接入为 null；只统计本人', async () => {
    await h.client.query(
      `INSERT INTO "Notification" (id, "tenantId", "userId", kind, title, body, severity, "createdAt") VALUES ('n-a1', $1, $2, 'SYSTEM', '甲', '内容', 'INFO', now()), ('n-a2', $1, $2, 'SYSTEM', '乙', '内容', 'INFO', now())`,
      [tenantId, alice.userId],
    )
    await h.client.query(`INSERT INTO "Notification" (id, "tenantId", "userId", kind, title, body, severity, "createdAt") VALUES ('n-b1', $1, $2, 'SYSTEM', '丙', '内容', 'INFO', now())`, [
      tenantId,
      bob.userId,
    ])
    expect((await h.call(alice.token, 'GET', '/notifications/unread-count')).json.data).toEqual({ unreadCount: 2, messages: 2, alerts: null })
    expect((await h.call(bob.token, 'GET', '/notifications/unread-count')).json.data).toEqual({ unreadCount: 1, messages: 1, alerts: null })
    expect((await h.call(other.token, 'GET', '/notifications/unread-count')).json.data).toEqual({ unreadCount: 0, messages: 0, alerts: null })
    expect((await h.call(null, 'GET', '/notifications/unread-count')).status).toBe(401)
  })

  it('回滚与重放：rollback.sql 删掉两列，migration.sql 能重新加回来，已有行取默认值', async () => {
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'UserPreference' AND column_name IN ('favoriteRoutes', 'density')`)
    expect(gone[0]!.n).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    const back = await rows<{ density: string; favoriteRoutes: string[] }>(`SELECT density, "favoriteRoutes" FROM "UserPreference" WHERE "tenantId" = $1 LIMIT 1`, [tenantId])
    expect(back[0]).toEqual({ density: 'STANDARD', favoriteRoutes: [] })
  })
})
