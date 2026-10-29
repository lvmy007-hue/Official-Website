import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告变更记录（P3-14，真实数据库 + 完整应用 + worker 的快照对比代码）：基线、外部变更识别、排除本系统自己的写入、新出现、宽限期、对象消失、快照清理、
// 幂等重扫、列表（来源/类型/档案/关键词/日期、翻页、数据范围、企业隔离）、前后对照、两张表的约束与回滚。

type Member = { userId: string; token: string }
type Scan = { entities: number; snapshots: number; changes: number; created: number; own: number; pruned: number; profiles: number; errors: string[] }
type ScanTenant = (db: unknown, tenantId: string, now?: Date) => Promise<Scan>

const HOUR = 3_600_000
const BASE = Date.now() - 5 * 24 * HOUR
const at = (hours: number) => new Date(BASE + hours * HOUR)
const iso = (hours: number) => at(hours).toISOString()
const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261116010000_ads_changes')

describe('广告变更记录（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let scan: ScanTenant
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let noAds: Member
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const run = (hours: number, tenant: string = tenantId) => runWithTenant(tenant, () => scan(tenantDb, tenant, at(hours)))
  const list = async (member: Member, query = '') => {
    const res = await h.call(member.token, 'GET', `/ads/changes${query}`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as Record<string, any>
  }
  const changeId = async (entityId: string, field: string, kind = 'EXTERNAL', order = 'ASC') =>
    (await rows<{ id: string }>(`SELECT id FROM "AdsChangeLog" WHERE "entityId" = $1 AND "changedField" = $2 AND "actorKind" = $3 ORDER BY "occurredAt" ${order}`, [entityId, field, kind]))[0]!.id
  const compare = (member: Member, id: string) => h.call(member.token, 'GET', `/ads/changes/${id}/compare`)
  const campaign = (id: string, profile: string, name: string, state: string, budget: number, extra: Record<string, unknown> = {}, tenant = tenantId) =>
    insertRow(h.client, 'AdsCampaign', {
      id,
      tenantId: tenant,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      externalCampaignId: `x-${id}`,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state,
      budget,
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...extra,
    })
  const update = (table: string, id: string, set: string, params: unknown[] = []) => h.client.query(`UPDATE "${table}" SET ${set} WHERE id = $1`, [id, ...params])
  const log = (values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsChangeLog', { tenantId, adsProfileId: 'ap-a', entityType: 'CAMPAIGN', entityLabel: 'x', actorKind: 'EXTERNAL', changedField: 'budget', occurredAt: iso(1), ...values })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_changes' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    const profiles: Array<[string, string, string | null, string]> = [
      ['ap-a', 'P-A', storeA, tenantId],
      ['ap-b', 'P-B', storeB, tenantId],
      ['ap-u', 'P-U', null, tenantId],
      ['ap-o', 'P-O', b.sellerAccountId, otherTenantId],
    ]
    for (const [id, profileId, store, tenant] of profiles) {
      await insertRow(h.client, 'AdsProfile', { id, tenantId: tenant, profileId, ...(store ? { sellerAccountId: store, bindingStatus: 'MANUAL' } : {}) })
      await insertRow(h.client, 'AdsAccount', { id: `acct-${id}`, tenantId: tenant, adsProfileId: id, adsAccountId: `ACC-${id}`, name: id })
    }
    await campaign('cam-1', 'ap-a', 'Camp One', 'ENABLED', 20)
    await campaign('cam-2', 'ap-a', 'Camp Two', 'ENABLED', 10)
    await campaign('cam-b', 'ap-b', 'Camp B', 'ENABLED', 5)
    await campaign('cam-u', 'ap-u', 'Camp U', 'ENABLED', 5)
    await campaign('cam-o', 'ap-o', 'Camp O', 'ENABLED', 5, {}, otherTenantId)
    const common = { tenantId, adsProfileId: 'ap-a', adsAccountId: 'ACC-ap-a', sourceUpdatedAt: '2026-10-01T00:00:00Z' }
    await insertRow(h.client, 'AdsAdGroup', { id: 'ag-1', ...common, adGroupId: 'AG1', campaignId: 'x-cam-1', name: 'Core', state: 'ENABLED' })
    await insertRow(h.client, 'AdsKeyword', { id: 'kw-1', ...common, keywordId: 'K1', campaignId: 'x-cam-1', adGroupId: 'AG1', text: 'yoga mat', matchType: 'EXACT', bid: 1.5, state: 'ENABLED' })
    await insertRow(h.client, 'AdsTarget', { id: 'tg-1', ...common, targetId: 'T1', adGroupId: 'AG1', kind: 'PRODUCT', expression: 'asin="B0XYZ"', bid: 0.9, state: 'ENABLED' })

    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_changes', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    scan = (await import(/* @vite-ignore */ String('../../../worker/src/ads-changes/run'))).scanTenantChanges as ScanTenant

    admin = await h.createMember(tenantId, 'admin', ['ads.read'])
    scopedA = await h.createMember(tenantId, 'scopeda', ['ads.read'], { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', ['ads.read'], { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', ['ads.read'])
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('还没拍过快照：列表是“尚未接入”（不是“没有变更”），没有 ads.read 是 403，其他成员的范围内档案也能选', async () => {
    const data = await list(admin)
    expect(data).toMatchObject({ state: 'NOT_CONNECTED', items: [], tracking: { state: 'NOT_CONNECTED', lastSnapshotAt: null }, counts: { MANUAL: 0, AUTO_RULE: 0, DAYPARTING: 0, EXTERNAL: 0 } })
    expect(data.note).toContain('快照')
    expect(data.write.state).toBe('CONNECTED')
    expect((data.profiles as Array<{ id: string }>).map(p => p.id).sort()).toEqual(['ap-a', 'ap-b', 'ap-u'])
    expect(((await list(scopedA)).profiles as Array<{ id: string }>).map(p => p.id)).toEqual(['ap-a'])
    expect((await h.call(noAds.token, 'GET', '/ads/changes')).status).toBe(403)
    expect((await h.call(null, 'GET', '/ads/changes')).status).toBe(401)
  })

  it('第一次扫描是基线：每个对象一份快照，不记任何变更；再扫一次（哈希没变）什么都不写；别的企业的数据不被动到', async () => {
    const first = await run(0)
    expect(first).toMatchObject({ profiles: 3, entities: 7, snapshots: 7, changes: 0, created: 0, own: 0, pruned: 0, errors: [] })
    expect(await run(1)).toMatchObject({ entities: 7, snapshots: 0, changes: 0 })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsEntitySnapshot" WHERE "tenantId" = $1`, [otherTenantId]))[0]!.n).toBe(0)
    const data = await list(admin)
    expect(data).toMatchObject({ state: 'NO_DATA', items: [], tracking: { state: 'OK' } })
    expect(data.tracking.lastSnapshotAt).toBe(iso(0))
    expect(data.note).toContain('没有记录')
  })

  it('外部变更：改了哪个字段记哪个字段（改前、改后、发生区间在上一份快照与检测时间之间）；没追踪的字段变化不记', async () => {
    await update('AdsCampaign', 'cam-1', 'budget = 25, state = $2', ['PAUSED'])
    await update('AdsCampaign', 'cam-2', 'name = $2', ['Camp Two Renamed'])
    await update('AdsCampaign', 'cam-b', 'budget = 7')
    await update('AdsCampaign', 'cam-u', 'state = $2', ['PAUSED'])
    await update('AdsTarget', 'tg-1', 'bid = 1.1')
    await update('AdsKeyword', 'kw-1', `"sourceUpdatedAt" = '2026-10-20T00:00:00Z'`)
    expect(await run(2)).toMatchObject({ changes: 6, snapshots: 5, created: 0, own: 0, errors: [] })
    const budget = (await list(admin, '?entityType=CAMPAIGN&q=Camp One')).items.find((item: Record<string, any>) => item.field === 'budget')
    expect(budget).toMatchObject({
      source: 'EXTERNAL',
      entityId: 'cam-1',
      entityLabel: 'Camp One',
      fieldLabel: '日预算',
      occurredAt: iso(2),
      sinceAt: iso(0),
      actorName: null,
      accountName: 'P-A',
      storeName: expect.any(String),
      path: '/app/advertising/campaigns/cam-1',
    })
    expect(budget.before).toContain('20')
    expect(budget.after).toContain('25')
    const state = await rows<Record<string, any>>(`SELECT "beforeValue", "afterValue", "actorKind", "actorId" FROM "AdsChangeLog" WHERE "entityId" = 'cam-1' AND "changedField" = 'state'`)
    expect(state).toEqual([{ beforeValue: 'ENABLED', afterValue: 'PAUSED', actorKind: 'EXTERNAL', actorId: null }])
  })

  it('本系统自己写入的改动不算外部变更（同对象同字段同值，规整后比较）；写的是别的值就不能排除；快照照样更新，再扫不重复', async () => {
    await log({ id: 'own-1', entityId: 'cam-2', changedField: 'budget', beforeValue: '10', afterValue: '12.50', actorKind: 'MANUAL', actorId: admin.userId, occurredAt: iso(2.5) })
    await log({ id: 'own-2', entityType: 'TARGET', entityId: 'tg-1', entityLabel: 'asin', changedField: 'bid', beforeValue: '1.1', afterValue: '2', actorKind: 'AUTO_RULE', occurredAt: iso(2.5) })
    await update('AdsCampaign', 'cam-2', 'budget = 12.5')
    await update('AdsCampaign', 'cam-1', 'state = $2', ['ENABLED'])
    await update('AdsTarget', 'tg-1', 'bid = 1.8')
    expect(await run(3)).toMatchObject({ changes: 2, own: 1, snapshots: 3 })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsChangeLog" WHERE "entityId" = 'cam-2' AND "changedField" = 'budget' AND "actorKind" = 'EXTERNAL'`))[0]!.n).toBe(0)
    expect(await run(3.5)).toMatchObject({ changes: 0, own: 0, snapshots: 0 })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsChangeLog" WHERE "tenantId" = $1`, [tenantId]))[0]!.n).toBe(10) // 外部 8 + 手动 1 + 自动规则 1
  })

  it('新出现：基线之后进入的对象记“新出现”；初始同步宽限期内进入的、以及该类对象的第一批，都算基线；对象从库里消失不处理', async () => {
    await campaign('cam-new', 'ap-a', 'Camp New', 'ENABLED', 9, { createdAt: iso(30) })
    await campaign('cam-batch', 'ap-a', 'Camp Batch', 'ENABLED', 9, { createdAt: iso(10) })
    await insertRow(h.client, 'AdsPortfolio', {
      id: 'pf-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      portfolioId: 'PF1',
      name: 'Portfolio',
      status: 'ENABLED',
      budgetCap: 500,
      sourceUpdatedAt: iso(0),
      createdAt: iso(30),
    })
    expect(await run(31)).toMatchObject({ created: 1, changes: 1, snapshots: 3 })
    const created = await rows<Record<string, any>>(`SELECT "entityId", "changedField", "beforeValue", "afterValue", "actorKind" FROM "AdsChangeLog" WHERE "changedField" = '__created'`)
    expect(created).toEqual([{ entityId: 'cam-new', changedField: '__created', beforeValue: null, afterValue: 'Camp New', actorKind: 'EXTERNAL' }])
    await h.client.query(`DELETE FROM "AdsCampaign" WHERE id = 'cam-batch'`)
    expect(await run(32)).toMatchObject({ changes: 0, snapshots: 0 })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsEntitySnapshot" WHERE "entityId" = 'cam-batch'`))[0]!.n).toBe(1)
  })

  it('快照清理：被更新的快照取代、又超过 180 天的旧快照删掉，最新的保留', async () => {
    await insertRow(h.client, 'AdsEntitySnapshot', {
      id: 'old-pf',
      tenantId,
      adsProfileId: 'ap-a',
      entityType: 'PORTFOLIO',
      entityId: 'pf-1',
      snapshotAt: iso(-24 * 400),
      stateJson: JSON.stringify({}),
      hash: 'old',
    })
    await update('AdsPortfolio', 'pf-1', '"budgetCap" = 800')
    expect(await run(33)).toMatchObject({ changes: 1, snapshots: 1, pruned: 1 })
    const left = await rows<{ id: string }>(`SELECT id FROM "AdsEntitySnapshot" WHERE "entityId" = 'pf-1' ORDER BY "snapshotAt"`)
    expect(left).toHaveLength(2)
    expect(left.map(row => row.id)).not.toContain('old-pf')
  })

  it('别的企业：各扫各的，互不影响；它的变更只有它自己看得到', async () => {
    await run(1, otherTenantId)
    await update('AdsCampaign', 'cam-o', 'budget = 6')
    expect(await run(2, otherTenantId)).toMatchObject({ changes: 1, entities: 1 })
    const own = await list(other)
    expect(own.items.map((item: Record<string, any>) => item.entityId)).toEqual(['cam-o'])
    expect(own.counts.EXTERNAL).toBe(1)
    expect((await list(admin)).items.map((item: Record<string, any>) => item.entityId)).not.toContain('cam-o')
  })

  it('列表：四种来源的条数、按发生时间倒序、翻页不重不漏、游标换了条件就失效', async () => {
    const data = await list(admin)
    expect(data).toMatchObject({ state: 'OK', note: null, defaulted: true, counts: { MANUAL: 1, AUTO_RULE: 1, DAYPARTING: 0, EXTERNAL: 10 }, pageInfo: { approxTotal: 12, hasMore: false } })
    expect(data.items[0]).toMatchObject({ entityId: 'pf-1', field: 'budgetCap', occurredAt: iso(33) })
    const times = data.items.map((item: Record<string, any>) => item.occurredAt)
    expect([...times].sort().reverse()).toEqual(times)
    const manual = data.items.find((item: Record<string, any>) => item.source === 'MANUAL')
    expect(manual).toMatchObject({ actorName: 'displayName-x', sinceAt: null })
    const seen: string[] = []
    let cursor = ''
    for (let page = 0; page < 3; page += 1) {
      const part = await list(admin, `?pageSize=5${cursor}`)
      seen.push(...part.items.map((item: Record<string, any>) => item.id))
      expect(part.pageInfo.hasMore).toBe(page < 2)
      cursor = part.pageInfo.nextCursor ? `&cursor=${encodeURIComponent(part.pageInfo.nextCursor)}` : ''
    }
    expect(new Set(seen).size).toBe(12)
    const first = await list(admin, '?pageSize=5')
    const stale = await h.call(admin.token, 'GET', `/ads/changes?pageSize=5&source=EXTERNAL&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
    expect(stale.status).toBe(400)
  })

  it('筛选：来源（条数不受来源筛选影响）、对象类型、档案、关键词（对象名与改前改后）、日期范围；没有匹配时说明原因', async () => {
    const external = await list(admin, '?source=EXTERNAL')
    expect(external.pageInfo.approxTotal).toBe(10)
    expect(external.counts).toMatchObject({ MANUAL: 1, AUTO_RULE: 1, EXTERNAL: 10 })
    const target = await list(admin, '?entityType=TARGET')
    expect(target.counts).toMatchObject({ AUTO_RULE: 1, EXTERNAL: 2, MANUAL: 0 })
    expect((await list(admin, '?adsProfileId=ap-b')).items.map((item: Record<string, any>) => item.entityId)).toEqual(['cam-b'])
    expect((await list(admin, '?q=RENAMED')).items.map((item: Record<string, any>) => item.field)).toEqual(['name'])
    expect((await list(admin, '?q=Camp New')).items[0]).toMatchObject({ field: '__created', fieldLabel: '新出现', before: null, after: 'Camp New' })
    const none = await list(admin, '?source=DAYPARTING')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(none.note).toContain('筛选')
    const old = await list(admin, '?from=2020-01-01&to=2020-01-31')
    expect(old).toMatchObject({ state: 'NO_DATA', defaulted: false, items: [], tracking: { state: 'OK' } })
    for (const query of ['?source=BOGUS', '?entityType=BOGUS', '?pageSize=201']) expect((await h.call(admin.token, 'GET', `/ads/changes${query}`)).status, query).toBe(422)
  })

  it('数据范围：受限成员只看到自己店铺绑定的档案；未绑定店铺的档案只有全部店铺的成员看得到', async () => {
    const a = await list(scopedA)
    expect(new Set(a.items.map((item: Record<string, any>) => item.entityId))).toEqual(new Set(['cam-1', 'cam-2', 'tg-1', 'cam-new', 'pf-1']))
    expect(a.counts).toMatchObject({ MANUAL: 1, AUTO_RULE: 1, EXTERNAL: 8 })
    expect((await list(scopedB)).items.map((item: Record<string, any>) => item.entityId)).toEqual(['cam-b'])
    expect((await list(admin)).items.map((item: Record<string, any>) => item.entityId)).toContain('cam-u')
    expect((await list(scopedA)).tracking.lastSnapshotAt).toBe(iso(33))
  })

  it('前后对照：有快照时列出全部追踪字段（改动的标出来，没改的显示快照里的值），并附同一对象的其他变更', async () => {
    const res = await compare(admin, await changeId('cam-1', 'budget'))
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ basis: 'SNAPSHOT', change: { field: 'budget', entityId: 'cam-1' } })
    expect(data.fields.map((field: Record<string, any>) => field.key)).toEqual(['name', 'state', 'budget', 'bidStrategy', 'portfolioId', 'startDate', 'endDate'])
    expect(data.fields.find((field: Record<string, any>) => field.key === 'state')).toMatchObject({ changed: true, before: '已启用', after: '已暂停' })
    expect(data.fields.find((field: Record<string, any>) => field.key === 'name')).toMatchObject({ changed: false, before: 'Camp One', after: 'Camp One' })
    expect(data.related.map((row: Record<string, any>) => [row.field, row.occurredAt])).toEqual([['state', iso(3)]])
    const created = (await compare(admin, await changeId('cam-new', '__created'))).json.data
    expect(created).toMatchObject({ basis: 'SNAPSHOT', change: { field: '__created', after: 'Camp New' } })
    expect(created.fields.find((field: Record<string, any>) => field.key === 'name')).toMatchObject({ before: null, after: 'Camp New', changed: true })
  })

  it('前后对照：没有快照时只列被改的字段；范围外、别的企业、不存在、写法不合法都是 404；没有 ads.read 是 403', async () => {
    await log({ id: 'ghost-1', entityId: 'ghost', entityLabel: 'Ghost', beforeValue: '1', afterValue: '2', actorKind: 'MANUAL', actorId: admin.userId, occurredAt: iso(4) })
    const only = (await compare(admin, 'ghost-1')).json.data
    expect(only).toMatchObject({ basis: 'CHANGE_ONLY', change: { source: 'MANUAL', actorName: 'displayName-x' } })
    expect(only.fields).toEqual([expect.objectContaining({ key: 'budget', label: '日预算', changed: true })])
    const camOne = await changeId('cam-1', 'budget')
    expect((await compare(scopedB, camOne)).status).toBe(404)
    expect((await compare(scopedA, camOne)).status).toBe(200)
    expect((await compare(other, camOne)).status).toBe(404)
    expect((await compare(admin, 'nope')).status).toBe(404)
    expect((await compare(admin, 'bad%20id')).status).toBe(404)
    expect((await compare(noAds, camOne)).status).toBe(403)
  })

  it('表约束：对象类型与来源枚举、快照必须是对象且有哈希、手动才有操作人、只有外部变更才有起点且不晚于发生时间、同一时刻同一字段只记一次', async () => {
    const snap = (values: Record<string, unknown>) =>
      insertRow(h.client, 'AdsEntitySnapshot', {
        id: `chk-${Math.random().toString(36).slice(2)}`,
        tenantId,
        adsProfileId: 'ap-a',
        entityType: 'CAMPAIGN',
        entityId: 'cam-1',
        snapshotAt: iso(50),
        stateJson: JSON.stringify({}),
        hash: 'h',
        ...values,
      })
    await expect(snap({ entityType: 'ADGROUP' })).rejects.toMatchObject({ code: '23514' })
    await expect(snap({ stateJson: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' })
    await expect(snap({ hash: '' })).rejects.toMatchObject({ code: '23514' })
    await snap({ id: 'chk-s1' })
    await expect(snap({ id: 'chk-s2' })).rejects.toMatchObject({ code: '23505' })
    const one = (values: Record<string, unknown>) => log({ id: `chk-${Math.random().toString(36).slice(2)}`, entityId: 'cam-1', occurredAt: iso(60), ...values })
    await expect(one({ entityType: 'ADGROUP' })).rejects.toMatchObject({ code: '23514' })
    await expect(one({ actorKind: 'ROBOT' })).rejects.toMatchObject({ code: '23514' })
    await expect(one({ actorKind: 'EXTERNAL', actorId: admin.userId })).rejects.toMatchObject({ code: '23514' })
    await expect(one({ actorKind: 'MANUAL', sinceAt: iso(59) })).rejects.toMatchObject({ code: '23514' })
    await expect(one({ actorKind: 'EXTERNAL', sinceAt: iso(61) })).rejects.toMatchObject({ code: '23514' })
    await one({ id: 'chk-l1', actorKind: 'EXTERNAL', sinceAt: iso(59) })
    await expect(one({ id: 'chk-l2', actorKind: 'MANUAL' })).rejects.toMatchObject({ code: '23505' })
  })

  it('回滚与重放：rollback.sql 删掉两张表，migration.sql 能重新建出来（行级安全随之恢复）', async () => {
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('AdsEntitySnapshot', 'AdsChangeLog')`)
    expect(gone[0]!.n).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    const back = await rows<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('AdsEntitySnapshot', 'AdsChangeLog') ORDER BY relname`)
    expect(back).toEqual([
      { relname: 'AdsChangeLog', relrowsecurity: true },
      { relname: 'AdsEntitySnapshot', relrowsecurity: true },
    ])
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsChangeLog"`))[0]!.n).toBe(0)
  })
})
