import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// A+ 内容（P4-14，真实数据库）：检查约束、唯一键与级联删除、行级安全、受理写入的落库与并发（版本锁、进行中的写入）、跨企业与店铺范围隔离、
// 图片核对（上传记录的 JSON 路径查询）。读取接口的外形与参数校验见 modules/aplus/*.http.test.ts（内存替身）。

type Json = ReturnType<typeof JSON.parse>
type Member = { userId: string; token: string }

const TABLES = ['AplusContent', 'AplusAsinRelation', 'AplusReviewEvent', 'AplusWriteRun'] as const
const TEXT = (headline: string, body: string) => ({ type: 'STANDARD_TEXT', headline, body })
const LOGO = (id: string) => ({ type: 'STANDARD_COMPANY_LOGO', image: { uploadDestinationId: id, altText: '品牌标志' } })
const A1 = 'B0AAAAAAA1'
const A2 = 'B0AAAAAAA2'

describe('A+ 内容（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let store1: string
  let store2: string
  let otherTenant: string
  let otherStore: string
  let owner: Member
  let reader: Member
  let outsider: Member
  let seq = 0

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const content = (over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AplusContent', { id: `ac-${++seq}`, tenantId, sellerAccountId: store1, name: `内容 ${seq}`, contentReferenceKey: `KEY-${seq}`, ...over })
  const run = (over: Record<string, unknown> = {}) => insertRow(h.client, 'AplusWriteRun', { id: `ar-${++seq}`, tenantId, sellerAccountId: store1, kind: 'UPDATE', status: 'SUCCEEDED', ...over })
  // 一条上传记录：宽高与文件信息在请求内容里，上传编号在结果里（和后台任务写入的形状一致）
  const upload = (id: string, store: string, dest: string, width: number, height: number, status = 'SUCCEEDED') =>
    run({
      id,
      sellerAccountId: store,
      contentId: null,
      kind: 'UPLOAD',
      status,
      requestJson: { fileName: `.png`, contentType: 'image/png', sizeBytes: 1000, width, height },
      resultJson: { uploadDestinationId: dest },
    })
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const send = (member: Member, method: string, path: string, body: unknown) => h.call(member.token, method, path, { body })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'aplus' })
    const a = await h.createTenant('ap-a')
    const b = await h.createTenant('ap-b')
    tenantId = a.tenantId
    store1 = a.sellerAccountId
    otherTenant = b.tenantId
    otherStore = b.sellerAccountId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-ap-a2', sellerId: 'SELLER-AP-2', tenantId, legalEntityId: a.legalEntityId })).id
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '店铺甲' WHERE id = $1`, [store1])
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '店铺乙' WHERE id = $1`, [store2])
    owner = await h.createMember(tenantId, 'ap-owner', ['aplus.read', 'aplus.write', 'analytics.read'])
    reader = await h.createMember(tenantId, 'ap-reader', ['aplus.read'])
    outsider = await h.createMember(otherTenant, 'ap-outsider', ['aplus.read', 'aplus.write'])
    // 两个企业各有一个已授权的卖家连接；本企业的写入开关“A+ 内容提交”开启
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-ap-a', tenantId, provider: 'AMAZON_SP_API', sellerAccountId: store1, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-ap-b',
      tenantId: otherTenant,
      provider: 'AMAZON_SP_API',
      sellerAccountId: otherStore,
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'cipher',
    })
    await insertRow(h.client, 'IntegrationSwitch', { id: 'sw-ap-a', tenantId, switchKey: 'sw.aplus.submit', enabled: true })
    await insertRow(h.client, 'IntegrationSwitch', { id: 'sw-ap-b', tenantId: otherTenant, switchKey: 'sw.aplus.submit', enabled: true })
  }, 240_000)

  afterAll(async () => {
    await h?.close()
  })

  describe('检查约束、唯一键与级联', () => {
    it('内容：状态与类型取值受限，版本不小于 1，关联数不为负，名称不能为空', async () => {
      for (const over of [{ status: 'ARCHIVED' }, { contentType: 'EBX' }, { version: 0 }, { asinCount: -1 }, { name: '' }]) {
        await expect(content({ contentReferenceKey: null, ...over }), JSON.stringify(over)).rejects.toMatchObject({ code: '23514' })
      }
      const ok = await content({ contentReferenceKey: null })
      expect(ok).toMatchObject({ status: 'DRAFT', contentType: 'EBC', locale: 'en-US', version: 1, asinCount: 0, marketplaceId: 'ATVPDKIKX0DER' })
    })

    it('关联 ASIN 必须是 10 位大写字母或数字；审核事件的状态与来源受限；写入记录的类型与状态受限', async () => {
      const c = await content()
      await expect(insertRow(h.client, 'AplusAsinRelation', { id: `rel-${++seq}`, tenantId, contentId: c.id, sellerAccountId: store1, asin: 'b0aaaaaaa1' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(h.client, 'AplusReviewEvent', { id: `ev-${++seq}`, tenantId, contentId: c.id, status: 'DELETED', occurredAt: '2026-10-01T00:00:00Z' })).rejects.toMatchObject({
        code: '23514',
      })
      await expect(
        insertRow(h.client, 'AplusReviewEvent', { id: `ev-${++seq}`, tenantId, contentId: c.id, status: 'DRAFT', source: 'IMPORT', occurredAt: '2026-10-01T00:00:00Z' }),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(run({ contentId: c.id, kind: 'DELETE' })).rejects.toMatchObject({ code: '23514' })
      await expect(run({ contentId: c.id, status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    })

    it('写入记录：除“上传图片”外都必须带内容编号；上传图片没有内容也可以', async () => {
      for (const kind of ['CREATE', 'UPDATE', 'ASSOCIATE', 'SUBMIT']) await expect(run({ contentId: null, kind }), kind).rejects.toMatchObject({ code: '23514' })
      const c = await content()
      for (const kind of ['CREATE', 'UPDATE', 'ASSOCIATE', 'SUBMIT']) await run({ contentId: c.id, kind })
      expect(await run({ contentId: null, kind: 'UPLOAD' })).toMatchObject({ contentId: null, status: 'SUCCEEDED' })
    })

    it('唯一键：同店铺同站点的亚马逊引用键不能重复；没有引用键的草稿可以有多份；关联按内容与 ASIN 唯一；审核事件按内容、状态与时间唯一', async () => {
      const first = await content({ contentReferenceKey: 'DUP-KEY' })
      await expect(content({ contentReferenceKey: 'DUP-KEY' })).rejects.toMatchObject({ code: '23505' })
      await content({ sellerAccountId: store2, contentReferenceKey: 'DUP-KEY' })
      await content({ contentReferenceKey: null })
      await content({ contentReferenceKey: null })
      await insertRow(h.client, 'AplusAsinRelation', { id: `rel-${++seq}`, tenantId, contentId: first.id, sellerAccountId: store1, asin: A1 })
      await expect(insertRow(h.client, 'AplusAsinRelation', { id: `rel-${++seq}`, tenantId, contentId: first.id, sellerAccountId: store1, asin: A1 })).rejects.toMatchObject({ code: '23505' })
      const event = { tenantId, contentId: first.id, status: 'SUBMITTED', occurredAt: '2026-10-01T00:00:00Z' }
      await insertRow(h.client, 'AplusReviewEvent', { id: `ev-${++seq}`, ...event })
      await expect(insertRow(h.client, 'AplusReviewEvent', { id: `ev-${++seq}`, ...event })).rejects.toMatchObject({ code: '23505' })
    })

    it('删除内容时，关联、审核事件、写入记录一起删除；没有内容的上传记录不受影响', async () => {
      const c = await content()
      await insertRow(h.client, 'AplusAsinRelation', { id: `rel-${++seq}`, tenantId, contentId: c.id, sellerAccountId: store1, asin: A2 })
      await insertRow(h.client, 'AplusReviewEvent', { id: `ev-${++seq}`, tenantId, contentId: c.id, status: 'DRAFT', occurredAt: '2026-10-02T00:00:00Z' })
      const r = await run({ contentId: c.id })
      const upload = await run({ contentId: null, kind: 'UPLOAD' })
      await h.client.query(`DELETE FROM "AplusContent" WHERE id = $1`, [c.id])
      for (const [table, column] of [
        ['AplusAsinRelation', 'contentId'],
        ['AplusReviewEvent', 'contentId'],
        ['AplusWriteRun', 'contentId'],
      ]) {
        expect(await rows(`SELECT 1 FROM "${table}" WHERE "${column}" = $1`, [c.id]), table).toHaveLength(0)
      }
      expect(await rows(`SELECT 1 FROM "AplusWriteRun" WHERE id = $1`, [r.id])).toHaveLength(0)
      expect(await rows(`SELECT 1 FROM "AplusWriteRun" WHERE id = $1`, [upload.id])).toHaveLength(1)
    })
  })

  describe('行级安全', () => {
    it('四张表都有按企业隔离的策略；接口账号只能看到并写入自己企业的行；没有设置企业时什么都看不到', async () => {
      await content({ tenantId: otherTenant, sellerAccountId: otherStore, contentReferenceKey: 'OTHER-1' })
      const policies = await rows(`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) AND qual LIKE '%nova_current_tenant%'`, [[...TABLES]])
      expect(policies.map(row => row.tablename).sort()).toEqual([...TABLES].sort())
      const app = new Client({ connectionString: h.db.urlFor('aplus', 'app') })
      await app.connect()
      try {
        await app.query('BEGIN')
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [otherTenant])
        expect((await app.query(`SELECT count(*)::int AS n FROM "AplusContent" WHERE "tenantId" = $1`, [tenantId])).rows[0].n).toBe(0)
        expect((await app.query(`SELECT count(*)::int AS n FROM "AplusContent"`)).rows[0].n).toBe(1)
        await expect(app.query(`INSERT INTO "AplusContent" (id, "tenantId", "sellerAccountId", name) VALUES ('rls-x', $1, $2, 'x')`, [tenantId, store1])).rejects.toMatchObject({ code: '42501' })
        await app.query('ROLLBACK')
        await app.query('BEGIN')
        for (const table of TABLES) expect((await app.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n, table).toBe(0)
        await app.query('ROLLBACK')
      } finally {
        await app.end()
      }
    })
  })

  describe('受理写入（真实事务与并发）', () => {
    let contentId: string

    it('创建：一次事务写入草稿（版本 1）、写入记录、后台任务与审计，入队一次；图片只认本店铺成功上传的记录', async () => {
      // 店铺乙的上传成功记录不能给店铺甲用；店铺甲自己的成功记录可以用，尺寸不够不行
      await upload('up-store2', store2, 'DEST-2', 600, 180)
      await upload('up-small', store1, 'DEST-S', 100, 100)
      await upload('up-ok', store1, 'DEST-1', 600, 180)
      await upload('up-failed', store1, 'DEST-F', 600, 180, 'FAILED')
      for (const id of ['DEST-2', 'DEST-F', 'nothing']) expect((await send(owner, 'POST', '/aplus', { storeId: store1, name: 'x', modules: [LOGO(id)] })).status, id).toBe(422)
      const small = await send(owner, 'POST', '/aplus', { storeId: store1, name: 'x', modules: [LOGO('DEST-S')] })
      expect(small.status).toBe(422)
      expect(small.json.error.message).toContain('100×100')
      expect(await rows(`SELECT 1 FROM "AplusContent" WHERE name = 'x'`)).toHaveLength(0)

      const res = await send(owner, 'POST', '/aplus', { storeId: store1, name: '春季新品', modules: [TEXT('标题', '正文'), LOGO('DEST-1')] })
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ status: 'QUEUED', version: 1, queued: true })
      contentId = res.json.data.contentId
      const [saved] = await rows(`SELECT * FROM "AplusContent" WHERE id = $1`, [contentId])
      expect(saved).toMatchObject({ tenantId, sellerAccountId: store1, name: '春季新品', status: 'DRAFT', version: 1, contentReferenceKey: null, createdBy: owner.userId })
      expect(saved.draftJson.contentModuleList).toHaveLength(2)
      const [created] = await rows(`SELECT * FROM "AplusWriteRun" WHERE id = $1`, [res.json.data.runId])
      expect(created).toMatchObject({ contentId, kind: 'CREATE', status: 'QUEUED', requestedBy: owner.userId })
      const [job] = await rows(`SELECT * FROM "SyncJob" WHERE id = $1`, [created.syncJobId])
      expect(job).toMatchObject({ tenantId, type: 'APLUS_WRITE', status: 'PENDING', connectionId: 'conn-ap-a', context: { aplusRunId: created.id, storeId: store1 } })
      expect(await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'APLUS_CREATED' AND "resourceId" = $2`, [tenantId, contentId])).toHaveLength(1)
      expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ syncJobId: job.id, aplusRunId: created.id }), job.id, expect.anything())
    })

    it('创建还在排队时：保存、关联、提交都是 409（进行中的写入），详情里显示进行中的写入且按钮都不可用', async () => {
      for (const [method, path, body] of [
        ['PATCH', `/aplus/${contentId}`, { version: 1, name: '改名' }],
        ['POST', `/aplus/${contentId}/asins`, { version: 1, asins: [A1] }],
        ['POST', `/aplus/${contentId}/submit`, { version: 1 }],
      ]) {
        const res = await send(owner, method as string, path as string, body)
        expect(res.status, path as string).toBe(409)
      }
      const detail = await get(owner, `/aplus/${contentId}`)
      expect(detail.item.pendingRun).toMatchObject({ kind: 'CREATE', status: 'QUEUED' })
      expect(detail.actions.edit.allowed).toBe(false)
      expect(await rows(`SELECT 1 FROM "AplusWriteRun" WHERE "contentId" = $1`, [contentId])).toHaveLength(1)
    })

    it('创建完成后保存：版本加一，名称与草稿文档立即更新；没有 aplus.write 的成员 403，不改任何东西', async () => {
      await h.client.query(`UPDATE "AplusContent" SET "contentReferenceKey" = 'KEY-NEW' WHERE id = $1`, [contentId])
      await h.client.query(`UPDATE "AplusWriteRun" SET status = 'SUCCEEDED' WHERE "contentId" = $1`, [contentId])
      expect((await send(reader, 'PATCH', `/aplus/${contentId}`, { version: 1, name: '越权' })).status).toBe(403)
      const res = await send(owner, 'PATCH', `/aplus/${contentId}`, { version: 1, name: '春季新品（改）', modules: [TEXT('新标题', '新正文')] })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(res.json.data).toMatchObject({ contentId, version: 2, queued: true })
      const [saved] = await rows(`SELECT name, version, "draftJson" FROM "AplusContent" WHERE id = $1`, [contentId])
      expect(saved.name).toBe('春季新品（改）')
      expect(saved.version).toBe(2)
      expect(saved.draftJson.contentModuleList).toHaveLength(1)
      const [updated] = await rows(`SELECT kind, status, "requestJson" FROM "AplusWriteRun" WHERE id = $1`, [res.json.data.runId])
      expect(updated).toMatchObject({ kind: 'UPDATE', status: 'QUEUED' })
      expect(updated.requestJson.name).toBe('春季新品（改）')
      await h.client.query(`UPDATE "AplusWriteRun" SET status = 'SUCCEEDED' WHERE "contentId" = $1`, [contentId])
    })

    it('并发：两个人拿着同一个版本同时保存，只有一个成功（200），另一个 409；只多一条写入记录，版本只加一', async () => {
      const before = (await rows(`SELECT count(*)::int AS n FROM "AplusWriteRun" WHERE "contentId" = $1`, [contentId]))[0].n
      const results = await Promise.all([1, 2].map(n => send(owner, 'PATCH', `/aplus/${contentId}`, { version: 2, name: `并发 ${n}` })))
      expect(results.map(res => res.status).sort()).toEqual([200, 409])
      expect((await rows(`SELECT version FROM "AplusContent" WHERE id = $1`, [contentId]))[0].version).toBe(3)
      expect((await rows(`SELECT count(*)::int AS n FROM "AplusWriteRun" WHERE "contentId" = $1`, [contentId]))[0].n).toBe(before + 1)
      expect((await rows(`SELECT count(*)::int AS n FROM "AplusWriteRun" WHERE "contentId" = $1 AND status = 'QUEUED'`, [contentId]))[0].n).toBe(1)
    })

    it('关联 ASIN 与提交审核：版本都加一；没有关联 ASIN 时提交被拒（409）', async () => {
      await h.client.query(`UPDATE "AplusWriteRun" SET status = 'SUCCEEDED' WHERE "contentId" = $1`, [contentId])
      const noAsin = await send(owner, 'POST', `/aplus/${contentId}/submit`, { version: 3 })
      expect(noAsin.status).toBe(409)
      const associated = await send(owner, 'POST', `/aplus/${contentId}/asins`, { version: 3, asins: [A1, A2] })
      expect(associated.status, JSON.stringify(associated.json)).toBe(201)
      expect(associated.json.data.version).toBe(4)
      expect((await rows(`SELECT "requestJson" FROM "AplusWriteRun" WHERE id = $1`, [associated.json.data.runId]))[0].requestJson).toEqual({ asins: [A1, A2] })
      // 同步任务（后台）把关联写回：这里手工模拟，再提交审核
      await h.client.query(`UPDATE "AplusWriteRun" SET status = 'SUCCEEDED' WHERE "contentId" = $1`, [contentId])
      await h.client.query(`UPDATE "AplusContent" SET "asinCount" = 2 WHERE id = $1`, [contentId])
      const submitted = await send(owner, 'POST', `/aplus/${contentId}/submit`, { version: 4 })
      expect(submitted.status, JSON.stringify(submitted.json)).toBe(201)
      expect(submitted.json.data.version).toBe(5)
      expect(await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action IN ('APLUS_ASINS_ASSOCIATED', 'APLUS_SUBMITTED')`, [tenantId])).toHaveLength(2)
    })
  })

  describe('读取与隔离', () => {
    it('列表：只看到自己企业的内容；筛选、排序、翻页与汇总（汇总不受筛选影响）', async () => {
      await h.client.query(`DELETE FROM "AplusContent" WHERE "tenantId" = $1`, [tenantId])
      const mk = (name: string, status: string, store = store1) => content({ name, status, sellerAccountId: store })
      const a = await mk('Alpha', 'DRAFT')
      await mk('Beta', 'REJECTED')
      await mk('Gamma', 'PUBLISHED', store2)
      await insertRow(h.client, 'AplusAsinRelation', { id: `rel-${++seq}`, tenantId, contentId: a.id, sellerAccountId: store1, asin: A1 })
      await run({ contentId: a.id, status: 'RUNNING' })
      const all = await get(owner, '/aplus?sort=name:asc')
      expect(all.items.map((item: Json) => item.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(all.summary).toMatchObject({ total: 3, pending: 1, byStatus: { DRAFT: 1, REJECTED: 1, PUBLISHED: 1 } })
      const filtered = await get(owner, `/aplus?storeId=${store1}&status=DRAFT&q=LPH&asin=${A1.toLowerCase()}`)
      expect(filtered.items.map((item: Json) => item.name)).toEqual(['Alpha'])
      expect(filtered.items[0].pendingRun).toMatchObject({ status: 'RUNNING' })
      expect(filtered.summary.total).toBe(2)
      const first = await get(owner, '/aplus?pageSize=2&sort=status:asc')
      expect(first.items.map((item: Json) => item.status)).toEqual(['DRAFT', 'REJECTED'])
      const second = await get(owner, `/aplus?pageSize=2&sort=status:asc&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(second.items.map((item: Json) => item.status)).toEqual(['PUBLISHED'])
      expect((await get(outsider, '/aplus')).items).toHaveLength(1)
    })

    it('别的企业的内容：详情与所有写入都是 404（不是 403），也看不到上传记录；别的企业的店铺筛选是 403', async () => {
      const [foreign] = await rows(`SELECT id FROM "AplusContent" WHERE "tenantId" = $1`, [otherTenant])
      expect((await h.call(owner.token, 'GET', `/aplus/${foreign.id}`)).status).toBe(404)
      expect((await send(owner, 'PATCH', `/aplus/${foreign.id}`, { version: 1, name: 'x' })).status).toBe(404)
      expect((await send(owner, 'POST', `/aplus/${foreign.id}/submit`, { version: 1 })).status).toBe(404)
      expect((await send(owner, 'POST', '/aplus', { storeId: otherStore, name: 'x', modules: [TEXT('a', 'b')] })).status).toBe(404)
      expect((await get(outsider, '/aplus/uploads')).items).toHaveLength(0)
      const uploads = await get(owner, '/aplus/uploads')
      expect(uploads.items.length).toBeGreaterThanOrEqual(3)
      expect(uploads.items.every((item: Json) => [store1, store2].includes(item.storeId))).toBe(true)
    })

    it('店铺范围：只授权了店铺乙的成员看不到店铺甲的内容（列表没有、详情 404、按店铺筛选 403、在店铺甲创建 403）', async () => {
      const scoped = await h.createMember(tenantId, 'ap-store2', ['aplus.read', 'aplus.write'], { scopes: [{ sellerAccountId: store2 }] })
      const list = await get(scoped, '/aplus')
      expect(list.items.map((item: Json) => item.storeId)).toEqual([store2])
      const [mine] = await rows(`SELECT id FROM "AplusContent" WHERE "sellerAccountId" = $1`, [store1])
      expect((await h.call(scoped.token, 'GET', `/aplus/${mine.id}`)).status).toBe(404)
      expect((await h.call(scoped.token, 'GET', `/aplus?storeId=${store1}`)).status).toBe(403)
      expect((await send(scoped, 'POST', '/aplus', { storeId: store1, name: 'x', modules: [TEXT('a', 'b')] })).status).toBe(403)
    })
  })
})
