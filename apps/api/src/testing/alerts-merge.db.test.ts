import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 预警合并与已读联动（P6-15，真实数据库 + 完整应用 + worker 的评估框架）：
// 冷却期内重复命中并入上一条且不重复通知、不动已读；冷却期外并入后清掉已读并提醒一次（未读数回升）；
// 处理之后冷却期内不新建、冷却期外新建一条（没有已读）；列表显示累计触发次数。

type Member = { userId: string; token: string }
type Hit = { entityType: string; entityId: string; sellerAccountId?: string; evidence: Record<string, unknown>; title: string }
type Evaluate = (deps: { db: unknown; registry: unknown; now: () => Date }, tenantId: string) => Promise<{ created: number; refreshed: number; skippedCooldown: number; errors: number }>
const MINUTE = 60_000

describe('预警合并（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let owner: Member
  let evaluateTenantRules: Evaluate
  let Registry: new () => { register(evaluator: unknown): unknown }
  const start = new Date()
  const hits: Hit[] = []

  const at = (minutes: number) => new Date(start.getTime() + minutes * MINUTE)
  const runAt = (minutes: number) => {
    const registry = new Registry().register({ type: 'test.hits', evaluate: async () => hits })
    return runWithTenant(tenantId, () => evaluateTenantRules({ db: tenantDb, registry, now: () => at(minutes) }, tenantId))
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const alerts = () =>
    rows<{ id: string; status: string; triggerCount: number }>(`SELECT "id", "status", "triggerCount" FROM "AlertInstance" WHERE "tenantId" = $1 ORDER BY "firstTriggeredAt", "id"`, [tenantId])
  const mergeNotices = () => rows<{ body: string; userId: string }>(`SELECT "body", "userId" FROM "Notification" WHERE "tenantId" = $1 AND "dedupKey" LIKE 'alert-rule-merge:%'`, [tenantId])
  const unread = async () => (await h.call(owner.token, 'GET', '/notifications/unread-count')).json.data.alerts as number
  const readAll = async () => {
    const list = (await h.call(owner.token, 'GET', '/alerts')).json.data
    await h.call(owner.token, 'POST', '/alerts/read', { body: { ids: list.items.map((item: { id: string }) => item.id) } })
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'alert_merge' })
    const a = await h.createTenant('alm-a')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    owner = await h.createMember(tenantId, 'alm-owner', ['*'])
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('alert_merge', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const worker = (path: string) => import(/* @vite-ignore */ String(`../../../worker/src/${path}`))
    evaluateTenantRules = (await worker('platform/alert-evaluate')).evaluateTenantRules
    Registry = (await worker('platform/alert-evaluate')).AlertEvaluatorRegistry
    await insertRow(h.client, 'AlertRule', {
      id: 'rule-merge',
      tenantId,
      code: 'ADS_CPC_SURGE',
      domain: 'ADS',
      name: '单次点击成本突增',
      conditionJson: JSON.stringify({ type: 'test.hits', params: {} }),
      severity: 'WARNING',
      cooldownMinutes: 60,
      scopeJson: '{}',
      currentVersion: 1,
      version: 1,
    })
    hits.push({ entityType: 'AD_CAMPAIGN', entityId: 'camp-1', sellerAccountId: storeId, evidence: { cpc: 2 }, title: '活动 camp-1 点击成本突增' })
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('首次命中：建预警、待办并通知；对负责人是未读', async () => {
    expect(await runAt(0)).toMatchObject({ created: 1, refreshed: 0, errors: 0 })
    expect(await alerts()).toEqual([expect.objectContaining({ status: 'NEW', triggerCount: 1 })])
    expect((await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1 AND "source" = 'ALERT'`, [tenantId])).length).toBe(1)
    expect(await unread()).toBe(1)
  })

  it('冷却期内重复命中：并入上一条（次数加一），不重复建待办与通知；已读保持', async () => {
    await readAll()
    expect(await unread()).toBe(0)
    expect(await runAt(10)).toMatchObject({ created: 0, refreshed: 1, errors: 0 })
    expect(await alerts()).toEqual([expect.objectContaining({ triggerCount: 2 })])
    expect((await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [tenantId])).length).toBe(1)
    expect(await mergeNotices()).toHaveLength(0)
    expect(await unread()).toBe(0)
    const item = (await h.call(owner.token, 'GET', '/alerts')).json.data.items[0]
    expect(item).toMatchObject({ triggerCount: 2, read: true })
  })

  it('冷却期外再次命中、上一条仍没处理：并入并清掉已读，未读数回升，负责人收到一次“再次触发”提醒', async () => {
    expect(await runAt(180)).toMatchObject({ created: 0, refreshed: 1, errors: 0 })
    expect(await alerts()).toEqual([expect.objectContaining({ triggerCount: 3, status: 'NEW' })])
    expect(await unread()).toBe(1)
    const notices = await mergeNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]?.body).toContain('累计 3 次')
    expect(notices[0]?.userId).toBe(owner.userId)
    const item = (await h.call(owner.token, 'GET', '/alerts')).json.data.items[0]
    expect(item).toMatchObject({ triggerCount: 3, read: false })
    // 同一时刻再评估一次：回到冷却期之内，不再重复提醒
    await runAt(185)
    expect(await mergeNotices()).toHaveLength(1)
  })

  it('处理之后：冷却期内再次命中不新建；冷却期外新建一条（对任何人都是未读，旧的记录不动）', async () => {
    await readAll()
    const first = (await alerts())[0]!
    const closed = await h.call(owner.token, 'POST', `/alerts/${first.id}/close`, { body: { conclusion: 'HANDLED' } })
    expect(closed.status).toBe(200)
    expect(await unread()).toBe(0)
    await h.client.query(`UPDATE "AlertInstance" SET "lastTriggeredAt" = $2 WHERE "id" = $1`, [first.id, at(190).toISOString()])
    expect(await runAt(200)).toMatchObject({ created: 0, skippedCooldown: 1, errors: 0 })
    expect(await alerts()).toHaveLength(1)
    expect(await runAt(400)).toMatchObject({ created: 1, skippedCooldown: 0, errors: 0 })
    const all = await alerts()
    expect(all).toHaveLength(2)
    expect(all.find(row => row.id === first.id)).toMatchObject({ status: 'HANDLED', triggerCount: 4 })
    expect(all.find(row => row.id !== first.id)).toMatchObject({ status: 'NEW', triggerCount: 1 })
    expect(await unread()).toBe(1)
  })
})
