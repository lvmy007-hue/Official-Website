import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 账户健康（P5-02，真实数据库 + worker 的报告导入器与预警评估器）：
// 表约束、报告导入（快照按日覆盖、问题新增、不再出现的问题标记已解决、再次出现重开、人工字段不被覆盖）、总览与问题列表与详情、
// 处理问题（权限、乐观锁、负责人校验、时间线、审计、通知）、关联支持案件、两条预警、数据范围与跨企业隔离。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const DAY = 86_400_000
const NOW = new Date()
const dayOf = (offset: number) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()) + offset * DAY)
const TODAY = dayOf(0).toISOString().slice(0, 10)
const YESTERDAY = dayOf(-1).toISOString().slice(0, 10)
const US = 'ATVPDKIKX0DER'
const ISSUE_ID = 'VIO-2026-100'

const reportOne = {
  accountStatuses: [{ marketplaceId: US, status: 'GOOD' }],
  accountHealthRating: { ahrScore: 280, ahrStatus: 'FAIR' },
  performanceMetrics: [
    {
      marketplaceId: US,
      orderDefectRate: { afn: { rate: 0.004, targetValue: 0.01, targetCondition: 'LESS_THAN', reportingPeriod: '60 days' } },
      listingPolicyViolations: [
        { id: ISSUE_ID, title: 'Restricted products', affectedAsins: ['B000000001'], impact: '搜索结果被隐藏', date: `${YESTERDAY}T00:00:00Z` },
        { title: 'Intellectual property complaint', asin: 'B000000003' },
      ],
    },
  ],
}
const reportTwo = {
  accountStatuses: [{ marketplaceId: US, status: 'AT_RISK' }],
  accountHealthRating: { ahrScore: 312, ahrStatus: 'GOOD' },
  performanceMetrics: [
    {
      marketplaceId: US,
      orderDefectRate: { afn: { rate: 0.012, targetValue: 0.01, targetCondition: 'LESS_THAN', reportingPeriod: '60 days' } },
      lateShipmentRate: { rate: 0.03 },
      listingPolicyViolations: [{ id: ISSUE_ID, title: 'Restricted products', affectedAsins: ['B000000001', 'B000000002'] }],
    },
  ],
}

