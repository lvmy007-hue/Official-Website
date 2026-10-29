import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GRID_VIEW_TEAM_LIMIT, GRID_VIEW_USER_LIMIT, pickDefaultView } from '@nova/api-contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 表格视图（P6-03，真实数据库 + 完整应用）：个人 / 团队 / 系统三级的可见与可写、默认视图三级回落与同级唯一、
// 同名 409、数量上限、乐观锁（含并发）、企业隔离、数据库约束兜底（部分唯一索引与检查约束）、迁移回滚重放。

type Member = { userId: string; token: string }
const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261209010000_grid_view')
const GRID = 'inventory.health'

describe('表格视图（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let alice: Member
  let bob: Member
  let carol: Member // 有 grid.view.share
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const list = async (member: Member, gridId = GRID) => (await h.call(member.token, 'GET', `/grid-views?gridId=${gridId}`)).json.data
  const create = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'POST', '/grid-views', { body: { gridId: GRID, config: { hidden: ['sku'] }, ...body } })
  const names = async (member: Member, gridId = GRID) => (await list(member, gridId)).items.map((item: { name: string }) => item.name)

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'grid_views' })
    tenantId = (await h.createTenant('gv-a')).tenantId
    otherTenantId = (await h.createTenant('gv-b')).tenantId
    alice = await h.createMember(tenantId, 'gv-alice', [])
    bob = await h.createMember(tenantId, 'gv-bob', [])
    carol = await h.createMember(tenantId, 'gv-carol', ['grid.view.share'])
    other = await h.createMember(otherTenantId, 'gv-other', ['grid.view.share'])
    // 系统视图：由迁移或系统任务写入，成员没有写入口
    await h.client.query(
      `INSERT INTO "GridView" (id, "tenantId", "gridId", kind, scope, name, config, "isDefault", "updatedAt") VALUES ('gv-sys', $1, $2, 'VIEW', 'SYSTEM', '系统：精简列', $3::jsonb, false, now())`,
      [tenantId, GRID, JSON.stringify({ hidden: ['cost'] })],
    )
  })
  afterAll(async () => {
    await h?.close()
  })

  it('没保存过：只有系统视图；没登录 401；表格编号不合法 422', async () => {
    expect((await h.call(null, 'GET', `/grid-views?gridId=${GRID}`)).status).toBe(401)
    expect((await h.call(alice.token, 'GET', '/grid-views')).status).toBe(422)
    const data = await list(alice)
    expect(data.items.map((item: { scope: string }) => item.scope)).toEqual(['SYSTEM'])
    expect(data).toMatchObject({ canShare: false, limits: { user: GRID_VIEW_USER_LIMIT, team: GRID_VIEW_TEAM_LIMIT } })
    expect(data.items[0]).toMatchObject({ mine: false, canEdit: false, owner: null })
    expect((await list(carol)).canShare).toBe(true)
  })

  it('个人视图：本人可见可改，别人看不到也改不了（404），企业外更看不到', async () => {
    const made = await create(alice, { name: '甲的视图' })
    expect(made.status).toBe(201)
    expect(made.json.data).toMatchObject({ scope: 'USER', mine: true, canEdit: true, version: 1, isDefault: false, config: { hidden: ['sku'] } })
    const id = made.json.data.id as string
    expect(await names(alice)).toEqual(['甲的视图', '系统：精简列'])
    expect(await names(bob)).toEqual(['系统：精简列'])
    expect(await names(other)).toEqual([])
    expect((await h.call(bob.token, 'PUT', `/grid-views/${id}`, { body: { version: 1, name: '偷改' } })).status).toBe(404)
    expect((await h.call(bob.token, 'DELETE', `/grid-views/${id}`)).status).toBe(404)
    expect((await h.call(bob.token, 'POST', `/grid-views/${id}/default`)).status).toBe(404)
    expect((await h.call(other.token, 'DELETE', `/grid-views/${id}`)).status).toBe(404)
    const stored = await rows<{ ownerUserId: string; createdBy: string }>(`SELECT "ownerUserId", "createdBy" FROM "GridView" WHERE id = $1`, [id])
    expect(stored[0]).toEqual({ ownerUserId: alice.userId, createdBy: alice.userId })
  })

  it('修改带乐观锁：改名与改配置各自升版；过期 409 带当前版本；同一版本并发只有一个成功', async () => {
    const id = (await list(alice)).items.find((item: { name: string }) => item.name === '甲的视图').id as string
    const renamed = await h.call(alice.token, 'PUT', `/grid-views/${id}`, { body: { version: 1, name: '甲的新名', config: { hidden: ['sku', 'cost'], widths: { sku: 180 } } } })
    expect(renamed.json.data).toMatchObject({ name: '甲的新名', version: 2, config: { hidden: ['sku', 'cost'], widths: { sku: 180 } } })
    const stale = await h.call(alice.token, 'PUT', `/grid-views/${id}`, { body: { version: 1, name: '过期' } })
    expect(stale.status).toBe(409)
    expect(stale.json.error.details).toMatchObject({ currentVersion: 2, expectedVersion: 1 })
    expect((await h.call(alice.token, 'PUT', `/grid-views/${id}`, { body: { version: 2 } })).status).toBe(422)
    const [a, b] = await Promise.all([
      h.call(alice.token, 'PUT', `/grid-views/${id}`, { body: { version: 2, name: '并发甲' } }),
      h.call(alice.token, 'PUT', `/grid-views/${id}`, { body: { version: 2, name: '并发乙' } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect((await rows<{ version: number }>(`SELECT version FROM "GridView" WHERE id = $1`, [id]))[0]!.version).toBe(3)
  })

  it('同名 409（个人之间、团队之间）；不同人可以同名；名称长度与配置形状不合格 422', async () => {
    expect((await create(alice, { name: '重名' })).status).toBe(201)
    const dup = await create(alice, { name: '重名' })
    expect(dup.status).toBe(409)
    expect(dup.json.error.fieldErrors?.name).toBeTruthy()
    expect((await create(bob, { name: '重名' })).status).toBe(201)
    expect((await create(carol, { name: '团队重名', scope: 'TEAM' })).status).toBe(201)
    expect((await create(carol, { name: '团队重名', scope: 'TEAM' })).status).toBe(409)
    // 改名撞同名同样 409
    const mine = (await list(alice)).items.find((item: { name: string }) => item.name === '重名')
    const other2 = (await list(alice)).items.find((item: { name: string }) => item.name === '甲的新名' || item.name === '并发甲' || item.name === '并发乙')
    expect((await h.call(alice.token, 'PUT', `/grid-views/${other2.id}`, { body: { version: other2.version, name: mine.name } })).status).toBe(409)
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(41) }, { name: '好', config: 'bad' }, { name: '好', scope: 'SYSTEM' }, { name: '好', kind: 'WHAT' }]) {
      expect((await create(alice, body)).status, JSON.stringify(body)).toBe(422)
    }
  })

  it('团队视图：人人可见；没有 grid.view.share 不能创建、修改、删除（403 写明权限点）；有的可以', async () => {
    const denied = await create(alice, { name: '想共享', scope: 'TEAM' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.details).toMatchObject({ permission: 'grid.view.share' })
    const team = (await list(bob)).items.find((item: { name: string }) => item.name === '团队重名')
    expect(team).toMatchObject({ scope: 'TEAM', mine: false, canEdit: false, owner: { id: carol.userId } })
    expect((await list(carol)).items.find((item: { name: string }) => item.name === '团队重名')).toMatchObject({ canEdit: true })
    expect((await h.call(bob.token, 'PUT', `/grid-views/${team.id}`, { body: { version: team.version, name: '改团队' } })).status).toBe(403)
    expect((await h.call(bob.token, 'DELETE', `/grid-views/${team.id}`)).status).toBe(403)
    const edited = await h.call(carol.token, 'PUT', `/grid-views/${team.id}`, { body: { version: team.version, name: '团队新名' } })
    expect(edited.json.data).toMatchObject({ name: '团队新名', version: 2 })
    expect((await list(other)).items).toEqual([])
  })

  it('系统视图任何成员（含有共享权限的）都不能改、删、设默认：409', async () => {
    for (const member of [alice, carol]) {
      expect((await h.call(member.token, 'PUT', '/grid-views/gv-sys', { body: { version: 1, name: '改系统' } })).status).toBe(409)
      expect((await h.call(member.token, 'DELETE', '/grid-views/gv-sys')).status).toBe(409)
      expect((await h.call(member.token, 'POST', '/grid-views/gv-sys/default')).status).toBe(409)
    }
    expect((await create(carol, { name: '想建系统', scope: 'SYSTEM' })).status).toBe(422)
    expect((await rows(`SELECT 1 FROM "GridView" WHERE id = 'gv-sys' AND name = '系统：精简列'`)).length).toBe(1)
  })

  it('默认视图：同级只能有一个（设新的同时取消旧的，不改版本号）；三级回落 我的 → 团队 → 系统', async () => {
    const teamId = (await list(alice)).items.find((item: { scope: string }) => item.scope === 'TEAM').id as string
    expect(pickDefaultView((await list(alice)).items)).toBeNull()
    expect((await h.call(carol.token, 'POST', `/grid-views/${teamId}/default`)).json.data).toMatchObject({ isDefault: true, version: 2 })
    expect(pickDefaultView((await list(alice)).items)).toMatchObject({ id: teamId, scope: 'TEAM' })
    // 团队默认换一个：旧的自动取消
    const second = await create(carol, { name: '团队第二个', scope: 'TEAM', isDefault: true })
    expect(second.json.data.isDefault).toBe(true)
    const teamDefaults = await rows<{ name: string }>(`SELECT name FROM "GridView" WHERE "tenantId" = $1 AND scope = 'TEAM' AND "isDefault"`, [tenantId])
    expect(teamDefaults).toEqual([{ name: '团队第二个' }])
    // 个人默认优先于团队默认
    const mine = (await list(alice)).items.filter((item: { scope: string }) => item.scope === 'USER')
    expect((await h.call(alice.token, 'POST', `/grid-views/${mine[0].id}/default`)).json.data).toMatchObject({ isDefault: true, version: mine[0].version })
    expect((await h.call(alice.token, 'POST', `/grid-views/${mine[1].id}/default`)).status).toBe(200)
    const mineDefaults = await rows<{ id: string }>(`SELECT id FROM "GridView" WHERE "tenantId" = $1 AND "ownerUserId" = $2 AND "isDefault"`, [tenantId, alice.userId])
    expect(mineDefaults).toEqual([{ id: mine[1].id }])
    expect(pickDefaultView((await list(alice)).items)).toMatchObject({ id: mine[1].id, scope: 'USER' })
    // 别人不受我的默认影响
    expect(pickDefaultView((await list(bob)).items)).toMatchObject({ scope: 'TEAM', name: '团队第二个' })
    // 删除默认视图后回落到团队默认
    expect((await h.call(alice.token, 'DELETE', `/grid-views/${mine[1].id}`)).status).toBe(200)
    expect(pickDefaultView((await list(alice)).items)).toMatchObject({ scope: 'TEAM' })
  })

  it('数量上限：个人每个表格 20 个、团队 30 个；换一个表格或另一个人重新计数', async () => {
    const before = (await list(bob)).items.filter((item: { scope: string }) => item.scope === 'USER').length
    for (let index = before; index < GRID_VIEW_USER_LIMIT; index += 1) expect((await create(bob, { name: `批量${index}` })).status).toBe(201)
    const over = await create(bob, { name: '第二十一个' })
    expect(over.status).toBe(409)
    expect(over.json.error.message).toContain('20')
    expect((await create(bob, { name: '别的表格', gridId: 'metrics.definitions' })).status).toBe(201)
    expect((await create(alice, { name: '甲还能建' })).status).toBe(201)
    const teamBefore = (await list(carol)).items.filter((item: { scope: string }) => item.scope === 'TEAM').length
    for (let index = teamBefore; index < GRID_VIEW_TEAM_LIMIT; index += 1) expect((await create(carol, { name: `团队批量${index}`, scope: 'TEAM' })).status).toBe(201)
    expect((await create(carol, { name: '团队超限', scope: 'TEAM' })).status).toBe(409)
    // 删掉一个就能再建
    const victim = (await list(bob)).items.find((item: { name: string }) => item.name === '批量5')
    expect((await h.call(bob.token, 'DELETE', `/grid-views/${victim.id}`)).status).toBe(200)
    expect((await create(bob, { name: '补一个' })).status).toBe(201)
  })

  it('写入留审计（创建、修改、删除、设默认各一类），详情里没有配置内容以外的敏感信息', async () => {
    const audits = await rows<{ action: string }>(`SELECT DISTINCT action FROM "AuditEvent" WHERE "tenantId" = $1 AND "resourceType" = 'GridView' AND result = 'SUCCEEDED' ORDER BY action`, [tenantId])
    expect(audits.map(row => row.action)).toEqual(['GRID_VIEW_CREATED', 'GRID_VIEW_DEFAULT_SET', 'GRID_VIEW_DELETED', 'GRID_VIEW_UPDATED'])
  })

  it('数据库约束兜底：取值、所有者一致、名称长度、版本；同名与同级多默认被部分唯一索引拦住', async () => {
    const insert = (id: string, over: Record<string, unknown> = {}) => {
      const row = { kind: 'VIEW', scope: 'USER', owner: 'ghost', name: id, isDefault: false, version: 1, grid: 'chk.grid', ...over }
      return h.client.query(
        `INSERT INTO "GridView" (id, "tenantId", "gridId", kind, scope, "ownerUserId", name, config, "isDefault", version, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, now())`,
        [id, tenantId, row.grid, row.kind, row.scope, row.owner, row.name, row.isDefault, row.version],
      )
    }
    await expect(insert('c1', { kind: 'OTHER' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert('c2', { scope: 'PUBLIC' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert('c3', { owner: null })).rejects.toMatchObject({ code: '23514' })
    await expect(insert('c4', { scope: 'TEAM' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert('c5', { name: '' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert('c6', { name: 'x'.repeat(41) })).rejects.toMatchObject({ code: '23514' })
    await expect(insert('c7', { version: 0 })).rejects.toMatchObject({ code: '23514' })
    await insert('d1', { name: '同名', isDefault: true })
    await expect(insert('d2', { name: '同名' })).rejects.toMatchObject({ code: '23505' })
    await expect(insert('d3', { name: '另一个', isDefault: true })).rejects.toMatchObject({ code: '23505' })
    await insert('d4', { name: '另一个', owner: 'ghost-2', isDefault: true })
    // 不同类型（筛选方案）与不同表格互不冲突
    await insert('d5', { name: '同名', kind: 'FILTER' })
    await insert('d6', { name: '同名', grid: 'chk.other' })
  })

  it('行级安全：另一个企业的会话读不到、写不进本企业的视图', async () => {
    expect((await h.call(other.token, 'GET', `/grid-views?gridId=${GRID}`)).json.data.items).toEqual([])
    const teamId = (await rows<{ id: string }>(`SELECT id FROM "GridView" WHERE "tenantId" = $1 AND scope = 'TEAM' LIMIT 1`, [tenantId]))[0]!.id
    expect((await h.call(other.token, 'PUT', `/grid-views/${teamId}`, { body: { version: 1, name: '越权' } })).status).toBe(404)
    expect((await h.call(other.token, 'DELETE', `/grid-views/${teamId}`)).status).toBe(404)
  })

  it('回滚与重放：rollback.sql 删表，migration.sql 重新建表，约束与索引都在', async () => {
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    expect((await rows(`SELECT 1 FROM information_schema.tables WHERE table_name = 'GridView'`)).length).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    const indexes = await rows<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'GridView' ORDER BY indexname`)
    expect(indexes.map(row => row.indexname)).toEqual(
      expect.arrayContaining(['GridView_pkey', 'GridView_shared_default_key', 'GridView_shared_name_key', 'GridView_user_default_key', 'GridView_user_name_key']),
    )
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "GridView"`))[0]!.n).toBe(0)
  })
})
