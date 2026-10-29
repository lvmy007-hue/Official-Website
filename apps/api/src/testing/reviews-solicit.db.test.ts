import { WORKFLOW_KINDS } from '@nova/workflow'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { DAY, seedOrder } from './reviews-fixtures'

// 请求评价（P4-13，真实数据库）：可请求订单的期限边界（送达后第 5 至 30 天，含两端）、覆盖率与请求后评分增长、
// 批量请求（权限、范围、连接、开关、逐单校验、事务内的任务与记录与审计、重复与并发、失败重试）。
// 时钟固定（只固定 Date），所有时间数据都用 toISOString() 构造。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const NOW = new Date()
const at = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY + extraMs).toISOString()
const day = (days: number) => at(days).slice(0, 10)
const A1 = 'B0AAAAAAA1'
const A2 = 'B0AAAAAAA2'
const oid = (n: number) => `111-${String(n).padStart(7, '0')}-0000001`
const ORDERS = { open5: oid(1), early: oid(2), last: oid(3), closed: oid(4), mid: oid(5), partial: oid(6), cancel: oid(7), done: oid(8), failed: oid(9), multi: oid(10), s2: oid(11), other: oid(12) }

describe('评价与反馈（真实数据库）：请求评价', () => {
  let h: DbTestApp
  let tenantId: string
  let store1: string
  let store2: string
  let otherStore: string
  let owner: Member
  let reader: Member
  let store2Only: Member
  let outsider: Member

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const solicit = (member: Member, storeId: string, orderIds: string[]) => h.call(member.token, 'POST', '/reviews/solicitations', { body: { storeId, orderIds } })
  const jobs = () => rows(`SELECT * FROM "SyncJob" WHERE "tenantId" = $1 AND type = 'SOLICITATION_SEND'`, [tenantId])
  const requestOf = async (orderId: string) => (await rows(`SELECT * FROM "SolicitationRequest" WHERE "sellerAccountId" = $1 AND "amazonOrderId" = $2`, [store1, orderId]))[0]
  const request = (orderId: string, status: string, requestedDaysAgo: number, extra: Record<string, unknown> = {}) =>
    insertRow(h.client, 'SolicitationRequest', {
      id: `sr-${orderId}`,
      tenantId,
      sellerAccountId: store1,
      amazonOrderId: orderId,
      asins: [A1],
      status,
      requestedAt: at(requestedDaysAgo),
      requestedBy: owner.userId,
      ...extra,
    })
  const eligibleIds = async (member: Member, query = '') => (await get(member, `/reviews/solicitations/eligible${query}`)).items.map((item: Json) => item.amazonOrderId)

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'reviews-solicit' })
    const a = await h.createTenant('rs-a')
    const b = await h.createTenant('rs-b')
    tenantId = a.tenantId
    store1 = a.sellerAccountId
    otherStore = b.sellerAccountId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-rs-a2', sellerId: 'SELLER-RS-2', tenantId, legalEntityId: a.legalEntityId })).id
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE id = $1`, [store1, '店铺甲'])
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE id = $1`, [store2, '店铺乙'])
    owner = await h.createMember(tenantId, 'rs-owner', ['reviews.read', 'reviews.solicit'])
    reader = await h.createMember(tenantId, 'rs-reader', ['reviews.read'])
    store2Only = await h.createMember(tenantId, 'rs-store2', ['reviews.read', 'reviews.solicit'], { scopes: [{ sellerAccountId: store2 }] })
    outsider = await h.createMember(b.tenantId, 'rs-outsider', ['reviews.read', 'reviews.solicit'])
    // 订单：下单日期是送达前 3 天；边界按毫秒构造（第 5 天整点算可请求，差 1 毫秒不到；第 31 天整点已过期，差 1 毫秒还是第 30 天）
    const order = (key: keyof typeof ORDERS, store: string, delivered: Array<string | null>, asins = [A1], status?: string) =>
      seedOrder(h.client, {
        tenantId: store === otherStore ? b.tenantId : tenantId,
        storeId: store,
        id: `o-${key}`,
        amazonOrderId: ORDERS[key],
        purchaseDate: new Date(Date.parse(delivered.find(Boolean) as string) - 3 * DAY).toISOString(),
        asins,
        deliveries: delivered,
        status,
      })
    await order('open5', store1, [at(5)])
    await order('early', store1, [at(5, 1)])
    await order('last', store1, [at(31, 1)])
    await order('closed', store1, [at(31)])
    await order('mid', store1, [at(12)], [A1, A2])
    await order('partial', store1, [at(10), null])
    await order('cancel', store1, [at(10)], [A1], 'Canceled')
    await order('done', store1, [at(8)])
    await order('failed', store1, [at(9)])
    await order('multi', store1, [at(20), at(15)])
    await order('s2', store2, [at(10)])
    await order('other', otherStore, [at(10)])
    await request(ORDERS.done, 'REQUESTED', 7, { sentAt: at(7) })
    await request(ORDERS.failed, 'FAILED', 9, { failureCode: 'SOLICIT_NOT_ELIGIBLE' })
    await insertRow(h.client, 'SolicitationRequest', {
      id: 'sr-done2',
      tenantId,
      sellerAccountId: store1,
      amazonOrderId: oid(99),
      asins: [A2],
      status: 'REQUESTED',
      requestedAt: at(6),
      sentAt: at(6),
      requestedBy: owner.userId,
    })
    const product = (id: string, asin: string) =>
      insertRow(h.client, 'FbaProduct', { id, tenantId, sellerAccountId: store1, asin, sellerSku: `SKU-${id}`, title: `商品 ${asin}`, sourceUpdatedAt: NOW.toISOString() })
    await product('fp-s1', A1)
    await product('fp-s2', A2)
    const snapshot = (id: string, asin: string, date: string, count: number) =>
      insertRow(h.client, 'ReviewMetricSnapshot', {
        id,
        tenantId,
        sellerAccountId: store1,
        asin,
        ratingCount: count,
        captureDate: date,
        sourceFileId: 'file-1',
        sourceFileName: 'a.csv',
        importedBy: owner.userId,
      })
    await snapshot('rm-1', A1, day(9), 100)
    await snapshot('rm-2', A1, day(2), 130)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  }, 240_000)

  afterAll(async () => {
    vi.useRealTimers()
    await h?.close()
  })

  describe('可请求订单', () => {
    it('送达后第 5 至 30 天（含两端）：差 1 毫秒不到的、第 31 天的、有包裹没送达的、已取消的、已请求的都不在；失败的在且标注；多个包裹按最晚送达', async () => {
      const data = await get(owner, `/reviews/solicitations/eligible?storeId=${store1}`)
      expect(data.items.map((item: Json) => item.amazonOrderId)).toEqual([ORDERS.last, ORDERS.multi, ORDERS.mid, ORDERS.failed, ORDERS.open5])
      expect(data.truncated).toBe(false)
      const byId = Object.fromEntries(data.items.map((item: Json) => [item.amazonOrderId, item]))
      expect(byId[ORDERS.open5]).toMatchObject({ dayAfterDelivery: 5, daysLeft: 25, deliveredAt: at(5), lastStatus: null, asins: [A1], storeName: '店铺甲' })
      expect(byId[ORDERS.last]).toMatchObject({ dayAfterDelivery: 30, daysLeft: 0, deliveredAt: at(31, 1) })
      expect(byId[ORDERS.multi]).toMatchObject({ dayAfterDelivery: 15, deliveredAt: at(15) })
      expect(byId[ORDERS.mid].asins).toEqual([A1, A2])
      expect(byId[ORDERS.failed].lastStatus).toBe('FAILED')
      expect(Object.keys(data.items[0]).sort()).toEqual(['amazonOrderId', 'asins', 'daysLeft', 'dayAfterDelivery', 'deliveredAt', 'lastStatus', 'purchaseDate', 'storeId', 'storeName'].sort())
    })

    it('排序、按订单号或 ASIN 搜索、游标翻页与条件绑定', async () => {
      expect(await eligibleIds(owner, `?storeId=${store1}&sort=deliveredAt:desc`)).toEqual([ORDERS.open5, ORDERS.failed, ORDERS.mid, ORDERS.multi, ORDERS.last])
      expect(await eligibleIds(owner, `?storeId=${store1}&q=${ORDERS.mid}`)).toEqual([ORDERS.mid])
      expect(await eligibleIds(owner, `?storeId=${store1}&q=${A2.toLowerCase()}`)).toEqual([ORDERS.mid])
      const first = await get(owner, `/reviews/solicitations/eligible?storeId=${store1}&pageSize=2`)
      expect(first.items).toHaveLength(2)
      expect(first.pageInfo.hasMore).toBe(true)
      const cursor = encodeURIComponent(first.pageInfo.nextCursor)
      expect((await get(owner, `/reviews/solicitations/eligible?storeId=${store1}&pageSize=2&cursor=${cursor}`)).items.map((item: Json) => item.amazonOrderId)).toEqual([ORDERS.mid, ORDERS.failed])
      expect((await h.call(owner.token, 'GET', `/reviews/solicitations/eligible?storeId=${store1}&pageSize=2&sort=deliveredAt:desc&cursor=${cursor}`)).status).toBe(400)
    })

    it('数据范围与企业隔离：范围内的店铺才看得到；点名范围外的店铺 403；别的企业的订单永远不出现', async () => {
      expect(await eligibleIds(store2Only)).toEqual([ORDERS.s2])
      expect((await h.call(store2Only.token, 'GET', `/reviews/solicitations/eligible?storeId=${store1}`)).status).toBe(403)
      expect(await eligibleIds(owner)).toHaveLength(6)
      expect(await eligibleIds(owner)).not.toContain(ORDERS.other)
      expect(await eligibleIds(reader)).toHaveLength(6)
      // 点名别的企业的店铺：按本企业的店铺范围过滤，什么都查不到（不泄露、不报错）
      expect(await eligibleIds(owner, `?storeId=${otherStore}`)).toEqual([])
      expect(await eligibleIds(outsider)).toEqual([ORDERS.other])
    })
  })

  describe('请求评价页签', () => {
    it('覆盖率 = 近 90 天已请求 ÷ 已送达（没有送达是空，不是 0）；现在可请求数；请求后评分数增长（请求前后各一次）；最近的请求记录', async () => {
      const data = await get(owner, `/reviews?tab=solicit&storeId=${store1}`)
      expect(data).toMatchObject({ tab: 'solicit', state: 'OK', truncated: false })
      expect(data.items.map((item: Json) => item.amazonOrderId)).toEqual([ORDERS.last, ORDERS.multi, ORDERS.mid, ORDERS.failed, ORDERS.open5])
      expect(data.coverage).toEqual([{ storeId: store1, storeName: '店铺甲', deliveredOrders: 9, requestedOrders: 2, coverage: 0.222222, eligibleNow: 5 }])
      expect(data.growth.map((row: Json) => [row.asin, row.requestedOrders, row.beforeCount, row.beforeDate, row.afterCount, row.afterDate, row.delta])).toEqual([
        [A1, 1, 100, day(9), 130, day(2), 30],
        [A2, 1, null, null, null, null, null],
      ])
      expect(data.growth[0]).toMatchObject({ firstRequestAt: at(7), title: `商品 ${A1}`, note: null })
      expect(data.growth[1].note).toBe('这个商品还没有导入过评分数')
      expect(data.recent.map((row: Json) => [row.amazonOrderId, row.status, row.failureCode])).toEqual([
        [oid(99), 'REQUESTED', null],
        [ORDERS.done, 'REQUESTED', null],
        [ORDERS.failed, 'FAILED', 'SOLICIT_NOT_ELIGIBLE'],
      ])
      expect(data.basis).toEqual(expect.any(String))
      const all = await get(owner, '/reviews?tab=solicit')
      expect(all.coverage.map((row: Json) => [row.storeName, row.deliveredOrders, row.coverage, row.eligibleNow]).sort()).toEqual([
        ['店铺乙', 1, 0, 1],
        ['店铺甲', 9, 0.222222, 5],
      ])
    })

    it('范围内只看一个店铺的成员只看到这个店铺；别的企业没有这些数据', async () => {
      const scoped = await get(store2Only, '/reviews?tab=solicit')
      expect(scoped.coverage).toEqual([{ storeId: store2, storeName: '店铺乙', deliveredOrders: 1, requestedOrders: 0, coverage: 0, eligibleNow: 1 }])
      expect(scoped.growth).toEqual([])
      expect(scoped.recent).toEqual([])
    })
  })

  describe('批量请求', () => {
    it('权限与参数：没有 reviews.solicit 403；店铺在范围外 403；别的企业的店铺 404；超过 50 单或重复订单 422；都不产生任务', async () => {
      expect((await solicit(reader, store1, [ORDERS.open5])).status).toBe(403)
      const scoped = await solicit(store2Only, store1, [ORDERS.open5])
      expect(scoped.status).toBe(403)
      expect(scoped.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
      expect((await solicit(owner, otherStore, [ORDERS.other])).status).toBe(404)
      expect(
        (
          await solicit(
            owner,
            store1,
            Array.from({ length: 51 }, (_, index) => oid(1000 + index)),
          )
        ).status,
      ).toBe(422)
      expect((await solicit(owner, store1, [ORDERS.open5, ORDERS.open5])).status).toBe(422)
      expect(await jobs()).toHaveLength(0)
    })

    it('没有授权连接 409；写入开关关闭 409 并写 DENIED 审计；这两种情况都不产生任务与请求记录', async () => {
      const before = (await rows(`SELECT 1 FROM "SolicitationRequest"`)).length
      const noConnection = await solicit(owner, store1, [ORDERS.open5])
      expect(noConnection.status).toBe(409)
      expect(noConnection.json.error.code).toBe('CONNECTION_UNAVAILABLE')
      await insertRow(h.client, 'PlatformConnection', { id: 'conn-rs', tenantId, provider: 'AMAZON_SP_API', sellerAccountId: store1, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
      await insertRow(h.client, 'IntegrationSwitch', { id: 'sw-rs', tenantId, switchKey: 'sw.solicitation.send', enabled: false })
      const off = await solicit(owner, store1, [ORDERS.open5])
      expect(off.status).toBe(409)
      expect(off.json.error.code).toBe('WRITE_SWITCH_OFF')
      expect(await jobs()).toHaveLength(0)
      expect(await rows(`SELECT 1 FROM "SolicitationRequest"`)).toHaveLength(before)
      const denied = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'REVIEW_SOLICITATIONS_REQUESTED' AND result = 'DENIED'`, [tenantId])
      expect(denied.length).toBeGreaterThanOrEqual(1)
      await h.client.query(`UPDATE "IntegrationSwitch" SET enabled = true WHERE id = 'sw-rs'`)
    })

    it('逐单校验并受理：可请求的与失败过的进入 QUEUED，其余按原因跳过；同一事务写任务、请求记录与审计，提交后登记流程并入队', async () => {
      h.queue.add.mockClear()
      const ids = [ORDERS.open5, ORDERS.last, ORDERS.mid, ORDERS.failed, ORDERS.early, ORDERS.closed, ORDERS.partial, ORDERS.cancel, ORDERS.done, oid(500)]
      const res = await solicit(owner, store1, ids)
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      const data = res.json.data
      expect(data).toMatchObject({ accepted: 4 })
      expect(data.jobId).toBe(data.batchId)
      expect(data.skipped).toEqual(
        expect.arrayContaining([
          { amazonOrderId: ORDERS.early, reason: 'OUT_OF_WINDOW' },
          { amazonOrderId: ORDERS.closed, reason: 'OUT_OF_WINDOW' },
          { amazonOrderId: ORDERS.partial, reason: 'NOT_DELIVERED' },
          { amazonOrderId: ORDERS.cancel, reason: 'NOT_DELIVERED' },
          { amazonOrderId: ORDERS.done, reason: 'ALREADY_REQUESTED' },
          { amazonOrderId: oid(500), reason: 'NOT_FOUND' },
        ]),
      )
      expect(data.skipped).toHaveLength(6)
      const [job] = await jobs()
      expect(job).toMatchObject({ id: data.batchId, status: 'PENDING', connectionId: 'conn-rs' })
      expect(job.context).toMatchObject({ solicitationBatchId: data.batchId })
      const batch = await rows(`SELECT * FROM "SolicitationRequest" WHERE "tenantId" = $1 AND "batchId" = $2 ORDER BY "amazonOrderId"`, [tenantId, data.batchId])
      expect(batch.map(row => [row.amazonOrderId, row.status])).toEqual([ORDERS.open5, ORDERS.last, ORDERS.mid, ORDERS.failed].sort().map(id => [id, 'QUEUED']))
      expect(batch.every(row => row.requestedBy === owner.userId && row.sentAt === null && row.failureCode === null)).toBe(true)
      expect(batch.find(row => row.amazonOrderId === ORDERS.mid).asins).toEqual([A1, A2])
      expect((await requestOf(ORDERS.failed)).id).toBe(`sr-${ORDERS.failed}`)
      expect((await requestOf(ORDERS.done)).status).toBe('REQUESTED')
      for (const key of ['early', 'closed', 'partial', 'cancel'] as const) expect(await requestOf(ORDERS[key])).toBeUndefined()
      const [audit] = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'REVIEW_SOLICITATIONS_REQUESTED' AND result = 'SUCCEEDED'`, [tenantId])
      expect(audit.afterJson).toMatchObject({ storeId: store1, batchId: data.batchId, orders: 4, skipped: 6 })
      expect(await rows(`SELECT 1 FROM "WorkflowRun" WHERE kind = $1`, [WORKFLOW_KINDS.SOLICITATION_SEND])).toHaveLength(1)
      expect(h.queue.add).toHaveBeenCalledTimes(1)
      expect(h.queue.add).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({ tenantId, syncJobId: data.batchId, solicitationBatchId: data.batchId }),
        data.batchId,
        expect.objectContaining({ type: 'SOLICITATION_SEND' }),
      )
    })

    it('受理后订单不再可请求；再请求同一批是“已请求”，不产生新任务也不入队；数据库唯一约束兜底', async () => {
      expect(await eligibleIds(owner, `?storeId=${store1}`)).toEqual([ORDERS.multi])
      h.queue.add.mockClear()
      const again = await solicit(owner, store1, [ORDERS.open5, ORDERS.last])
      expect(again.status).toBe(201)
      expect(again.json.data).toMatchObject({ accepted: 0, batchId: null, jobId: null })
      expect(again.json.data.skipped.map((item: Json) => item.reason)).toEqual(['ALREADY_REQUESTED', 'ALREADY_REQUESTED'])
      expect(await jobs()).toHaveLength(1)
      expect(h.queue.add).not.toHaveBeenCalled()
      await expect(request(ORDERS.open5, 'QUEUED', 0, { id: 'sr-dup' })).rejects.toThrow(/SolicitationRequest_uq/)
    })

    it('发送失败的订单可以再次请求：回到 QUEUED，失败码清空，换新批次；仍然只有一行记录', async () => {
      await h.client.query(`UPDATE "SolicitationRequest" SET status = 'FAILED', "failureCode" = 'SOLICIT_NOT_ELIGIBLE' WHERE "sellerAccountId" = $1 AND "amazonOrderId" = $2`, [store1, ORDERS.mid])
      expect(await eligibleIds(owner, `?storeId=${store1}`)).toEqual([ORDERS.multi, ORDERS.mid])
      const res = await solicit(owner, store1, [ORDERS.mid])
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ accepted: 1, skipped: [] })
      const row = await requestOf(ORDERS.mid)
      expect(row).toMatchObject({ status: 'QUEUED', failureCode: null, batchId: res.json.data.batchId })
      expect(await rows(`SELECT 1 FROM "SolicitationRequest" WHERE "sellerAccountId" = $1 AND "amazonOrderId" = $2`, [store1, ORDERS.mid])).toHaveLength(1)
      expect(await jobs()).toHaveLength(2)
    })

    it('并发请求同一个订单：只有一个受理，另一个按“已请求”跳过，只多一个任务', async () => {
      await seedOrder(h.client, { tenantId, storeId: store1, id: 'o-race', amazonOrderId: oid(77), purchaseDate: at(13), asins: [A1], deliveries: [at(10)] })
      const [one, two] = await Promise.all([solicit(owner, store1, [oid(77)]), solicit(owner, store1, [oid(77)])])
      expect([one.status, two.status]).toEqual([201, 201])
      expect([one.json.data.accepted, two.json.data.accepted].sort()).toEqual([0, 1])
      const loser = one.json.data.accepted === 0 ? one.json.data : two.json.data
      expect(loser.skipped).toEqual([{ amazonOrderId: oid(77), reason: 'ALREADY_REQUESTED' }])
      expect(await rows(`SELECT 1 FROM "SolicitationRequest" WHERE "amazonOrderId" = $1`, [oid(77)])).toHaveLength(1)
      expect(await jobs()).toHaveLength(3)
    })
  })
})