describe('账户健康（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let store2: string
  let otherTenantId: string
  let otherStore: string
  let reader: Member
  let handler: Member
  let handlerOnly: Member
  let teammate: Member
  let store2Only: Member
  let outsider: Member
  let issueRowId = ''
  let importReport: (report: unknown, date: string, store?: string) => Promise<Json>
  // 不能 import type 到 worker 源文件（会让 API 的 tsc 越出 rootDir），所以只写这里用到的最小形状
  type Evaluator = { evaluate: (ctx: never) => Promise<{ entityType: string; entityId: string; evidence: Json }[]> }
  let evaluators: { statusChangedEvaluator: Evaluator; healthDeclineEvaluator: Evaluator }

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(expected)
    return res.json?.data as Json
  }
  const patch = (member: Member, id: string, body: unknown) => h.call(member.token, 'PATCH', `/account-health/issues/${id}`, { body })
  const rule = (type: string, params: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'X',
    domain: 'SYSTEM',
    name: 'x',
    severity: 'WARNING',
    cooldownMinutes: 1440,
    currentVersion: 1,
    condition: { type, params },
    scope: {},
  })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'account_health' })
    const a = await h.createTenant('ah-a')
    const b = await h.createTenant('ah-b')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    otherTenantId = b.tenantId
    otherStore = b.sellerAccountId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-ah-a2', sellerId: 'SELLER-AH-2', tenantId, legalEntityId: a.legalEntityId, displayName: '欧洲店' })).id
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('account_health', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const importer = await import(/* @vite-ignore */ String('../../../worker/src/importers/account-health/seller-performance'))
    evaluators = await import(/* @vite-ignore */ String('../../../worker/src/alerts/account-evaluators'))
    importReport = (report, date, store = storeId) =>
      runWithTenant(tenantId, async () => {
        async function* rowsOf() {
          yield report
        }
        return importer.sellerPerformanceImporter({ tenantId, sellerAccountId: store, marketplaceId: US }, { reportJobId: null, snapshotDate: new Date(`${date}T00:00:00Z`) })(
          { prisma: tenantDb, logger },
          rowsOf(),
        )
      })
    reader = await h.createMember(tenantId, 'reader', ['account.health.read'])
    handler = await h.createMember(tenantId, 'handler', ['account.health.read', 'alerts.handle', 'support.read'])
    handlerOnly = await h.createMember(tenantId, 'handler-only', ['alerts.handle'])
    teammate = await h.createMember(tenantId, 'teammate', ['account.health.read'])
    store2Only = await h.createMember(tenantId, 'store2', ['account.health.read', 'alerts.handle'], { scopes: [{ sellerAccountId: store2 }] })
    outsider = await h.createMember(otherTenantId, 'outsider', ['account.health.read', 'alerts.handle'])
  }, 180_000)
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('表约束：快照与问题的取值受 CHECK 限制，（店铺、日期、指标）与（店铺、问题编号）唯一，已解决必须有解决时间', async () => {
    const snap = (over: Record<string, unknown>) =>
      insertRow(h.client, 'AccountHealthSnapshot', { tenantId, sellerAccountId: store2, snapshotDate: YESTERDAY, metricKey: 'k1', metricGroup: 'OTHER', ...over })
    await snap({ id: 'ahs-1' })
    await expect(snap({ id: 'ahs-2' })).rejects.toMatchObject({ code: '23505' })
    await expect(snap({ id: 'ahs-3', metricKey: 'k2', metricGroup: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await expect(snap({ id: 'ahs-4', metricKey: 'k3', status: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await expect(snap({ id: 'ahs-5', metricKey: 'k4', accountStatus: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await expect(snap({ id: 'ahs-6', metricKey: 'k5', windowDays: 0 })).rejects.toMatchObject({ code: '23514' })
    const issue = (over: Record<string, unknown>) =>
      insertRow(h.client, 'PolicyIssue', { tenantId, sellerAccountId: store2, kind: 'OTHER', title: 't', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), ...over })
    await issue({ id: 'pi-1', issueId: 'X-1' })
    await expect(issue({ id: 'pi-2', issueId: 'X-1' })).rejects.toMatchObject({ code: '23505' })
    await expect(issue({ id: 'pi-3', issueId: 'X-2', status: 'RESOLVED' })).rejects.toMatchObject({ code: '23514' })
    await expect(issue({ id: 'pi-4', issueId: 'X-3', handlingStatus: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await expect(issue({ id: 'pi-5', issueId: 'X-4', version: 0 })).rejects.toMatchObject({ code: '23514' })
    await h.client.query(`DELETE FROM "PolicyIssue" WHERE id = 'pi-1'`)
    await h.client.query(`DELETE FROM "AccountHealthSnapshot" WHERE id = 'ahs-1'`)
  })

  it('导入两天的报告：快照按日覆盖；问题新增；第二天不再出现的问题标记已解决，仍在的问题只刷新、不动编号', async () => {
    expect(await importReport(reportOne, YESTERDAY)).toMatchObject({ read: 1, imported: 1 })
    expect(await rows(`SELECT "issueId", status FROM "PolicyIssue" WHERE "tenantId" = $1 ORDER BY "issueId"`, [tenantId])).toHaveLength(2)
    expect(await importReport(reportTwo, TODAY)).toMatchObject({ imported: 1 })
    await importReport(reportTwo, TODAY) // 重复导入同一天：覆盖，不新增
    expect(Number((await rows(`SELECT count(*) AS n FROM "AccountHealthSnapshot" WHERE "tenantId" = $1 AND "snapshotDate" = $2`, [tenantId, TODAY]))[0].n)).toBe(4)
    const issues = await rows(`SELECT "issueId", status, version, "resolvedAt", "affectedAsinsJson" FROM "PolicyIssue" WHERE "tenantId" = $1 ORDER BY "issueId"`, [tenantId])
    const open = issues.find(item => item.issueId === ISSUE_ID)
    const gone = issues.find(item => item.issueId !== ISSUE_ID)
    expect(open).toMatchObject({ status: 'OPEN', version: 1, affectedAsinsJson: ['B000000001', 'B000000002'] })
    expect(gone).toMatchObject({ status: 'RESOLVED', version: 2 })
    expect(gone.resolvedAt).not.toBeNull()
    const metric = (
      await rows(
        `SELECT status, value::float8 AS value, unit, "windowDays", "metricGroup" FROM "AccountHealthSnapshot" WHERE "tenantId" = $1 AND "snapshotDate" = $2 AND "metricKey" = 'orderDefectRate.afn'`,
        [tenantId, TODAY],
      )
    )[0]
    expect(metric).toMatchObject({ status: 'NOT_MET', value: 0.012, unit: 'RATIO', windowDays: 60, metricGroup: 'ORDER_DEFECT' })
    issueRowId = (await rows(`SELECT id FROM "PolicyIssue" WHERE "tenantId" = $1 AND "issueId" = $2`, [tenantId, ISSUE_ID]))[0].id
  })

  it('总览：账户状态变化、评级与趋势、订单缺陷率（未达标）、政策问题数；没数据的店铺说明原因，不显示 0；推送未接入', async () => {
    const data = await get(reader, '/account-health')
    expect(data.stores.map((item: Json) => item.sellerAccountId).sort()).toEqual([storeId, store2].sort())
    const main = data.stores.find((item: Json) => item.sellerAccountId === storeId)
    expect(main).toMatchObject({ state: 'OK', snapshotDate: TODAY })
    expect(main.accountStatus).toMatchObject({ status: 'AT_RISK', label: '有风险', previousStatus: 'NORMAL', changedAt: TODAY, source: 'REPORT' })
    expect(main.statusHistory.map((item: Json) => item.status)).toEqual(['NORMAL', 'AT_RISK'])
    expect(main.rating).toMatchObject({ score: 312, status: 'GOOD' })
    expect(main.ratingTrend.map((item: Json) => item.value)).toEqual([280, 312])
    expect(main.orderDefect.metrics[0]).toMatchObject({ key: 'orderDefectRate.afn', status: 'NOT_MET', targetText: '低于 1%', value: 0.012 })
    expect(main.orderDefect.trend[0].points.map((item: Json) => item.value)).toEqual([0.004, 0.012])
    expect(main.orderDefect.breakdown.every((item: Json) => item.metric === null && item.note === '报告未分项给出')).toBe(true)
    expect(main.policy.openCount).toBe(1)
    expect(main.other.map((item: Json) => item.key)).toEqual(['lateShipmentRate'])
    const empty = data.stores.find((item: Json) => item.sellerAccountId === store2)
    expect(empty).toMatchObject({ state: 'NOT_CONNECTED', accountStatus: { status: null }, rating: null })
    expect(data.push.state).toBe('NOT_CONNECTED')
  })

  it('数据范围与隔离：只授权欧洲店的成员只看到欧洲店；别的企业看不到本企业的数据；没有权限 403', async () => {
    const narrow = await get(store2Only, '/account-health')
    expect(narrow.stores.map((item: Json) => item.sellerAccountId)).toEqual([store2])
    expect((await get(store2Only, '/account-health/issues')).items).toEqual([])
    await get(store2Only, `/account-health/issues/${issueRowId}`, 404)
    expect((await patch(store2Only, issueRowId, { version: 1, handlingStatus: 'DONE' })).status).toBe(404)
    const other = await get(outsider, '/account-health')
    expect(other.stores.map((item: Json) => item.sellerAccountId)).toEqual([otherStore])
    expect(other.stores[0].state).toBe('NOT_CONNECTED')
    expect((await get(outsider, '/account-health/issues')).items).toEqual([])
    await get(outsider, `/account-health/issues/${issueRowId}`, 404)
    expect(await runWithTenant(otherTenantId, () => tenantDb.policyIssue.count())).toBe(0)
    expect(await runWithTenant(otherTenantId, () => tenantDb.accountHealthSnapshot.count())).toBe(0)
    expect((await h.call(handlerOnly.token, 'GET', '/account-health')).status).toBe(403)
    expect((await h.call(null, 'GET', '/account-health')).status).toBe(401)
  })

  it('问题列表：默认全部（新的在前），按状态、类型、处理状态筛选；翻页游标绑定条件', async () => {
    const all = await get(reader, '/account-health/issues')
    expect(all.items).toHaveLength(2)
    const openOnly = await get(reader, '/account-health/issues?status=OPEN')
    expect(openOnly.items.map((item: Json) => item.issueId)).toEqual([ISSUE_ID])
    expect(openOnly.items[0]).toMatchObject({ kind: 'LISTING_POLICY', statusLabel: '未解决', handlingStatus: 'OPEN', asins: ['B000000001', 'B000000002'], owner: null })
    expect((await get(reader, '/account-health/issues?status=RESOLVED')).items).toHaveLength(1)
    expect((await get(reader, '/account-health/issues?kind=IP_COMPLAINT')).items).toHaveLength(0)
    const page = await get(reader, '/account-health/issues?pageSize=1')
    expect(page.items).toHaveLength(1)
    expect(page.pageInfo.hasMore).toBe(true)
    const next = await h.call(reader.token, 'GET', `/account-health/issues?pageSize=1&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)
    expect(next.status).toBe(200)
    expect(next.json.data.items[0].id).not.toBe(page.items[0].id)
    expect((await h.call(reader.token, 'GET', `/account-health/issues?pageSize=1&status=OPEN&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)).status).toBe(400)
  })

  it('处理问题：只读成员 403；乐观锁；负责人必须是在职成员；写时间线、审计、通知；什么都没改不加版本号', async () => {
    expect((await patch(reader, issueRowId, { version: 1, handlingStatus: 'DONE' })).status).toBe(403)
    expect((await patch(handlerOnly, issueRowId, { version: 1, handlingStatus: 'DONE' })).status).toBe(403)
    expect((await patch(handler, issueRowId, { version: 1, ownerUserId: outsider.userId })).status).toBe(422)

    const res = await patch(handler, issueRowId, { version: 1, ownerUserId: teammate.userId, handlingStatus: 'IN_PROGRESS', handlingNote: '已联系品牌方', amazonCaseId: 'CASE-778' })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ version: 2, handlingStatus: 'IN_PROGRESS', handlingStatusLabel: '处理中', amazonCaseId: 'CASE-778', owner: { id: teammate.userId } })
    expect((await patch(handler, issueRowId, { version: 1, handlingStatus: 'DONE' })).status).toBe(409)
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'POLICY_ISSUE_UPDATED' AND "tenantId" = $1`, [tenantId])).length).toBeGreaterThanOrEqual(1)
    const events = await rows(`SELECT title, "actorId" FROM "EntityEvent" WHERE "tenantId" = $1 AND "entityType" = 'POLICY_ISSUE' AND "entityId" = $2`, [tenantId, issueRowId])
    expect(events).toHaveLength(1)
    expect(events[0].title).toContain('处理状态：待处理 → 处理中')
    expect(events[0].actorId).toBe(handler.userId)
    const notices = await rows(`SELECT "userId", link FROM "Notification" WHERE "tenantId" = $1 AND kind = 'WORK_ASSIGNED'`, [tenantId])
    expect(notices).toEqual([{ userId: teammate.userId, link: `/app/account-health?issue=${issueRowId}` }])

    const same = await patch(handler, issueRowId, { version: 2, handlingStatus: 'IN_PROGRESS' })
    expect(same.status).toBe(200)
    expect(same.json.data.version).toBe(2)
    expect((await rows(`SELECT 1 FROM "EntityEvent" WHERE "entityId" = $1`, [issueRowId])).length).toBe(1)
    // 清空负责人与案件编号
    const cleared = await patch(handler, issueRowId, { version: 2, ownerUserId: null, amazonCaseId: null })
    expect(cleared.json.data).toMatchObject({ version: 3, owner: null, amazonCaseId: null })
  })

  it('详情：问题、时间线、可指定的负责人、关联支持案件（案件编号手填或标题含问题编号）', async () => {
    const detail = await get(handler, `/account-health/issues/${issueRowId}`)
    expect(detail.issue).toMatchObject({ issueId: ISSUE_ID, handlingNote: '已联系品牌方', version: 3 })
    expect(detail.timeline.length).toBeGreaterThanOrEqual(1)
    expect(detail.owners.map((item: Json) => item.id)).toEqual(expect.arrayContaining([handler.userId, teammate.userId]))
    expect(detail.owners.some((item: Json) => item.id === outsider.userId)).toBe(false)
    expect(detail.support.state).not.toBe('OK')
    await insertRow(h.client, 'SupportCase', {
      id: 'sc-1',
      tenantId,
      sellerAccountId: storeId,
      caseId: '9001',
      subject: `Appeal for ${ISSUE_ID} listing removal`,
      status: 'OPEN',
      amazonCreatedAt: NOW.toISOString(),
      amazonUpdatedAt: NOW.toISOString(),
    })
    const linked = await get(handler, `/account-health/issues/${issueRowId}`)
    expect(linked.support).toMatchObject({ state: 'OK' })
    expect(linked.support.cases[0]).toMatchObject({ caseId: '9001', via: 'SUBJECT' })
    const noSupport = await get(reader, `/account-health/issues/${issueRowId}`)
    expect(noSupport.support).toMatchObject({ state: 'RESTRICTED', cases: [] })
  })

  it('再次出现的已解决问题：重开、回到待处理、版本加一；仍未解决的问题保留人工处理信息', async () => {
    const goneId = (await rows(`SELECT id FROM "PolicyIssue" WHERE "tenantId" = $1 AND "issueId" <> $2`, [tenantId, ISSUE_ID]))[0].id
    await importReport(reportOne, TODAY)
    const reopened = (await rows(`SELECT status, "handlingStatus", version, "resolvedAt" FROM "PolicyIssue" WHERE id = $1`, [goneId]))[0]
    expect(reopened).toMatchObject({ status: 'OPEN', handlingStatus: 'OPEN', version: 3, resolvedAt: null })
    const kept = (await rows(`SELECT "handlingStatus", "handlingNote" FROM "PolicyIssue" WHERE id = $1`, [issueRowId]))[0]
    expect(kept).toMatchObject({ handlingStatus: 'IN_PROGRESS', handlingNote: '已联系品牌方' })
  })

  it('两条预警（真实库查询）：账户状态变化、指标未达标；别的企业不命中', async () => {
    await importReport(reportTwo, TODAY) // 回到“今天有风险、订单缺陷率未达标”
    const now = new Date()
    const status = await runWithTenant(tenantId, () => evaluators.statusChangedEvaluator.evaluate({ db: tenantDb, tenantId, rule: rule('account.status-changed'), now } as never))
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ entityType: 'STORE', entityId: storeId })
    expect(status[0].evidence).toMatchObject({ from: 'NORMAL', to: 'AT_RISK', changedOn: TODAY })
    const decline = await runWithTenant(tenantId, () => evaluators.healthDeclineEvaluator.evaluate({ db: tenantDb, tenantId, rule: rule('account.health-decline'), now } as never))
    expect(decline).toHaveLength(1)
    expect(decline[0].evidence.metrics[0]).toMatchObject({ key: 'orderDefectRate.afn', valueText: '1.2%', targetText: '低于 1%' })
    const none = await runWithTenant(otherTenantId, () => evaluators.statusChangedEvaluator.evaluate({ db: tenantDb, tenantId: otherTenantId, rule: rule('account.status-changed'), now } as never))
    expect(none).toEqual([])
  })
})
