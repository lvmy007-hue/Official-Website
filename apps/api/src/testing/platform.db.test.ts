import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'

// 平台能力的真实数据库行为（P1-28）：通知与待办的归属与隔离、版本冲突、写入开关默认关闭、导出任务的归属、数据新鲜度、指标口径。

describe('平台能力（真实数据库）', () => {
  let h: DbTestApp
  let a: Awaited<ReturnType<DbTestApp['createTenant']>>
  let b: Awaited<ReturnType<DbTestApp['createTenant']>>
  let owner: { userId: string; token: string }
  let colleague: { userId: string; token: string }
  let other: { userId: string; token: string }
  let viewer: { userId: string; token: string }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'platform' })
    a = await h.createTenant('pla')
    b = await h.createTenant('plb')
    owner = await h.createMember(a.tenantId, 'pla-owner', ['*'])
    colleague = await h.createMember(a.tenantId, 'pla-col', ['workitem.handle', 'collab.write'])
    viewer = await h.createMember(a.tenantId, 'pla-view', [])
    other = await h.createMember(b.tenantId, 'plb-owner', ['*'])
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  describe('通知：只属于收件人', () => {
    const notice = (id: string, tenantId: string, userId: string, dedupKey: string) =>
      insertRow(h.client, 'Notification', { id, tenantId, userId, kind: 'WORK_OVERDUE', title: `通知 ${id}`, severity: 'WARNING', dedupKey })

    it('列表与未读数只统计本人的；标记已读时别人的通知不受影响', async () => {
      await notice('n-own-1', a.tenantId, owner.userId, 'k1')
      await notice('n-own-2', a.tenantId, owner.userId, 'k2')
      await notice('n-col-1', a.tenantId, colleague.userId, 'k3')
      await notice('n-other-1', b.tenantId, other.userId, 'k4')

      const list = await h.call(owner.token, 'GET', '/notifications')
      expect(list.status, JSON.stringify(list.json)).toBe(200)
      expect(list.json.data.items.map((item: { id: string }) => item.id).sort()).toEqual(['n-own-1', 'n-own-2'])
      expect(list.json.data.unreadCount).toBe(2)
      expect((await h.call(colleague.token, 'GET', '/notifications/unread-count')).json.data.unreadCount).toBe(1)

      // 试图把同事、别的企业的通知一起标为已读：只更新自己的
      const read = await h.call(owner.token, 'POST', '/notifications/read', { body: { ids: ['n-own-1', 'n-col-1', 'n-other-1'] } })
      expect(read.status, JSON.stringify(read.json)).toBeLessThan(300)
      const { rows } = await h.client.query<{ id: string; readAt: Date | null }>(`SELECT "id", "readAt" FROM "Notification" WHERE "id" = ANY($1)`, [['n-own-1', 'n-own-2', 'n-col-1', 'n-other-1']])
      const readAt = Object.fromEntries(rows.map(row => [row.id, row.readAt !== null]))
      expect(readAt).toEqual({ 'n-own-1': true, 'n-own-2': false, 'n-col-1': false, 'n-other-1': false })
    })

    it('相同去重键不会重复生成通知（同一企业同一收件人）', async () => {
      await expect(notice('n-dup', a.tenantId, owner.userId, 'k1')).rejects.toThrow()
    })

    it('没有登录：401', async () => {
      expect((await h.call(null, 'GET', '/notifications')).status).toBe(401)
    })
  })

  describe('待办：确认、版本冲突、关闭与隔离', () => {
    let itemId: string
    let version: number

    it('创建待办：负责人是自己，默认状态待处理，有处理时限', async () => {
      const res = await h.call(owner.token, 'POST', '/work-items', { body: { title: '核对广告预算', severity: 'WARNING', ownerId: colleague.userId } })
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
      itemId = res.json.data.id
      version = res.json.data.version
      const detail = await h.call(colleague.token, 'GET', `/work-items/${itemId}`)
      expect(detail.status, JSON.stringify(detail.json)).toBe(200)
      expect(detail.json.data).toMatchObject({ status: 'PENDING', source: 'MANUAL' })
      expect(detail.json.data.owner.id).toBe(colleague.userId)
      expect(detail.json.data.dueAt).toBeTruthy()
    })

    it('其他企业的人读取这条待办：按“不存在”处理', async () => {
      expect((await h.call(other.token, 'GET', `/work-items/${itemId}`)).status).toBe(404)
      const list = await h.call(other.token, 'GET', '/work-items?scope=all')
      expect(list.json.data.items).toEqual([])
    })

    it('没有处理权限、也不是负责人的成员不能确认', async () => {
      const res = await h.call(viewer.token, 'POST', `/work-items/${itemId}/ack`, { body: { version } })
      expect(res.status).toBe(403)
    })

    it('负责人确认：状态变为处理中，版本号加一；用旧版本再操作被拒绝，数据不变', async () => {
      const ack = await h.call(colleague.token, 'POST', `/work-items/${itemId}/ack`, { body: { version } })
      expect(ack.status, JSON.stringify(ack.json)).toBeLessThan(300)
      const stale = await h.call(colleague.token, 'POST', `/work-items/${itemId}/close`, { body: { conclusion: 'HANDLED', version } })
      expect(stale.status).toBe(409)
      const { rows } = await h.client.query<{ status: string; version: number }>(`SELECT "status", "version" FROM "WorkItem" WHERE "id" = $1`, [itemId])
      expect(rows[0]?.status).toBe('IN_PROGRESS')
      expect(rows[0]?.version).toBe(version + 1)
      version = rows[0]?.version ?? version
    })

    it('延期不能超过 90 天，也不能早于现在', async () => {
      const far = await h.call(colleague.token, 'POST', `/work-items/${itemId}/defer`, { body: { until: new Date(Date.now() + 120 * 86_400_000).toISOString(), reason: '等供应商回复', version } })
      expect(far.status).toBe(422)
      const past = await h.call(colleague.token, 'POST', `/work-items/${itemId}/defer`, { body: { until: new Date(Date.now() - 3_600_000).toISOString(), reason: '等供应商回复', version } })
      expect(past.status).toBe(422)
    })

    it('关闭必须带结论：关闭后进入“已完成”页签，不能再处理', async () => {
      const closed = await h.call(colleague.token, 'POST', `/work-items/${itemId}/close`, { body: { conclusion: 'FALSE_POSITIVE', note: '预算已调整', version } })
      expect(closed.status, JSON.stringify(closed.json)).toBeLessThan(300)
      const done = await h.call(colleague.token, 'GET', '/work-items?tab=DONE')
      expect(done.json.data.items.map((item: { id: string }) => item.id)).toContain(itemId)
      const again = await h.call(colleague.token, 'POST', `/work-items/${itemId}/ignore`, { body: { reason: '不再需要', version: version + 1 } })
      expect(again.status).toBe(409)
    })
  })

  describe('写入开关：默认全部关闭，开启受前置条件与再次验证约束', () => {
    it('没有任何开关记录时：全部关闭、模式为只读，汇总接口登录成员可读', async () => {
      const list = await h.call(owner.token, 'GET', '/settings/integrations')
      expect(list.status, JSON.stringify(list.json)).toBe(200)
      expect(list.json.data.mode).toBe('READ_ONLY')
      expect(list.json.data.enabledCount).toBe(0)
      expect(list.json.data.items.length).toBeGreaterThan(0)
      expect(list.json.data.items.every((item: { enabled: boolean }) => item.enabled === false)).toBe(true)
      const summary = await h.call(viewer.token, 'GET', '/settings/integrations/summary')
      expect(summary.json.data).toMatchObject({ mode: 'READ_ONLY', enabledCount: 0 })
    })

    it('没有再次验证身份、前置条件也不满足：开启被拒绝，数据库里没有开启的记录', async () => {
      const first = (await h.call(owner.token, 'GET', '/settings/integrations')).json.data.items[0] as { key: string }
      const res = await h.call(owner.token, 'POST', `/settings/integrations/${first.key}/enable`, { body: { reason: '测试开启', confirm: true } })
      expect(res.status).toBeGreaterThanOrEqual(400)
      const { rows } = await h.client.query<{ count: string }>(`SELECT count(*) FROM "IntegrationSwitch" WHERE "enabled" = true`)
      expect(Number(rows[0]?.count)).toBe(0)
    })

    it('没有写入权限的成员：不能开启', async () => {
      const first = (await h.call(owner.token, 'GET', '/settings/integrations')).json.data.items[0] as { key: string }
      expect((await h.call(colleague.token, 'POST', `/settings/integrations/${first.key}/enable`, { body: { reason: '测试开启', confirm: true } })).status).toBe(403)
    })
  })

  describe('导出：任务只属于发起人', () => {
    let exportId: string

    it('发起导出：生成排队中的任务并交给后台队列；列表只有本人的', async () => {
      const res = await h.call(owner.token, 'POST', '/exports', { body: { kind: 'orders', format: 'CSV', filters: {}, filterSummary: '不限日期' } })
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
      exportId = res.json.data.id
      expect(res.json.data.status).toBe('QUEUED')
      expect(h.queue.add.mock.calls.some(call => call[0] === 'exports')).toBe(true)
      const mine = await h.call(owner.token, 'GET', '/exports')
      expect(mine.json.data.items.map((item: { id: string }) => item.id)).toContain(exportId)
      expect((await h.call(other.token, 'GET', '/exports')).json.data.items).toEqual([])
    })

    it('别人读取、下载这条任务：404；自己在生成完成前下载：被拒绝并说明状态', async () => {
      expect((await h.call(other.token, 'GET', `/exports/${exportId}`)).status).toBe(404)
      expect((await h.call(other.token, 'GET', `/exports/${exportId}/download`)).status).toBe(404)
      const early = await h.call(owner.token, 'GET', `/exports/${exportId}/download`)
      expect(early.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(early.json)).not.toContain('http')
    })

    it('不支持的导出类型：参数错误，不生成任务', async () => {
      const before = (await h.client.query<{ count: string }>(`SELECT count(*) FROM "ExportJob"`)).rows[0]?.count
      const res = await h.call(owner.token, 'POST', '/exports', { body: { kind: 'secrets', format: 'CSV' } })
      expect(res.status).toBe(422)
      expect((await h.client.query<{ count: string }>(`SELECT count(*) FROM "ExportJob"`)).rows[0]?.count).toBe(before)
    })
  })

  describe('预警实例：同一问题只有一条未处理的', () => {
    it('同一规则、店铺、去重键下，未处理的实例只能有一条；处理掉之后可以再次出现', async () => {
      const rule = await insertRow(h.client, 'AlertRule', { id: 'rule-a-1', tenantId: a.tenantId, code: 'DATA_STALE' })
      const instance = (id: string) =>
        insertRow(h.client, 'AlertInstance', { id, tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, ruleId: rule.id, severity: 'WARNING', status: 'NEW', dedupKey: 'stale:orders' })
      await instance('ai-1')
      await expect(instance('ai-2')).rejects.toThrow(/duplicate key|AlertInstance_open_dedupe_key/)
      await h.client.query(`UPDATE "AlertInstance" SET "status" = 'HANDLED' WHERE "id" = 'ai-1'`)
      await expect(instance('ai-3')).resolves.toMatchObject({ id: 'ai-3' })
    })
  })

  describe('数据新鲜度与指标口径', () => {
    it('新鲜度按企业隔离：A 有订单同步记录，B 看不到', async () => {
      // 时间用 ISO 字符串：直接传 Date 时，驱动会按本机时区写入不带时区的列，造成偏移
      const now = new Date().toISOString()
      await insertRow(h.client, 'DataFreshness', {
        id: 'fr-a-orders',
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        sourceKey: 'orders.api',
        lastAttemptAt: now,
        lastSuccessAt: now,
        dataThrough: now,
        status: 'NORMAL',
      })
      const mineA = await h.call(owner.token, 'GET', '/freshness')
      expect(mineA.status, JSON.stringify(mineA.json)).toBe(200)
      const orders = mineA.json.data.sources.find((item: { sourceKey: string }) => item.sourceKey === 'orders.api')
      expect(orders).toMatchObject({ status: 'NORMAL', coverage: { total: 1, fresh: 1 } })
      const mineB = await h.call(other.token, 'GET', '/freshness')
      expect(mineB.json.data.sources.find((item: { sourceKey: string }) => item.sourceKey === 'orders.api')).toMatchObject({ status: 'NO_RECORD', lastSuccessAt: null })
    })

    it('覆盖时间落后太多：即使记录为正常也按“延迟”显示', async () => {
      const old = new Date(Date.now() - 6 * 3_600_000).toISOString()
      await h.client.query(`UPDATE "DataFreshness" SET "lastSuccessAt" = $1, "dataThrough" = $1 WHERE "id" = 'fr-a-orders'`, [old])
      const res = await h.call(owner.token, 'GET', '/freshness')
      expect(res.json.data.sources.find((item: { sourceKey: string }) => item.sourceKey === 'orders.api')).toMatchObject({ status: 'DELAYED' })
      expect(res.json.data.summary.attention).toBeGreaterThan(0)
    })

    it('指标口径：登录即可查看，共 217 条，可按关键字搜索', async () => {
      const all = await h.call(viewer.token, 'GET', '/metrics/definitions?pageSize=1')
      expect(all.status, JSON.stringify(all.json)).toBe(200)
      expect(all.json.data.total).toBe(217)
      const found = await h.call(viewer.token, 'GET', '/metrics/definitions?q=M-001')
      expect(found.json.data.items.length).toBeGreaterThan(0)
      expect(found.json.data.items.every((item: { history: unknown[] }) => Array.isArray(item.history))).toBe(true)
    })
  })
})
