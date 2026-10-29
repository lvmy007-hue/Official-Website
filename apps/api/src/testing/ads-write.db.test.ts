import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告写入（P3-17，真实数据库 + 完整应用 + worker 的回写与变更扫描代码）：提交的范围与企业隔离、开关与连接、整批全有或全无、
// 写入记录与同步任务同一事务、回写（本地对象、变更记录、操作事件）只做一次、本系统自己的写入不被识别成外部变更、失败处置、约束与回滚。

type Member = { userId: string; token: string }
type Scan = { changes: number; own: number; errors: string[] }

const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261118010000_ads_write')
const WRITE_PERMISSIONS = ['ads.read', 'ads.campaign.write', 'ads.budget.write', 'ads.bid.write', 'ads.placement.write', 'ads.negative.write', 'ads.keyword.write']
const SWITCHES = ['sw.ads.status', 'sw.ads.budget', 'sw.ads.bid', 'sw.ads.placement', 'sw.ads.negative', 'sw.ads.keyword']

describe('广告写入（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let scopedA: Member
  let readOnly: Member
  let other: Member
  // worker 的模块在运行时动态加载（api 的编译范围不含 worker），这里只写用到的函数形状
  let workflow: { createAdsWriteWorkflow: (deps: unknown) => { steps: Array<{ run: (ctx: unknown) => Promise<unknown> }> } }
  let dispatch: { markAdsWriteFailed: (db: unknown, tenantId: string, payload: unknown, code: string) => Promise<void> }
  let scan: (db: unknown, tenantId: string, now?: Date) => Promise<Scan>

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const count = async (table: string, where = 'TRUE', params: unknown[] = []) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, params))[0]!.n
  const patch = (member: Member, path: string, body: unknown) => h.call(member.token, 'PATCH', path, { body })
  const budget = (entityId: string, amount: number) => ({ ops: [{ kind: 'CAMPAIGN_BUDGET', entityId, amount }] })
  const resetSwitches = async (enabled: boolean) => {
    await h.client.query(`UPDATE "IntegrationSwitch" SET enabled = $1 WHERE "tenantId" = $2`, [enabled, tenantId])
  }
  const runStep = async (runId: string, step: number) => {
    const definition = workflow.createAdsWriteWorkflow({ prisma: tenantDb, guardFor: (() => undefined) as never, secrets: {} as never })
    const ctx = { tenantId, intent: { tenantId, connectionId: 'conn-a', adsWriteRunId: runId }, request: {}, responseOf: () => ({}) }
    return runWithTenant(tenantId, () => definition.steps[step]!.run(ctx as never))
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_write' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    const profiles: Array<[string, string, string, string | null, string]> = [
      ['ap-a', 'P-A', storeA, 'ACC-ap-a', tenantId],
      ['ap-b', 'P-B', storeB, 'ACC-ap-b', tenantId],
      ['ap-n', 'P-N', storeA, null, tenantId],
      ['ap-o', 'P-O', b.sellerAccountId, 'ACC-ap-o', otherTenantId],
    ]
    for (const [id, profileId, store, accountId, tenant] of profiles) {
      await insertRow(h.client, 'AdsProfile', { id, tenantId: tenant, profileId, sellerAccountId: store, bindingStatus: 'MANUAL', ...(accountId ? { adsAccountId: accountId } : {}) })
      await insertRow(h.client, 'AdsAccount', { id: `acct-${id}`, tenantId: tenant, adsProfileId: id, adsAccountId: accountId ?? `ACC-${id}`, name: id })
    }
    const campaign = (id: string, profile: string, name: string, extra: Record<string, unknown> = {}, tenant = tenantId) =>
      insertRow(h.client, 'AdsCampaign', {
        id,
        tenantId: tenant,
        adsProfileId: profile,
        adsAccountId: `ACC-${profile}`,
        externalCampaignId: `x-${id}`,
        adProduct: 'SPONSORED_PRODUCTS',
        name,
        state: 'ENABLED',
        budget: 20,
        bidStrategy: 'SALES_DOWN_ONLY',
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
        ...extra,
      })
    await campaign('cam-1', 'ap-a', 'Camp One')
    await campaign('cam-2', 'ap-a', 'Camp Two', { budget: 10 })
    await campaign('cam-b', 'ap-b', 'Camp B')
    await campaign('cam-n', 'ap-n', 'Camp N')
    await campaign('cam-o', 'ap-o', 'Camp O', {}, otherTenantId)
    const common = { tenantId, adsProfileId: 'ap-a', adsAccountId: 'ACC-ap-a', sourceUpdatedAt: '2026-10-01T00:00:00Z' }
    await insertRow(h.client, 'AdsAdGroup', { id: 'ag-1', ...common, adGroupId: 'AG1', campaignId: 'x-cam-1', name: 'Core', state: 'ENABLED', defaultBid: 0.8 })
    await insertRow(h.client, 'AdsTarget', { id: 'tg-1', ...common, targetId: 'T1', adGroupId: 'AG1', kind: 'PRODUCT', expression: 'asin="B0XYZ"', bid: 0.9, state: 'ENABLED' })
    await insertRow(h.client, 'AdsKeyword', { id: 'kw-1', ...common, keywordId: 'K1', campaignId: 'x-cam-1', adGroupId: 'AG1', text: 'yoga mat', matchType: 'EXACT', bid: 1.5, state: 'ENABLED' })
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    for (const key of SWITCHES) await insertRow(h.client, 'IntegrationSwitch', { id: `sw-${key}`, tenantId, switchKey: key, enabled: true })

    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_write', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    workflow = await import(/* @vite-ignore */ String('../../../worker/src/runtime/ads-write-workflow'))
    dispatch = await import(/* @vite-ignore */ String('../../../worker/src/connectors/ads-write-dispatch'))
    scan = (await import(/* @vite-ignore */ String('../../../worker/src/ads-changes/run'))).scanTenantChanges as typeof scan

    admin = await h.createMember(tenantId, 'admin', WRITE_PERMISSIONS)
    scopedA = await h.createMember(tenantId, 'scopeda', WRITE_PERMISSIONS, { scopes: [{ sellerAccountId: storeA }] })
    readOnly = await h.createMember(tenantId, 'readonly', ['ads.read'])
    other = await h.createMember(otherTenantId, 'other', WRITE_PERMISSIONS)
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('提交：写入记录与同步任务同一事务，响应是排队状态；入队载荷带写入记录编号；写审计', async () => {
    const res = await patch(admin, '/ads/campaigns', budget('cam-1', 35))
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'QUEUED', runs: [{ kind: 'CAMPAIGN_BUDGET', status: 'PENDING', before: '20', after: '35', entityLabel: 'Camp One' }] })
    const runId = res.json.data.runs[0].id as string
    const [run] = await rows<Record<string, any>>(`SELECT * FROM "AdsWriteRun" WHERE id = $1`, [runId])
    expect(run).toMatchObject({ tenantId, adsProfileId: 'ap-a', source: 'MANUAL', entityId: 'cam-1', externalId: 'x-cam-1', status: 'PENDING', requestedBy: admin.userId, finishedAt: null })
    expect(run.requestJson).toMatchObject({ amount: 35 })
    const [job] = await rows<Record<string, any>>(`SELECT * FROM "SyncJob" WHERE id = $1`, [run.syncJobId])
    expect(job).toMatchObject({ type: 'ADS_WRITE', domain: 'ads', connectionId: 'conn-a', status: 'PENDING' })
    expect(job.context).toMatchObject({ adsWriteRunId: runId })
    expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ adsWriteRunId: runId, syncJobId: job.id }), job.id, expect.objectContaining({ type: 'ADS_WRITE' }))
    expect(await count('AuditEvent', `action = 'ADS_WRITE_SUBMITTED' AND "tenantId" = $1`, [tenantId])).toBe(1)
  })

  it('权限：只读成员 403 且没有任何写入；范围外的对象与别的企业的对象都是 404，不泄露存在', async () => {
    const before = await count('AdsWriteRun')
    expect((await patch(readOnly, '/ads/campaigns', budget('cam-1', 40))).status).toBe(403)
    expect((await patch(scopedA, '/ads/campaigns', budget('cam-b', 40))).status).toBe(404)
    expect((await patch(other, '/ads/campaigns', budget('cam-1', 40))).status).toBe(404)
    expect((await patch(admin, '/ads/campaigns', budget('cam-o', 40))).status).toBe(404)
    expect(await count('AdsWriteRun')).toBe(before)
    expect((await patch(scopedA, '/ads/campaigns', budget('cam-2', 12))).status).toBe(200)
  })

  it('整批全有或全无：一项对象不存在，前面合法的项也不写入；批内重复对象各自成记录', async () => {
    const before = await count('AdsWriteRun')
    const bad = await patch(admin, '/ads/campaigns', { ops: [budget('cam-1', 50).ops[0], budget('missing', 5).ops[0]] })
    expect(bad.status).toBe(404)
    expect(await count('AdsWriteRun')).toBe(before)
    expect(await count('SyncJob', `type = 'ADS_WRITE'`)).toBe(before)
  })

  it('开关与连接：动作开关关闭 409；授权失效 409；与当前值相同 422；档案没有广告账户编号 409；都不写入', async () => {
    const before = await count('AdsWriteRun')
    await resetSwitches(false)
    const off = await patch(admin, '/ads/campaigns', budget('cam-1', 60))
    expect(off.status).toBe(409)
    expect(off.json.error.code).toBe('WRITE_SWITCH_OFF')
    await resetSwitches(true)
    await h.client.query(`UPDATE "PlatformConnection" SET state = 'REVOKED' WHERE id = 'conn-a'`)
    expect((await patch(admin, '/ads/campaigns', budget('cam-1', 60))).status).toBe(409)
    await h.client.query(`UPDATE "PlatformConnection" SET state = 'AUTHORIZED' WHERE id = 'conn-a'`)
    expect((await patch(admin, '/ads/campaigns', budget('cam-b', 20))).status).toBe(422)
    const noAccount = await patch(admin, '/ads/campaigns', budget('cam-n', 60))
    expect(noAccount.status).toBe(409)
    expect(noAccount.json.error.code).toBe('ADS_ACCOUNT_MISSING')
    expect(await count('AdsWriteRun')).toBe(before)
  })

  it('预览：不写任何记录；范围外与不存在的对象同样显示“不存在”；开关关闭时 canSubmit 为 false', async () => {
    const before = [await count('AdsWriteRun'), await count('SyncJob'), await count('AuditEvent')]
    const ok = (await h.call(admin.token, 'POST', '/ads/preview', { body: budget('cam-1', 80) })).json.data
    expect(ok).toMatchObject({ permitted: true, canSubmit: true })
    expect(ok.items[0]).toMatchObject({ before: '20', after: '80', changePercent: 300, blocker: null })
    const scoped = (await h.call(scopedA.token, 'POST', '/ads/preview', { body: budget('cam-b', 80) })).json.data
    expect(scoped.items[0].blocker).toContain('不存在')
    await resetSwitches(false)
    const off = (await h.call(admin.token, 'POST', '/ads/preview', { body: budget('cam-1', 80) })).json.data
    await resetSwitches(true)
    expect(off.canSubmit).toBe(false)
    expect([await count('AdsWriteRun'), await count('SyncJob'), await count('AuditEvent')]).toEqual(before)
  })

  it('状态与记录：范围收窄的成员只看到自己范围内的记录；别的企业看不到', async () => {
    const all = (await h.call(admin.token, 'GET', '/ads/writes')).json.data
    expect(all.runs.map((run: { entityId: string }) => run.entityId).sort()).toEqual(['cam-1', 'cam-2'])
    expect(all.kinds).toHaveLength(10)
    expect(all.kinds.every((kind: { permitted: boolean; switchEnabled: boolean }) => kind.permitted && kind.switchEnabled)).toBe(true)
    const scoped = (await h.call(scopedA.token, 'GET', '/ads/writes')).json.data
    expect(scoped.runs).toHaveLength(2)
    expect((await h.call(other.token, 'GET', '/ads/writes')).json.data.runs).toEqual([])
    expect(((await h.call(admin.token, 'GET', '/ads/writes?entityId=cam-2')).json.data.runs as unknown[]).length).toBe(1)
  })

  it('回写：本地对象改成新值、写变更记录与操作事件、记录标为已完成；再回写一次什么都不重复；本系统自己的写入不会被识别成外部变更', async () => {
    const [{ id: runId }] = await rows<{ id: string }>(`SELECT id FROM "AdsWriteRun" WHERE "entityId" = 'cam-1'`)
    // 先拍基线快照（写入前的状态），再回写，再扫一次
    const day = 24 * 3_600_000
    const t0 = new Date(Date.now() - 2 * day)
    await runWithTenant(tenantId, () => scan(tenantDb, tenantId, t0))
    await runStep(runId!, 1)
    await runStep(runId!, 1)
    const [campaignRow] = await rows<Record<string, any>>(`SELECT budget::text AS budget FROM "AdsCampaign" WHERE id = 'cam-1'`)
    expect(Number(campaignRow.budget)).toBe(35)
    expect(await rows(`SELECT "actorKind", "actorId", "changedField", "beforeValue", "afterValue", "writeRunId", "entityType" FROM "AdsChangeLog" WHERE "entityId" = 'cam-1'`)).toEqual([
      { actorKind: 'MANUAL', actorId: admin.userId, changedField: 'budget', beforeValue: '20', afterValue: '35', writeRunId: runId, entityType: 'CAMPAIGN' },
    ])
    expect(await rows(`SELECT kind, "actorKind", "sourceRef", "detailJson" FROM "EntityEvent" WHERE "entityId" = 'cam-1' AND kind = 'ads.campaign.budget'`)).toEqual([
      { kind: 'ads.campaign.budget', actorKind: 'USER', sourceRef: `ads-write:${runId}`, detailJson: { before: { budget: '20' }, after: { budget: '35' } } },
    ])
    expect(await rows(`SELECT status, "failureCode", "finishedAt" IS NOT NULL AS done FROM "AdsWriteRun" WHERE id = $1`, [runId])).toEqual([{ status: 'SUCCEEDED', failureCode: null, done: true }])
    const result = await runWithTenant(tenantId, () => scan(tenantDb, tenantId, new Date(t0.getTime() + day)))
    expect(result).toMatchObject({ changes: 0, own: 1, errors: [] })
    expect(await count('AdsChangeLog', `"entityId" = 'cam-1' AND "actorKind" = 'EXTERNAL'`)).toBe(0)
  })

  it('各类写入落到各自的本地表：广告组竞价、投放对象状态、关键词表里的竞价；新增类不改本地对象', async () => {
    const group = await patch(admin, '/ads/ad-groups/ag-1', { kind: 'AD_GROUP_BID', amount: 1.1 })
    const target = await patch(admin, '/ads/targets/tg-1', { kind: 'TARGET_STATE', state: 'PAUSED' })
    const keyword = await patch(admin, '/ads/targets/kw-1', { kind: 'TARGET_BID', amount: 2.2 })
    const negative = await h.call(admin.token, 'POST', '/ads/negatives', { body: { entityId: 'ag-1', level: 'AD_GROUP', text: 'free', matchType: 'NEGATIVE_EXACT' } })
    for (const res of [group, target, keyword, negative]) expect(res.status, JSON.stringify(res.json)).toBe(200)
    for (const res of [group, target, keyword, negative]) await runStep(res.json.data.runs[0].id, 1)
    expect(Number((await rows<{ v: string }>(`SELECT "defaultBid"::text AS v FROM "AdsAdGroup" WHERE id = 'ag-1'`))[0]!.v)).toBe(1.1)
    expect((await rows<{ v: string }>(`SELECT state AS v FROM "AdsTarget" WHERE id = 'tg-1'`))[0]!.v).toBe('PAUSED')
    expect(Number((await rows<{ v: string }>(`SELECT bid::text AS v FROM "AdsKeyword" WHERE id = 'kw-1'`))[0]!.v)).toBe(2.2)
    expect(await rows(`SELECT "entityType", "changedField" FROM "AdsChangeLog" WHERE "entityId" IN ('ag-1', 'tg-1', 'kw-1') ORDER BY "entityId", "changedField"`)).toEqual([
      { entityType: 'AD_GROUP', changedField: 'defaultBid' },
      { entityType: 'AD_GROUP', changedField: 'negativeTarget' },
      { entityType: 'KEYWORD', changedField: 'bid' },
      { entityType: 'TARGET', changedField: 'state' },
    ])
    expect(await count('AdsNegativeTarget')).toBe(0)
  })

  it('永久失败：记录标为失败并留短码（页面有中文原因），已成功的记录不改；对账只查本企业', async () => {
    const res = await patch(admin, '/ads/campaigns', budget('cam-2', 15))
    const runId = res.json.data.runs[0].id as string
    const [job] = await rows<{ id: string }>(`SELECT s.id FROM "SyncJob" s JOIN "AdsWriteRun" r ON r."syncJobId" = s.id WHERE r.id = $1`, [runId])
    await runWithTenant(tenantId, () => dispatch.markAdsWriteFailed(tenantDb, tenantId, { syncJobId: job!.id, requestId: 'r', adsWriteRunId: runId }, 'ADS_API_403_{"detail":"secret"}'))
    expect(await rows(`SELECT status, "failureCode", "finishedAt" IS NOT NULL AS done FROM "AdsWriteRun" WHERE id = $1`, [runId])).toEqual([
      { status: 'FAILED', failureCode: 'ADS_API_403', done: true },
    ])
    expect(JSON.stringify(await rows(`SELECT * FROM "AdsWriteRun" WHERE id = $1`, [runId]))).not.toContain('secret')
    const listed = (await h.call(admin.token, 'GET', '/ads/writes?entityId=cam-2')).json.data.runs as Array<{ id: string; failureText: string | null }>
    expect(listed.find(run => run.id === runId)?.failureText).toContain('拒绝')
    // 授权失效的失败计入开关并立即关闭（预算开关）
    expect((await rows<{ enabled: boolean }>(`SELECT enabled FROM "IntegrationSwitch" WHERE "switchKey" = 'sw.ads.budget' AND "tenantId" = $1`, [tenantId]))[0]!.enabled).toBe(false)
    expect(await rows(`SELECT action, "actorId" FROM "IntegrationSwitchLog" WHERE "tenantId" = $1 AND "switchKey" = 'sw.ads.budget' AND action = 'AUTO_DISABLED'`, [tenantId])).toEqual([
      { action: 'AUTO_DISABLED', actorId: null },
    ])
    await resetSwitches(true)
    const [done] = await rows<{ id: string }>(`SELECT id FROM "AdsWriteRun" WHERE status = 'SUCCEEDED' LIMIT 1`)
    await runWithTenant(tenantId, () => dispatch.markAdsWriteFailed(tenantDb, tenantId, { syncJobId: job!.id, requestId: 'r', adsWriteRunId: done!.id }, 'ADS_API_500_x'))
    expect((await rows<{ status: string }>(`SELECT status FROM "AdsWriteRun" WHERE id = $1`, [done!.id]))[0]!.status).toBe('SUCCEEDED')
    await runWithTenant(otherTenantId, () => dispatch.markAdsWriteFailed(tenantDb, otherTenantId, { syncJobId: job!.id, requestId: 'r', adsWriteRunId: runId }, 'ADS_API_500_x'))
    expect((await rows<{ failureCode: string }>(`SELECT "failureCode" FROM "AdsWriteRun" WHERE id = $1`, [runId]))[0]!.failureCode).toBe('ADS_API_403')
  })

  it('在真实库上关闭开关能写下变更记录（修正前动作取值的检查会拒绝）；关闭后提交被拦住', async () => {
    const manager = await h.createMember(tenantId, 'switch-admin', ['settings.integration.write', 'ads.read'])
    const res = await h.call(manager.token, 'POST', '/settings/integrations/sw.ads.keyword/disable', { body: { reason: '测试关闭：验证变更记录可以写入' } })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(await count('IntegrationSwitchLog', `"tenantId" = $1 AND "switchKey" = 'sw.ads.keyword' AND action = 'DISABLED'`, [tenantId])).toBe(1)
    const blocked = await h.call(admin.token, 'POST', '/ads/keywords', { body: { entityId: 'ag-1', text: 'yoga block', matchType: 'PHRASE' } })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.code).toBe('WRITE_SWITCH_OFF')
    await resetSwitches(true)
  })

  it('约束：类型、来源、对象类型、状态、完成时间与失败码、请求内容都有检查；行级安全按企业隔离', async () => {
    const make = (values: Record<string, unknown>) =>
      insertRow(h.client, 'AdsWriteRun', {
        id: `chk-${Math.random().toString(36).slice(2)}`,
        tenantId,
        adsProfileId: 'ap-a',
        kind: 'CAMPAIGN_STATE',
        source: 'MANUAL',
        entityType: 'CAMPAIGN',
        entityId: 'cam-1',
        externalId: 'x',
        afterValue: 'PAUSED',
        status: 'PENDING',
        requestJson: JSON.stringify({}),
        ...values,
      })
    await expect(make({ kind: 'CAMPAIGN_DELETE' })).rejects.toMatchObject({ code: '23514' })
    await expect(make({ source: 'ROBOT' })).rejects.toMatchObject({ code: '23514' })
    await expect(make({ entityType: 'PORTFOLIO' })).rejects.toMatchObject({ code: '23514' })
    await expect(make({ status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(make({ status: 'SUCCEEDED' })).rejects.toMatchObject({ code: '23514' }) // 已完成必须有完成时间
    await expect(make({ status: 'PENDING', finishedAt: new Date().toISOString() })).rejects.toMatchObject({ code: '23514' })
    await expect(make({ status: 'PENDING', failureCode: 'X' })).rejects.toMatchObject({ code: '23514' }) // 失败码只属于失败
    await expect(make({ requestJson: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' })
    await make({ status: 'FAILED', failureCode: 'X', finishedAt: new Date().toISOString() })
    const seen = await runWithTenant(otherTenantId, () => (tenantDb as unknown as { adsWriteRun: { count(): Promise<number> } }).adsWriteRun.count())
    expect(seen).toBe(await count('AdsWriteRun', `"tenantId" = $1`, [otherTenantId]))
    const crossCreate = async () =>
      runWithTenant(otherTenantId, () =>
        (tenantDb as unknown as { adsWriteRun: { create(args: unknown): Promise<unknown> } }).adsWriteRun.create({
          data: {
            tenantId,
            adsProfileId: 'ap-a',
            kind: 'CAMPAIGN_STATE',
            source: 'MANUAL',
            entityType: 'CAMPAIGN',
            entityId: 'cam-1',
            externalId: 'x',
            afterValue: 'PAUSED',
            status: 'PENDING',
            requestJson: {},
          },
        }),
      )
    await expect(crossCreate()).rejects.toThrow('其他租户')
  })

  it('回滚与重放：rollback.sql 删掉表，migration.sql 能重新建出来（行级安全随之恢复）', async () => {
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    expect(await rows(`SELECT 1 FROM information_schema.tables WHERE table_name = 'AdsWriteRun'`)).toEqual([])
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    expect(await rows(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'AdsWriteRun'`)).toEqual([{ relname: 'AdsWriteRun', relrowsecurity: true }])
    expect(await count('AdsWriteRun')).toBe(0)
  })
})
