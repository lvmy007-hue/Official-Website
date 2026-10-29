import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 法律主体（P5-07，真实数据库 + 完整应用）：列表统计与数据范围、详情（店铺、广告账户、被授权成员、变更记录）、
// 新增与修改（乐观锁、重名、停用前置条件、审计）、企业隔离、迁移的回滚与重放。

type Member = { userId: string; token: string }
type Row = Record<string, any>

const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261203010000_legal_entity_version')

describe('法律主体（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let admin: Member
  let reader: Member
  let storeScoped: Member
  let entityScoped: Member
  let other: Member
  let otherEntity: string

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, status = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} ${JSON.stringify(res.json)}`).toBe(status)
    return res.json.data as Row
  }
  const patch = (member: Member, id: string, body: Row) => h.call(member.token, 'PATCH', `/entities/${id}`, { body })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'entities' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherEntity = b.legalEntityId
    await h.client.query(`UPDATE "LegalEntity" SET "name" = '主体甲', "registeredCountry" = '中国', "registrationNo" = '9144' WHERE id = $1`, [a.legalEntityId])
    await insertRow(h.client, 'LegalEntity', { id: 'le-a2', tenantId, name: '主体乙', registeredCountry: '美国' })
    await insertRow(h.client, 'SellerAccount', { id: 'seller-a2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: 'Store-2' })
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = 'Store-1' WHERE id = $1`, [a.sellerAccountId])
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher', sellerAccountId: a.sellerAccountId })
    await insertRow(h.client, 'AdsProfile', { id: 'ap1', tenantId, profileId: 'P1', displayName: 'Ads-1', sellerAccountId: a.sellerAccountId })
    await insertRow(h.client, 'AdsProfile', { id: 'ap2', tenantId, profileId: 'P2', displayName: 'Ads-2', sellerAccountId: 'seller-a2' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap3', tenantId, profileId: 'P3', displayName: 'Ads-3', sellerAccountId: 'seller-a2' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-free', tenantId, profileId: 'P4', displayName: 'Ads-free', sellerAccountId: null })
    admin = await h.createMember(tenantId, 'admin', ['entity.read', 'entity.write', 'member.read'])
    reader = await h.createMember(tenantId, 'reader', ['entity.read'])
    storeScoped = await h.createMember(tenantId, 'storescoped', ['entity.read', 'entity.write', 'member.read'], { scopes: [{ sellerAccountId: 'seller-a2' }] })
    entityScoped = await h.createMember(tenantId, 'entityscoped', ['entity.read'], { scopes: [{ legalEntityId: a.legalEntityId }] })
    other = await h.createMember(b.tenantId, 'other', ['entity.read', 'entity.write'])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('列表：店铺数与广告账户数按名下店铺统计，未绑定的广告账户不属于任何主体；别的企业的主体不出现', async () => {
    const list = await get(admin, '/entities')
    const byName = Object.fromEntries((list.items as Row[]).map(item => [item.name, item]))
    expect(Object.keys(byName).sort()).toEqual(['主体乙', '主体甲'])
    expect(byName['主体甲']).toMatchObject({ storeCount: 2, adsAccountCount: 3, status: 'ACTIVE', version: 1, registrationNo: '9144' })
    expect(byName['主体乙']).toMatchObject({ storeCount: 0, adsAccountCount: 0 })
    expect(list.summary).toEqual({ total: 2, active: 2, inactive: 0 })
    expect(list).toMatchObject({ canWrite: true, writeBlockedReason: null })
    expect((await get(reader, '/entities')).canWrite).toBe(false)
  })

  it('列表：搜索、状态筛选与翻页；搜索也能按注册号', async () => {
    expect(((await get(admin, '/entities?q=9144')).items as Row[]).map(item => item.name)).toEqual(['主体甲'])
    expect(((await get(admin, '/entities?q=美国')).items as Row[]).map(item => item.name)).toEqual(['主体乙'])
    expect((await get(admin, '/entities?status=INACTIVE')).items).toEqual([])
    const first = await get(admin, '/entities?pageSize=1')
    expect(first).toMatchObject({ total: 2, pageSize: 1 })
    expect(first.items).toHaveLength(1)
    expect(((await get(admin, '/entities?pageSize=1&page=2')).items as Row[])[0]!.id).not.toBe((first.items as Row[])[0]!.id)
  })

  it('数据范围：按店铺授权的成员只看到名下有这个店铺的主体，统计只算范围内的店铺，也不能改主体', async () => {
    const list = await get(storeScoped, '/entities')
    expect((list.items as Row[]).map(item => item.name)).toEqual(['主体甲'])
    expect(list.items[0]).toMatchObject({ storeCount: 1, adsAccountCount: 2 })
    expect(list.summary.total).toBe(1)
    expect(list).toMatchObject({ canWrite: false })
    await get(storeScoped, '/entities/le-a2', 404)
    const denied = await patch(storeScoped, 'le-a', { version: 1, name: '改名' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    // 按整个主体授权：该主体的全部店铺都可见
    const whole = await get(entityScoped, '/entities')
    expect(whole.items[0]).toMatchObject({ name: '主体甲', storeCount: 2 })
  })

  it('详情：名下店铺带授权状态、广告账户带所属店铺名；受限成员只看到范围内的店铺', async () => {
    const detail = await get(admin, '/entities/le-a')
    expect(detail.entity).toMatchObject({ name: '主体甲', registeredCountry: '中国', storeCount: 2, adsAccountCount: 3 })
    expect((detail.stores as Row[]).map(store => [store.displayName, store.connectionState])).toEqual([
      ['Store-1', 'AUTHORIZED'],
      ['Store-2', null],
    ])
    expect((detail.adsAccounts as Row[]).map(account => [account.displayName, account.storeName])).toEqual([
      ['Ads-1', 'Store-1'],
      ['Ads-2', 'Store-2'],
      ['Ads-3', 'Store-2'],
    ])
    const scoped = await get(storeScoped, '/entities/le-a')
    expect((scoped.stores as Row[]).map(store => store.displayName)).toEqual(['Store-2'])
    expect(scoped.adsAccounts).toHaveLength(2)
    const empty = await get(admin, '/entities/le-a2')
    expect(empty).toMatchObject({ stores: [], adsAccounts: [], canDeactivate: true })
  })

  it('详情的被授权成员：全部范围、整个主体、指定店铺各一种；没有成员查看权限的看到“无权查看”', async () => {
    const detail = await get(admin, '/entities/le-a')
    expect(detail.members.state).toBe('OK')
    const access = Object.fromEntries((detail.members.items as Row[]).map(item => [item.email, [item.access, item.storeNames]]))
    expect(access['member-admin@example.com']).toEqual(['ALL', []])
    expect(access['member-storescoped@example.com']).toEqual(['STORES', ['Store-2']])
    expect(access['member-entityscoped@example.com']).toEqual(['ENTITY', []])
    expect(access['member-reader@example.com']).toEqual(['ALL', []])
    expect(access['member-other@example.com']).toBeUndefined()
    expect(((await get(admin, '/entities/le-a2')).members.items as Row[]).map(item => item.email).sort()).toEqual(['member-admin@example.com', 'member-reader@example.com'])
    expect((await get(reader, '/entities/le-a')).members).toEqual({ state: 'RESTRICTED', items: [], truncated: false })
  })

  it('修改：版本推进，审计带前后快照与操作人，详情的变更记录据此显示', async () => {
    const res = await patch(admin, 'le-a', { version: 1, name: '主体甲（改）', registrationNo: null })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ changed: true, entity: { name: '主体甲（改）', registrationNo: null, version: 2, storeCount: 2 } })
    const audit = await rows<Row>(
      `SELECT "beforeJson", "afterJson", "actorId", reason FROM "AuditEvent" WHERE "resourceType" = 'LegalEntity' AND "resourceId" = 'le-a' AND "action" = 'LEGAL_ENTITY_UPDATED' AND "result" = 'SUCCEEDED'`,
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorId: admin.userId, beforeJson: { name: '主体甲', registrationNo: '9144' }, afterJson: { name: '主体甲（改）', registrationNo: null } })
    const changes = (await get(admin, '/entities/le-a')).changes as Row[]
    expect(changes[0]).toMatchObject({ action: 'LEGAL_ENTITY_UPDATED', actionLabel: '修改资料', actor: 'displayName-x' })
    expect(changes[0].changes).toEqual([
      { field: 'name', label: '主体名称', before: '主体甲', after: '主体甲（改）' },
      { field: 'registrationNo', label: '注册号', before: '9144', after: null },
    ])
  })

  it('修改：版本过期 409；没有变化不升版本；重名 409；跨企业 404', async () => {
    const stale = await patch(admin, 'le-a', { version: 1, name: '又改' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.details).toMatchObject({ currentVersion: 2, expectedVersion: 1 })
    const same = await patch(admin, 'le-a', { version: 2, name: '主体甲（改）' })
    expect(same.json.data.changed).toBe(false)
    expect((await rows<Row>(`SELECT version FROM "LegalEntity" WHERE id = 'le-a'`))[0]!.version).toBe(2)
    const dup = await patch(admin, 'le-a2', { version: 1, name: '主体甲（改）' })
    expect(dup.status).toBe(409)
    expect(dup.json.error.fieldErrors.name).toBeDefined()
    expect((await patch(admin, otherEntity, { version: 1, name: '越权' })).status).toBe(404)
    expect((await patch(other, 'le-a', { version: 1, name: '越权' })).status).toBe(404)
    expect((await rows<Row>(`SELECT name FROM "LegalEntity" WHERE id = $1`, [otherEntity]))[0]!.name).not.toBe('越权')
    await get(admin, `/entities/${otherEntity}`, 404)
  })

  it('停用：名下有店铺 409；没有店铺要写原因；停用后列表按状态筛选得到，恢复使用不要原因；状态取值有数据库约束', async () => {
    const blocked = await patch(admin, 'le-a', { version: 2, status: 'INACTIVE', reason: '不再使用' })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.message).toContain('2 个店铺')
    expect((await patch(admin, 'le-a2', { version: 1, status: 'INACTIVE' })).status).toBe(422)
    const done = await patch(admin, 'le-a2', { version: 1, status: 'INACTIVE', reason: '主体已注销' })
    expect(done.status, JSON.stringify(done.json)).toBe(200)
    const inactive = await get(admin, '/entities?status=INACTIVE')
    expect((inactive.items as Row[]).map(item => item.name)).toEqual(['主体乙'])
    expect(inactive.summary).toEqual({ total: 2, active: 1, inactive: 1 })
    const detail = await get(admin, '/entities/le-a2')
    expect(detail).toMatchObject({ canDeactivate: false, deactivateBlockedReason: '主体已停用' })
    expect(detail.changes[0]).toMatchObject({ reason: '主体已注销' })
    expect(detail.changes[0].changes).toEqual([{ field: 'status', label: '状态', before: '使用中', after: '已停用' }])
    expect((await patch(admin, 'le-a2', { version: 2, status: 'ACTIVE' })).status).toBe(200)
    await expect(h.client.query(`UPDATE "LegalEntity" SET "status" = 'DELETED' WHERE id = 'le-a2'`)).rejects.toThrow(/LegalEntity_status_check/)
  })

  it('新增：返回 201 并写审计，重名 409（不是 500），别的企业同名不冲突', async () => {
    const created = await h.call(admin.token, 'POST', '/entities', { body: { name: '主体丙', registeredCountry: '中国香港', registrationNo: '' } })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    expect(created.json.data).toMatchObject({ name: '主体丙', version: 1, registrationNo: null, storeCount: 0 })
    const audit = await rows<Row>(`SELECT "afterJson" FROM "AuditEvent" WHERE "resourceId" = $1 AND "action" = 'LEGAL_ENTITY_CREATED' AND "result" = 'SUCCEEDED'`, [created.json.data.id])
    expect(audit[0]!.afterJson).toMatchObject({ name: '主体丙', status: 'ACTIVE' })
    expect((await get(admin, `/entities/${created.json.data.id}`)).changes[0].changes.map((item: Row) => item.field)).toEqual(['name', 'registeredCountry', 'status'])
    const dup = await h.call(admin.token, 'POST', '/entities', { body: { name: '主体丙', registeredCountry: '中国' } })
    expect(dup.status).toBe(409)
    expect((await h.call(other.token, 'POST', '/entities', { body: { name: '主体丙', registeredCountry: '中国' } })).status).toBe(201)
    expect((await h.call(reader.token, 'POST', '/entities', { body: { name: '主体丁', registeredCountry: '中国' } })).status).toBe(403)
  })

  it('迁移的回滚与重放：rollback.sql 删掉版本列与约束，migration.sql 能重新加上，主体行保留', async () => {
    const before = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "LegalEntity"`))[0]!.n
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'LegalEntity' AND column_name = 'version'`)
    expect(gone[0]!.n).toBe(0)
    await h.client.query(`UPDATE "LegalEntity" SET "status" = 'LEGACY' WHERE id = 'le-a2'`) // 约束已删，旧数据里不认识的状态在重放时归一成使用中
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "LegalEntity"`))[0]!.n).toBe(before)
    expect((await rows<Row>(`SELECT status, version FROM "LegalEntity" WHERE id = 'le-a2'`))[0]).toEqual({ status: 'ACTIVE', version: 1 })
  })
})
