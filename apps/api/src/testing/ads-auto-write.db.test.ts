import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 自动规则与分时策略的自动写入（P3-17，真实数据库 + worker 的评估与回写代码）：命中后提交写入（来源、开关、授权），
// 提交时执行记录是“已提交”，亚马逊确认后改为“已执行”、失败改为“失败”；同一小时不重复提交；开关关闭或值没变只记跳过。

const DAY_MS = 86_400_000
const dayText = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10)
const ALL_SWITCHES = ['sw.ads.status', 'sw.ads.budget', 'sw.ads.bid', 'sw.ads.placement', 'sw.ads.negative', 'sw.ads.keyword', 'sw.ads.rule.run', 'sw.ads.dayparting.run']
const grid = (value: number) => new Array<number>(168).fill(value)
const NOW = new Date('2026-10-21T10:15:00Z')

describe('广告自动写入（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  // worker 的模块在运行时动态加载（api 的编译范围不含 worker），这里只写用到的函数形状
  let workflow: { createAdsWriteWorkflow: (deps: unknown) => { steps: Array<{ run: (ctx: unknown) => Promise<unknown> }> } }
  let dispatch: { markAdsWriteFailed: (db: unknown, tenantId: string, payload: unknown, code: string) => Promise<void> }
  let rules: { scanTenantRules: (db: unknown, tenantId: string, now: Date, queues: unknown) => Promise<unknown> }
  let dayparting: { runTenantDayparting: (db: unknown, tenantId: string, queues: unknown, now: Date) => Promise<unknown> }
  const queues = { addSync: vi.fn(async () => undefined) }

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const count = async (table: string, where = 'TRUE', params: unknown[] = []) => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, params))[0]!.n
  const setSwitches = (enabled: boolean, keys: string[] = ALL_SWITCHES) =>
    h.client.query(`UPDATE "IntegrationSwitch" SET enabled = $1 WHERE "tenantId" = $2 AND "switchKey" = ANY($3)`, [enabled, tenantId, keys])
  const scanRules = () => runWithTenant(tenantId, () => rules.scanTenantRules(tenantDb, tenantId, new Date(), queues))
  const runDayparting = (now = NOW) => runWithTenant(tenantId, () => dayparting.runTenantDayparting(tenantDb, tenantId, queues, now))
  const confirm = (runId: string) => {
    const definition = workflow.createAdsWriteWorkflow({ prisma: tenantDb, guardFor: (() => undefined) as never, secrets: {} as never })
    const ctx = { tenantId, intent: { tenantId, connectionId: 'conn-a', adsWriteRunId: runId }, request: {}, responseOf: () => ({}) }
    return runWithTenant(tenantId, () => definition.steps[1]!.run(ctx as never))
  }
  const strategy = (id: string, extra: Record<string, unknown>) =>
    insertRow(h.client, 'DaypartingStrategy', {
      id,
      tenantId,
      adsProfileId: 'ap-a',
      name: id,
      kind: 'ON_OFF',
      targetLevel: 'CAMPAIGN',
      scopeJson: { ids: ['cam-2'] },
      hourlyMultipliersJson: JSON.stringify(grid(0)),
      timezone: 'UTC',
      status: 'ACTIVE',
      createdBy: 'u1',
      updatedBy: 'u1',
      ...extra,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_auto_write' })
    const a = await h.createTenant('a')
    tenantId = a.tenantId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: a.sellerAccountId, bindingStatus: 'MANUAL', adsAccountId: 'ACC-ap-a' })
    await insertRow(h.client, 'AdsAccount', { id: 'acct-ap-a', tenantId, adsProfileId: 'ap-a', adsAccountId: 'ACC-ap-a', name: 'ap-a' })
    const campaign = (id: string, external: string, name: string, state: string, budget: number) =>
      insertRow(h.client, 'AdsCampaign', {
        id,
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        externalCampaignId: external,
        adProduct: 'SPONSORED_PRODUCTS',
        name,
        state,
        budget,
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      })
    await campaign('cam-1', 'c1', '高 ACoS 活动', 'ENABLED', 20)
    await campaign('cam-2', 'c2', '分时活动', 'ENABLED', 10)
    await insertRow(h.client, 'AdsAdGroup', {
      id: 'ag-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      adGroupId: 'AG1',
      campaignId: 'c2',
      name: '核心词组',
      state: 'ENABLED',
      defaultBid: 0.8,
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    for (let offset = -7; offset <= -1; offset += 1) {
      await insertRow(h.client, 'AdsDailySummary', {
        id: `s1-${offset}`,
        tenantId,
        adsProfileId: 'ap-a',
        adProduct: 'SPONSORED_PRODUCTS',
        campaignId: 'c1',
        summaryDate: dayText(offset),
        metricVersion: 'ads.v1',
        spend: 10,
        sales: 20,
        clicks: 20,
        impressions: 1000,
        orders: 2,
      })
    }
    await insertRow(h.client, 'AdsAutomationRule', {
      id: 'rule-1',
      tenantId,
      adsProfileId: 'ap-a',
      name: '高 ACoS 自动暂停',
      level: 'CAMPAIGN',
      mode: 'AUTO',
      status: 'ACTIVE',
      frequency: 'DAILY',
      scopeJson: { campaignIds: [] },
      conditionJson: { conditions: [{ metric: 'acos', windowDays: 7, op: 'gt', value: 40 }], textFilters: [] },
      actionJson: { type: 'PAUSE' },
      guardrailJson: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 },
      createdBy: 'u1',
      updatedBy: 'u1',
    })
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    for (const key of ALL_SWITCHES) await insertRow(h.client, 'IntegrationSwitch', { id: `sw-${key}`, tenantId, switchKey: key, enabled: true })

    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_auto_write', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    workflow = await import(/* @vite-ignore */ String('../../../worker/src/runtime/ads-write-workflow'))
    dispatch = await import(/* @vite-ignore */ String('../../../worker/src/connectors/ads-write-dispatch'))
    rules = await import(/* @vite-ignore */ String('../../../worker/src/ads-rules/run'))
    dayparting = await import(/* @vite-ignore */ String('../../../worker/src/ads-dayparting/run'))
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('自动规则：命中后提交写入（来源自动规则、排队），执行记录是“已提交”，没有待办，本地对象此时还没改', async () => {
    const result = await scanRules()
    expect(result).toMatchObject({ rules: 1, queued: 1, suggested: 0, errors: [] })
    const runs = await rows<Record<string, any>>(`SELECT "entityKey", outcome, executed, "writeRunId", "workItemId", message FROM "AdsAutomationRun"`)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ entityKey: 'cam-1', outcome: 'QUEUED', executed: false, workItemId: null })
    const writes = await rows<Record<string, any>>(`SELECT id, kind, source, "entityId", "afterValue", "beforeValue", status, "syncJobId", "requestedBy" FROM "AdsWriteRun"`)
    expect(writes).toEqual([
      {
        id: runs[0]!.writeRunId,
        kind: 'CAMPAIGN_STATE',
        source: 'AUTO_RULE',
        entityId: 'cam-1',
        afterValue: 'PAUSED',
        beforeValue: 'ENABLED',
        status: 'PENDING',
        syncJobId: expect.any(String),
        requestedBy: null,
      },
    ])
    expect(await rows(`SELECT type, domain, status FROM "SyncJob" WHERE id = $1`, [writes[0]!.syncJobId])).toEqual([{ type: 'ADS_WRITE', domain: 'ads', status: 'PENDING' }])
    expect(queues.addSync).toHaveBeenCalledTimes(1)
    expect(queues.addSync).toHaveBeenCalledWith('ADS_WRITE', expect.objectContaining({ tenantId, adsWriteRunId: writes[0]!.id }), expect.objectContaining({ jobId: writes[0]!.syncJobId }))
    expect(await count('WorkItem')).toBe(0)
    expect((await rows<{ state: string }>(`SELECT state FROM "AdsCampaign" WHERE id = 'cam-1'`))[0]!.state).toBe('ENABLED')
  })

  it('亚马逊确认后：本地对象改了，执行记录改为“已执行”，变更记录的来源是自动规则；重复确认不重复', async () => {
    const [{ writeRunId }] = await rows<{ writeRunId: string }>(`SELECT "writeRunId" FROM "AdsAutomationRun"`)
    await confirm(writeRunId!)
    await confirm(writeRunId!)
    expect((await rows<{ state: string }>(`SELECT state FROM "AdsCampaign" WHERE id = 'cam-1'`))[0]!.state).toBe('PAUSED')
    expect(await rows(`SELECT outcome, executed, message FROM "AdsAutomationRun"`)).toEqual([{ outcome: 'APPLIED', executed: true, message: null }])
    expect(await rows(`SELECT "actorKind", "actorId", "afterValue" FROM "AdsChangeLog" WHERE "entityId" = 'cam-1'`)).toEqual([{ actorKind: 'AUTO_RULE', actorId: null, afterValue: 'PAUSED' }])
    expect(await rows(`SELECT "actorKind" FROM "EntityEvent" WHERE "entityId" = 'cam-1' AND kind = 'ads.campaign.state'`)).toEqual([{ actorKind: 'SYSTEM' }])
  })

  it('自动规则：来源开关关闭时只记“已跳过”并写明开关，不建写入记录也不入队；对象已经是目标状态时同样跳过', async () => {
    await h.client.query(`UPDATE "AdsCampaign" SET state = 'ENABLED' WHERE id = 'cam-1'`)
    await h.client.query(`UPDATE "AdsAutomationRule" SET "lastRunAt" = NULL`)
    await setSwitches(false, ['sw.ads.rule.run'])
    const before = queues.addSync.mock.calls.length
    const result = await scanRules()
    expect(result).toMatchObject({ queued: 0, errors: [] })
    const [skipped] = await rows<Record<string, any>>(`SELECT outcome, executed, message, "writeRunId" FROM "AdsAutomationRun" ORDER BY "runAt" DESC LIMIT 1`)
    expect(skipped).toMatchObject({ outcome: 'SKIPPED', executed: false, writeRunId: null })
    expect(skipped.message).toContain('sw.ads.rule.run')
    expect(await count('AdsWriteRun')).toBe(1)
    expect(queues.addSync.mock.calls.length).toBe(before)
    await setSwitches(true)
  })

  it('失败：写入永久失败后，执行记录改为“失败”并写中文原因（不含亚马逊原文）', async () => {
    await h.client.query(`UPDATE "AdsAutomationRule" SET "lastRunAt" = NULL`)
    await scanRules()
    const [{ writeRunId }] = await rows<{ writeRunId: string }>(`SELECT "writeRunId" FROM "AdsAutomationRun" WHERE outcome = 'QUEUED'`)
    await runWithTenant(tenantId, () => dispatch.markAdsWriteFailed(tenantDb, tenantId, { syncJobId: 'j', requestId: 'r', adsWriteRunId: writeRunId! }, 'ADS_API_400_{"detail":"secret"}'))
    const [failed] = await rows<Record<string, any>>(`SELECT outcome, executed, message FROM "AdsAutomationRun" WHERE "writeRunId" = $1`, [writeRunId])
    expect(failed).toMatchObject({ outcome: 'FAILED', executed: false })
    expect(String(failed.message)).not.toContain('secret')
    expect(String(failed.message).length).toBeGreaterThan(0)
  })

  it('分时策略（启停）：此刻是暂停格就提交暂停，同一小时再扫不重复；确认后记录改为已执行', async () => {
    await strategy('dp-off', {})
    const first = await runDayparting()
    expect(first).toMatchObject({ queued: 1, errors: [] })
    expect(await rows(`SELECT "entityId", hour, "appliedMultiplier"::float AS m, outcome, executed FROM "DaypartingRun" WHERE "strategyId" = 'dp-off'`)).toEqual([
      { entityId: 'cam-2', hour: 10, m: 0, outcome: 'QUEUED', executed: false },
    ])
    const calls = queues.addSync.mock.calls.length
    expect(await runDayparting(new Date('2026-10-21T10:45:00Z'))).toMatchObject({ queued: 0, skipped: 0 })
    expect(queues.addSync.mock.calls.length).toBe(calls)
    expect(await count('DaypartingRun', `"strategyId" = 'dp-off'`)).toBe(1)
    const [{ writeRunId }] = await rows<{ writeRunId: string }>(`SELECT "writeRunId" FROM "DaypartingRun" WHERE "strategyId" = 'dp-off'`)
    expect(await rows(`SELECT source, kind, "afterValue" FROM "AdsWriteRun" WHERE id = $1`, [writeRunId])).toEqual([{ source: 'DAYPARTING', kind: 'CAMPAIGN_STATE', afterValue: 'PAUSED' }])
    await confirm(writeRunId!)
    expect(await rows(`SELECT outcome, executed FROM "DaypartingRun" WHERE "strategyId" = 'dp-off'`)).toEqual([{ outcome: 'APPLIED', executed: true }])
    expect((await rows<{ state: string }>(`SELECT state FROM "AdsCampaign" WHERE id = 'cam-2'`))[0]!.state).toBe('PAUSED')
    // 下一个小时是启用格：改回启用
    await h.client.query(`UPDATE "DaypartingStrategy" SET "hourlyMultipliersJson" = $1::jsonb WHERE id = 'dp-off'`, [JSON.stringify(grid(1))])
    expect(await runDayparting(new Date('2026-10-21T11:05:00Z'))).toMatchObject({ queued: 1 })
    expect(await rows(`SELECT "afterValue" FROM "AdsWriteRun" WHERE source = 'DAYPARTING' ORDER BY "createdAt" DESC LIMIT 1`)).toEqual([{ afterValue: 'ENABLED' }])
  })

  it('分时策略（竞价系数）：广告组把默认竞价改为基准竞价 × 系数；活动级系数没有对应字段，记跳过；没有基准竞价记跳过；值没变记跳过', async () => {
    await h.client.query(`DELETE FROM "DaypartingStrategy" WHERE id = 'dp-off'`)
    await strategy('dp-bid', { kind: 'BID_MULTIPLIER', targetLevel: 'AD_GROUP', scopeJson: { ids: ['ag-1'] }, hourlyMultipliersJson: JSON.stringify(grid(1.5)), baseBid: 1 })
    await strategy('dp-camp', { kind: 'BID_MULTIPLIER', targetLevel: 'CAMPAIGN', scopeJson: { ids: ['cam-2'] }, hourlyMultipliersJson: JSON.stringify(grid(1.5)), baseBid: 1 })
    await strategy('dp-nobase', { kind: 'BID_MULTIPLIER', targetLevel: 'AD_GROUP', scopeJson: { ids: ['ag-1'] }, hourlyMultipliersJson: JSON.stringify(grid(1.5)) })
    const now = new Date('2026-10-22T09:00:00Z')
    expect(await runDayparting(now)).toMatchObject({ queued: 1, skipped: 2, errors: [] })
    const outcomes = await rows<Record<string, any>>(`SELECT "strategyId", outcome, message FROM "DaypartingRun" WHERE "runAt" = $1::timestamp ORDER BY "strategyId"`, [now.toISOString()])
    expect(outcomes.map(row => [row.strategyId, row.outcome])).toEqual([
      ['dp-bid', 'QUEUED'],
      ['dp-camp', 'SKIPPED'],
      ['dp-nobase', 'SKIPPED'],
    ])
    expect(outcomes[1]!.message).toContain('活动没有可以按系数调整的竞价字段')
    expect(outcomes[2]!.message).toContain('基准竞价')
    expect(await rows(`SELECT kind, "afterValue", "beforeValue" FROM "AdsWriteRun" WHERE source = 'DAYPARTING' ORDER BY "createdAt" DESC LIMIT 1`)).toEqual([
      { kind: 'AD_GROUP_BID', afterValue: '1.5', beforeValue: '0.8' },
    ])
    const [{ writeRunId }] = await rows<{ writeRunId: string }>(`SELECT "writeRunId" FROM "DaypartingRun" WHERE "strategyId" = 'dp-bid'`)
    await confirm(writeRunId!)
    expect(Number((await rows<{ v: string }>(`SELECT "defaultBid"::text AS v FROM "AdsAdGroup" WHERE id = 'ag-1'`))[0]!.v)).toBe(1.5)
    const later = new Date('2026-10-22T10:00:00Z')
    await runDayparting(later)
    const [same] = await rows<Record<string, any>>(`SELECT outcome, message FROM "DaypartingRun" WHERE "strategyId" = 'dp-bid' AND "runAt" = $1::timestamp`, [later.toISOString()])
    expect(same.outcome).toBe('SKIPPED')
    expect(same.message).toContain('当前值已经是')
  })

  it('暂停的策略不执行；约束：已提交可以存在，但“已执行”必须是已执行的结果', async () => {
    await h.client.query(`UPDATE "DaypartingStrategy" SET status = 'PAUSED'`)
    const calls = queues.addSync.mock.calls.length
    expect(await runDayparting(new Date('2026-10-23T09:00:00Z'))).toMatchObject({ strategies: 0, queued: 0 })
    expect(queues.addSync.mock.calls.length).toBe(calls)
    const run = { tenantId, strategyId: 'dp-bid', entityId: 'ag-1', hour: 3, appliedMultiplier: 1, runAt: '2026-10-24T03:00:00Z' }
    await expect(insertRow(h.client, 'DaypartingRun', { id: 'chk-1', ...run, executed: true, outcome: 'QUEUED' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'DaypartingRun', { id: 'chk-2', ...run, executed: false, outcome: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await insertRow(h.client, 'DaypartingRun', { id: 'chk-3', ...run, executed: false, outcome: 'QUEUED', writeRunId: 'w-1' })
  })
})
