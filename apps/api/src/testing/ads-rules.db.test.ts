import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 自动规则（P3-13，真实数据库 + 完整应用 + worker 的定时评估代码）：创建 / 修改（乐观锁、重名、内容校验、自动模式要写入开关）、审计、
// 数据范围（经广告档案绑定的店铺）、企业隔离、试运行（三个层级、护栏收窄、跳过原因，只读）、定时评估（待办、执行记录、去重、每日上限、没有数据不评估）、
// 执行记录翻页、规则质量（命中率、采纳率、执行后效果），以及两张表的约束与回滚。

type Member = { userId: string; token: string }
type ScanTenant = (db: unknown, tenantId: string, now?: Date) => Promise<{ rules: number; suggested: number; skipped: number; noData: number; errors: string[] }>

const DAY_MS = 86_400_000
const dayText = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10)
const cond = (metric: string, windowDays: number, op: string, value: number) => ({ metric, windowDays, op, value })
const guard = (patch: Record<string, unknown> = {}) => ({ minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5, ...patch })
const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261115010000_ads_automation_rules')

describe('自动规则（真实数据库）', () => {
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
  let reader: Member
  let noAds: Member
  let other: Member
  const ids: Record<string, string> = {}
  let seq = 0

  const body = (patch: Record<string, unknown> = {}) => ({
    adsProfileId: 'ap-a',
    name: '高 ACoS 暂停',
    level: 'CAMPAIGN',
    conditions: [cond('acos', 7, 'gt', 40)],
    action: { type: 'PAUSE' },
    guardrails: guard(),
    ...patch,
  })
  const create = (member: Member, patch: Record<string, unknown> = {}) => h.call(member.token, 'POST', '/ads/rules', { body: body(patch) })
  const patch = (member: Member, id: string, payload: Record<string, unknown>) => h.call(member.token, 'PATCH', `/ads/rules/${id}`, { body: payload })
  const dryRun = (member: Member, id: string, payload: Record<string, unknown> = {}) => h.call(member.token, 'POST', `/ads/rules/${id}/dry-run`, { body: payload })
  const list = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/ads/rules')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as Record<string, any>
  }
  const detail = async (member: Member, id: string) => {
    const res = await h.call(member.token, 'GET', `/ads/rules/${id}`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as Record<string, any>
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const audits = (action: string) =>
    rows<Record<string, any>>(`SELECT "resourceId", "beforeJson", "afterJson", result FROM "AuditEvent" WHERE action = $1 AND "tenantId" = $2 ORDER BY "occurredAt"`, [action, tenantId])
  const runsOf = (ruleId: string) => rows<Record<string, any>>(`SELECT * FROM "AdsAutomationRun" WHERE "ruleId" = $1 ORDER BY "runAt", "entityKey"`, [ruleId])
  const summary = (id: string, external: string, offset: number, values: Record<string, unknown>, profile = 'ap-a') =>
    insertRow(h.client, 'AdsDailySummary', {
      id,
      tenantId,
      adsProfileId: profile,
      adProduct: 'SPONSORED_PRODUCTS',
      campaignId: external,
      summaryDate: dayText(offset),
      metricVersion: 'ads.v1',
      ...values,
    })
  const runScan = (now: Date = new Date()) => runWithTenant(tenantId, () => scan(tenantDb, tenantId, now))

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_rules' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-o', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    for (const [profile, tenant] of [
      ['ap-a', tenantId],
      ['ap-b', tenantId],
      ['ap-o', otherTenantId],
    ] as const) {
      await insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })
    }
    const campaign = (id: string, profile: string, external: string, name: string, state: string, budget: number | null, tenant = tenantId) =>
      insertRow(h.client, 'AdsCampaign', {
        id,
        tenantId: tenant,
        adsProfileId: profile,
        adsAccountId: `ACC-${profile}`,
        externalCampaignId: external,
        adProduct: 'SPONSORED_PRODUCTS',
        name,
        state,
        budget,
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      })
    await campaign('cam-1', 'ap-a', 'c1', '瑜伽垫活动', 'ENABLED', 20)
    await campaign('cam-2', 'ap-a', 'c2', '泡沫轴活动', 'ENABLED', 10)
    await campaign('cam-3', 'ap-a', 'c3', '已暂停活动', 'PAUSED', 5)
    await campaign('cam-b', 'ap-b', 'cb', '店铺 B 活动', 'ENABLED', 5)
    await campaign('cam-o', 'ap-o', 'co', '别的企业活动', 'ENABLED', 5, otherTenantId)
    for (let offset = -7; offset <= -1; offset += 1) {
      await summary(`s1-${offset}`, 'c1', offset, { spend: 10, sales: 20, clicks: 20, impressions: 1000, orders: 2 })
      await summary(`s2-${offset}`, 'c2', offset, { spend: 5, sales: 50, clicks: 10, impressions: 800, orders: 5 })
      await summary(`s3-${offset}`, 'c3', offset, { spend: 8, sales: 0, clicks: 8, impressions: 500, orders: 0 })
    }
    // 投放词：关键词 K1 花得多卖得少，投放 T1 表现好
    await insertRow(h.client, 'AdsAdGroup', {
      id: 'ag-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      adGroupId: 'AG1',
      campaignId: 'c1',
      name: '核心词组',
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsKeyword', {
      id: 'kw-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      keywordId: 'K1',
      campaignId: 'c1',
      adGroupId: 'AG1',
      text: 'yoga mat',
      matchType: 'EXACT',
      bid: 1.5,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsTarget', {
      id: 'tg-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      targetId: 'T1',
      adGroupId: 'AG1',
      kind: 'PRODUCT',
      expression: 'asin="B0XYZ"',
      bid: 0.9,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    const metric = (entityType: string, entityId: string, offset: number, values: Record<string, unknown>) =>
      insertRow(h.client, 'AdsMetric', {
        id: `met-${++seq}`,
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        reportDate: dayText(offset),
        adProduct: 'SPONSORED_PRODUCTS',
        entityType,
        entityId,
        ...values,
      })
    for (let offset = -7; offset <= -1; offset += 1) {
      await metric('KEYWORD', 'K1', offset, { impressions: 400, clicks: 30, cost: 10, sales: 10, purchases: 1 })
      await metric('TARGET', 'T1', offset, { impressions: 300, clicks: 10, cost: 2, sales: 20, purchases: 2 })
    }
    // 搜索词：free yoga 没投放、花了点击没订单；yoga mat 已是投放词；bad yoga 已被否定；other term 点击少
    await insertRow(h.client, 'AdsNegativeTarget', {
      id: 'neg-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      negativeId: 'N1',
      level: 'CAMPAIGN',
      campaignId: 'c1',
      expression: 'bad yoga',
      matchType: 'NEGATIVE_EXACT',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    const term = (text: string, campaign: string, offset: number, values: Record<string, unknown>) =>
      insertRow(h.client, 'AdsTermMetric', {
        id: `tm-${++seq}`,
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        adProduct: 'SPONSORED_PRODUCTS',
        level: 'SEARCH_TERM',
        externalCampaignId: campaign,
        adGroupId: 'AG1',
        searchTerm: text,
        reportDate: dayText(offset),
        rowKey: `rk-${seq}`,
        sourceUpdatedAt: new Date().toISOString(),
        ...values,
      })
    for (let offset = -7; offset <= -1; offset += 1) {
      for (const text of ['free yoga', 'yoga mat', 'bad yoga']) await term(text, 'c1', offset, { impressions: 200, clicks: 20, cost: 3, sales: 0, purchases: 0 })
      await term('other term', 'c2', offset, { impressions: 50, clicks: 5, cost: 1, sales: 0, purchases: 0 })
    }

    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_rules', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    scan = (await import(/* @vite-ignore */ String('../../../worker/src/ads-rules/run'))).scanTenantRules as ScanTenant

    const write = ['ads.read', 'ads.rule.write']
    admin = await h.createMember(tenantId, 'admin', write)
    scopedA = await h.createMember(tenantId, 'scopeda', write, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', write, { scopes: [{ sellerAccountId: storeB }] })
    reader = await h.createMember(tenantId, 'reader', ['ads.read'])
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', write)
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('还没有规则：列表是“尚无记录”；自动模式开关默认关并说明原因；有写权限的人 canWrite；可选账户按数据范围；没有 ads.read 是 403', async () => {
    const data = await list(admin)
    expect(data.rules).toMatchObject({ state: 'NO_DATA', items: [], truncated: false })
    expect(data.auto).toMatchObject({ allowed: false })
    expect(data.auto.reason).toContain('开关')
    expect(data.canWrite).toBe(true)
    expect(data.execution.state).toBe('CONNECTED')
    expect((data.profiles as Array<{ id: string }>).map(p => p.id).sort()).toEqual(['ap-a', 'ap-b'])
    expect((await list(reader)).canWrite).toBe(false)
    expect(((await list(scopedA)).profiles as Array<{ id: string }>).map(p => p.id)).toEqual(['ap-a'])
    expect((await h.call(noAds.token, 'GET', '/ads/rules')).status).toBe(403)
  })

  it('创建：默认建议模式、已暂停、每天一次，写审计；返回中文摘要与版本 1', async () => {
    const res = await create(admin)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const rule = res.json.data.rule
    ids.a = rule.id
    expect(rule).toMatchObject({ name: '高 ACoS 暂停', mode: 'SUGGEST', status: 'PAUSED', frequency: 'DAILY', version: 1, accountName: 'P-A', lastRunAt: null, lastEvaluated: null })
    expect(rule.summary.conditions).toContain('广告成本销售比')
    expect(rule.summary.action).toBe('暂停')
    expect(rule.spec.campaignIds).toEqual([])
    const events = await audits('ADS_RULE_CREATED')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ resourceId: rule.id, result: 'SUCCEEDED' })
    expect(events[0].afterJson).toMatchObject({ name: '高 ACoS 暂停', mode: 'SUGGEST', level: 'CAMPAIGN', version: 1 })
  })

  it('创建的校验：重名 409；别的账户、别的企业、范围外的活动与账户 404（整批不保存）；只读成员 403；内容不合法 422', async () => {
    expect((await create(admin)).status).toBe(409)
    expect((await create(admin, { adsProfileId: 'ap-b', campaignIds: ['cam-b'] })).status).toBe(201) // 同名但在另一个账户下可以
    ids.b = (await rows<{ id: string }>(`SELECT id FROM "AdsAutomationRule" WHERE "adsProfileId" = 'ap-b'`))[0]!.id
    expect((await create(admin, { name: 'x1', campaignIds: ['cam-1', 'cam-b'] })).status).toBe(404)
    expect((await create(admin, { name: 'x2', campaignIds: ['cam-o'] })).status).toBe(404)
    expect((await create(admin, { name: 'x3', adsProfileId: 'ap-o' })).status).toBe(404)
    expect((await create(scopedA, { name: 'x4', adsProfileId: 'ap-b' })).status).toBe(404)
    expect((await create(reader, { name: 'x5' })).status).toBe(403)
    expect((await create(admin, { name: 'x6', action: { type: 'NEGATE', matchType: 'NEGATIVE_EXACT' } })).status).toBe(422) // 动作不属于这个层级
    expect((await create(admin, { name: 'x7', level: 'TARGET', action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -10 }, guardrails: guard() })).status).toBe(422) // 调价必须有幅度上限
    expect((await create(admin, { name: 'x8', conditions: [] })).status).toBe(422)
    expect((await create(admin, { name: 'x9', conditions: [cond('acos', 5, 'gt', 40)] })).status).toBe(422) // 窗口只能是 1、3、7、14、30
    const count = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsAutomationRule" WHERE "tenantId" = $1`, [tenantId])
    expect(count[0]!.n).toBe(2)
    expect((await list(other)).rules).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('自动执行模式要写入开关：开关没开 409（WRITE_SWITCH_OFF），不悄悄降级；开了才能创建，也只有这时能把建议改成自动', async () => {
    const off = await create(admin, { name: '自动-关', mode: 'AUTO' })
    expect(off.status).toBe(409)
    expect(off.json.error.code).toBe('WRITE_SWITCH_OFF')
    expect((await rows(`SELECT 1 FROM "AdsAutomationRule" WHERE name = '自动-关'`)).length).toBe(0)
    expect((await patch(admin, ids.a, { version: 1, mode: 'AUTO' })).status).toBe(409)
    await insertRow(h.client, 'IntegrationSwitch', { id: 'sw-rule', tenantId, switchKey: 'sw.ads.rule.run', enabled: true })
    expect((await list(admin)).auto).toEqual({ allowed: true, reason: null })
    const on = await create(admin, { name: '自动-开', mode: 'AUTO' })
    expect(on.status, JSON.stringify(on.json)).toBe(201)
    expect(on.json.data.rule.mode).toBe('AUTO')
    ids.auto = on.json.data.rule.id
  })

  it('修改：版本号对得上才改，+1 并写审计（含前后）；旧版本 409；合并后的内容要整体合法；改名重名 409；范围外与别的企业 404；只读 403', async () => {
    const ok = await patch(admin, ids.a, { version: 1, name: '高 ACoS 暂停（改）', conditions: [cond('acos', 7, 'gt', 40), cond('spend', 7, 'gte', 20)], guardrails: guard({ dailyLimit: 3 }) })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.data.rule).toMatchObject({ name: '高 ACoS 暂停（改）', version: 2 })
    expect(ok.json.data.rule.spec.guardrails.dailyLimit).toBe(3)
    const events = await audits('ADS_RULE_UPDATED')
    expect(events).toHaveLength(1)
    expect(events[0].beforeJson).toMatchObject({ name: '高 ACoS 暂停', version: 1 })
    expect(events[0].afterJson).toMatchObject({ name: '高 ACoS 暂停（改）', version: 2 })
    const stale = await patch(admin, ids.a, { version: 1, name: '又改' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('CONFLICT')
    expect((await audits('ADS_RULE_UPDATED')).length).toBe(1)
    expect((await patch(admin, ids.a, { version: 2, action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -10 } })).status).toBe(422) // 活动层级不能调竞价
    expect((await patch(admin, ids.a, { version: 2, guardrails: guard({ maxChangePercent: 20 }) })).status).toBe(422) // 暂停不需要调整幅度上限
    expect((await patch(admin, ids.a, { version: 2, campaignIds: ['cam-1', 'cam-b'] })).status).toBe(404)
    expect((await patch(admin, ids.a, { version: 2, name: '自动-开' })).status).toBe(409)
    expect((await patch(admin, ids.a, { version: 2, name: '高 ACoS 暂停' })).status).toBe(200) // 改回自己原来的名称不算重名
    expect((await patch(scopedB, ids.a, { version: 3, name: '偷改' })).status).toBe(404)
    expect((await patch(other, ids.a, { version: 3, name: '偷改' })).status).toBe(404)
    expect((await patch(reader, ids.a, { version: 3, name: '偷改' })).status).toBe(403)
    expect((await patch(admin, 'not-there', { version: 1, name: 'x' })).status).toBe(404)
    expect((await patch(admin, ids.a, { version: 3 })).status).toBe(422)
  })

  it('三类规则再各建一条；数据范围：只看店铺 A 的成员看不到店铺 B 账户下的规则，反之亦然；别的企业看不到', async () => {
    const targetRule = await create(admin, {
      name: '高 ACoS 降价',
      level: 'TARGET',
      conditions: [cond('acos', 7, 'gt', 80)],
      action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -30 },
      guardrails: guard({ maxChangePercent: 20, minValue: 0.3 }),
    })
    expect(targetRule.status, JSON.stringify(targetRule.json)).toBe(201)
    ids.target = targetRule.json.data.rule.id
    const termRule = await create(admin, {
      name: '无单搜索词否定',
      level: 'SEARCH_TERM',
      conditions: [cond('clicks', 7, 'gte', 50), cond('orders', 7, 'lte', 0)],
      action: { type: 'NEGATE', matchType: 'NEGATIVE_EXACT' },
    })
    expect(termRule.status, JSON.stringify(termRule.json)).toBe(201)
    ids.term = termRule.json.data.rule.id
    const limitRule = await create(admin, { name: '花费上限一个', conditions: [cond('spend', 7, 'gte', 5)], guardrails: guard({ dailyLimit: 1 }) })
    expect(limitRule.status).toBe(201)
    ids.limit = limitRule.json.data.rule.id
    const all = [ids.a, ids.b, ids.auto, ids.target, ids.term, ids.limit].sort()
    expect(((await list(admin)).rules.items as Array<{ id: string }>).map(item => item.id).sort()).toEqual(all)
    expect(((await list(scopedA)).rules.items as Array<{ id: string }>).map(item => item.id).sort()).toEqual(all.filter(id => id !== ids.b))
    expect(((await list(scopedB)).rules.items as Array<{ id: string }>).map(item => item.id)).toEqual([ids.b])
    expect((await list(other)).rules.items).toEqual([])
    expect((await h.call(scopedB.token, 'GET', `/ads/rules/${ids.a}`)).status).toBe(404)
    expect((await h.call(other.token, 'GET', `/ads/rules/${ids.a}`)).status).toBe(404)
  })

  it('试运行·活动：命中花费高的活动，给出前后值与触发证据；已暂停和缺数据的对象不命中；只读、不写审计，只读成员也能看', async () => {
    const before = await rows<{ runs: number; works: number }>(`SELECT (SELECT count(*)::int FROM "AdsAutomationRun") AS runs, (SELECT count(*)::int FROM "WorkItem") AS works`)
    const res = await dryRun(reader, ids.a)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ state: 'OK', evaluated: 3, matched: 1, dailyLimit: 3, incomplete: false, dataThrough: dayText(-1), asOf: dayText(-1) })
    expect(data.hits).toHaveLength(1)
    expect(data.hits[0]).toMatchObject({ key: 'cam-1', label: '瑜伽垫活动', actionType: 'PAUSE', before: 'ENABLED', after: 'PAUSED' })
    expect(data.hits[0].metrics['acos:7']).toBeCloseTo(50, 1)
    expect(data.caveats.length).toBeGreaterThan(0)
    expect(await rows(`SELECT count(*)::int AS runs, (SELECT count(*)::int FROM "WorkItem") AS works FROM "AdsAutomationRun"`)).toEqual([{ runs: before[0]!.runs, works: before[0]!.works }])
    expect(await audits('ADS_RULE_DRY_RUN')).toEqual([])
    expect((await dryRun(admin, ids.a, { asOf: dayText(0) })).status).toBe(422) // 今天的指标不完整
    expect((await dryRun(admin, ids.a, { asOf: 'yesterday' })).status).toBe(422)
    expect((await dryRun(admin, ids.a, { asOf: dayText(-20) })).json.data).toMatchObject({ state: 'OK', matched: 0 }) // 20 天前的窗口里没有数据：不命中，不当 0
    expect((await dryRun(scopedB, ids.a)).status).toBe(404)
    expect((await dryRun(other, ids.a)).status).toBe(404)
    expect((await dryRun(noAds, ids.a)).status).toBe(403)
    // 店铺 B 的账户没有任何日指标：尚未接入，不是“没命中”
    expect((await dryRun(admin, ids.b)).json.data).toMatchObject({ state: 'NOT_CONNECTED', hits: [] })
  })

  it('试运行·投放词与搜索词：降价按护栏收窄（-30% 收窄到 -20%）；搜索词已是投放词、已被否定的被跳过并说明原因；限定活动与文本过滤生效', async () => {
    const target = (await dryRun(admin, ids.target)).json.data
    expect(target).toMatchObject({ state: 'OK', evaluated: 2, matched: 1 })
    expect(target.hits).toHaveLength(1)
    expect(target.hits[0]).toMatchObject({ key: 'K1', label: 'yoga mat', campaignLabel: '瑜伽垫活动', actionType: 'ADJUST_BID', before: '1.50', after: '1.20' })
    expect(target.hits[0].notes.join('')).toContain('单次调整幅度上限')
    const term = (await dryRun(admin, ids.term)).json.data
    expect(term).toMatchObject({ state: 'OK', evaluated: 4, matched: 3 })
    expect(term.hits.map((hit: { label: string }) => hit.label)).toEqual(['free yoga'])
    expect(term.hits[0]).toMatchObject({ key: 'c1|free yoga', before: 'UNTARGETED', after: 'NEGATIVE_EXACT' })
    expect(term.skipped.map((skip: { label: string; reason: string }) => `${skip.label}:${skip.reason}`).sort()).toEqual([
      'bad yoga:这个搜索词已经被否定',
      'yoga mat:这个搜索词已经是投放词，请改用调价或暂停，不要直接否定',
    ])
    // 限定到活动二：只剩 other term，点击不够，不命中
    expect((await patch(admin, ids.term, { version: 1, campaignIds: ['cam-2'] })).status).toBe(200)
    expect((await dryRun(admin, ids.term)).json.data).toMatchObject({ evaluated: 1, matched: 0, hits: [] })
    // 文本过滤：对象名称不包含 yoga → 全被过滤掉，给出说明
    expect((await patch(admin, ids.term, { version: 2, campaignIds: [], textFilters: [{ field: 'NAME', mode: 'NOT_CONTAINS', text: 'yoga' }] })).status).toBe(200)
    expect((await dryRun(admin, ids.term)).json.data).toMatchObject({ evaluated: 1, matched: 0 })
    expect((await patch(admin, ids.term, { version: 3, textFilters: [] })).status).toBe(200)
  })

  it('定时评估：命中生成待办与执行记录（自动模式只生成待办并写明）；每日上限之外记为跳过；没有日指标的账户不评估；评估统计更新但不动版本与修改时间', async () => {
    for (const id of [ids.a, ids.b, ids.auto, ids.target, ids.term, ids.limit]) {
      const current = (await rows<{ version: number }>(`SELECT version FROM "AdsAutomationRule" WHERE id = $1`, [id]))[0]!.version
      expect((await patch(admin, id, { version: current, status: 'ACTIVE' })).status).toBe(200)
    }
    const stamp = async (id: string) => (await rows<{ version: number; updatedAt: Date }>(`SELECT version, "updatedAt" FROM "AdsAutomationRule" WHERE id = $1`, [id]))[0]!
    const aBefore = await stamp(ids.a)
    const result = await runScan()
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ rules: 5, suggested: 5, skipped: 1, noData: 1 })

    const a = await runsOf(ids.a)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ entityKey: 'cam-1', actionType: 'PAUSE', outcome: 'SUGGESTED', executed: false, beforeValue: 'ENABLED', afterValue: 'PAUSED', ruleVersion: aBefore.version })
    expect(a[0].workItemId).toBeTruthy()
    expect(a[0].evidenceJson['acos:7']).toBeCloseTo(50, 1)
    const works = await rows<Record<string, any>>(`SELECT * FROM "WorkItem" WHERE id = $1`, [a[0].workItemId])
    expect(works[0]).toMatchObject({ entityType: 'ADS_RULE', entityId: ids.a, source: 'SYSTEM', kind: 'ADVERTISING', status: 'PENDING', ownerId: admin.userId, sellerAccountId: storeA })
    expect(works[0].title).toContain('高 ACoS 暂停')
    expect(works[0].suggestedAction).toContain('ENABLED → PAUSED')
    expect((await rows(`SELECT 1 FROM "Notification" WHERE kind = 'ADS_RULE' AND "userId" = $1`, [admin.userId])).length).toBeGreaterThanOrEqual(1)

    const autoRuns = await runsOf(ids.auto)
    expect(autoRuns).toHaveLength(1)
    expect(autoRuns[0]).toMatchObject({ outcome: 'SUGGESTED', executed: false })
    expect(autoRuns[0].message).toContain('自动执行')
    expect((await runsOf(ids.target))[0]).toMatchObject({ entityKey: 'K1', actionType: 'ADJUST_BID', beforeValue: '1.50', afterValue: '1.20' })
    expect((await runsOf(ids.term))[0]).toMatchObject({ entityKey: 'c1|free yoga', actionType: 'NEGATE', afterValue: 'NEGATIVE_EXACT' })
    const limit = await runsOf(ids.limit)
    expect(limit.map(run => `${run.entityKey}:${run.outcome}`).sort()).toEqual(['cam-1:SUGGESTED', 'cam-2:SKIPPED'])
    expect(limit.find(run => run.outcome === 'SKIPPED')!.message).toContain('超过每日执行次数上限')
    expect(limit.find(run => run.outcome === 'SKIPPED')!.workItemId).toBeNull()

    const aAfter = await stamp(ids.a)
    expect(aAfter.version).toBe(aBefore.version)
    expect(aAfter.updatedAt.getTime()).toBe(aBefore.updatedAt.getTime())
    const view = (await detail(admin, ids.a)).rule
    expect(view).toMatchObject({ lastEvaluated: 3, lastMatched: 1 })
    expect(view.lastRunAt).toBeTruthy()
    // 店铺 B 的账户没有日指标：没评估，评估时间保持空
    expect((await detail(admin, ids.b)).rule.lastRunAt).toBeNull()
  })

  it('重复评估：没到期不再评估；到期但已有未处理的待办不重复生成；待办处理关闭后才会再次提醒；每日上限按 24 小时滚动；暂停的规则不评估', async () => {
    const first = await runScan()
    expect(first).toMatchObject({ rules: 0, suggested: 0, noData: 1 })
    // 到期：A 的 cam-1 还有未处理的待办 → 不重复；limit 规则隔了一天，上限重新计算，cam-2 轮到
    await h.client.query(`UPDATE "AdsAutomationRule" SET "lastRunAt" = now() - interval '25 hours'`)
    await h.client.query(`UPDATE "AdsAutomationRun" SET "runAt" = "runAt" - interval '25 hours'`)
    const second = await runScan()
    expect(second.errors).toEqual([])
    expect(second.suggested).toBe(1)
    expect((await runsOf(ids.a)).length).toBe(1)
    expect((await runsOf(ids.limit)).filter(run => run.outcome === 'SUGGESTED').map(run => run.entityKey)).toEqual(['cam-1', 'cam-2'])
    // 把 A 的待办关掉（已处理）→ 再次到期时重新提醒
    const workId = (await runsOf(ids.a))[0]!.workItemId
    await h.client.query(`UPDATE "WorkItem" SET status = 'CLOSED', "closedAt" = now(), "closeConclusion" = 'HANDLED' WHERE id = $1`, [workId])
    await h.client.query(`UPDATE "AdsAutomationRule" SET "lastRunAt" = now() - interval '25 hours'`)
    await h.client.query(`UPDATE "AdsAutomationRun" SET "runAt" = "runAt" - interval '25 hours'`)
    const third = await runScan()
    expect(third.suggested).toBeGreaterThanOrEqual(1)
    expect((await runsOf(ids.a)).filter(run => run.outcome === 'SUGGESTED')).toHaveLength(2)
    // 暂停的规则不评估
    expect((await patch(admin, ids.a, { version: (await rows<{ version: number }>(`SELECT version FROM "AdsAutomationRule" WHERE id = $1`, [ids.a]))[0]!.version, status: 'PAUSED' })).status).toBe(200)
    await h.client.query(`UPDATE "AdsAutomationRule" SET "lastRunAt" = now() - interval '25 hours'`)
    await runScan()
    expect((await runsOf(ids.a)).filter(run => run.outcome === 'SUGGESTED')).toHaveLength(2)
  })

  it('执行记录：最新在前、游标翻页（换规则的游标无效）；范围外与别的企业 404；没有记录是“尚无记录”', async () => {
    const page1 = await h.call(reader.token, 'GET', `/ads/rules/${ids.limit}/runs?pageSize=2`)
    expect(page1.status, JSON.stringify(page1.json)).toBe(200)
    expect(page1.json.data.items).toHaveLength(2)
    expect(page1.json.data.pageInfo).toMatchObject({ pageSize: 2, hasMore: true, approxTotal: 3 })
    const page2 = await h.call(reader.token, 'GET', `/ads/rules/${ids.limit}/runs?pageSize=2&cursor=${encodeURIComponent(page1.json.data.pageInfo.nextCursor)}`)
    expect(page2.json.data.items).toHaveLength(1)
    expect(page2.json.data.pageInfo.hasMore).toBe(false)
    const seen = [...page1.json.data.items, ...page2.json.data.items].map((item: { id: string }) => item.id)
    expect(new Set(seen).size).toBe(3)
    const times = page1.json.data.items.map((item: { runAt: string }) => item.runAt)
    expect([...times].sort().reverse()).toEqual(times)
    expect(page1.json.data.items[0]).toMatchObject({ actionType: 'PAUSE', executed: false })
    expect((await h.call(reader.token, 'GET', `/ads/rules/${ids.a}/runs?cursor=${encodeURIComponent(page1.json.data.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await h.call(scopedB.token, 'GET', `/ads/rules/${ids.limit}/runs`)).status).toBe(404)
    expect((await h.call(other.token, 'GET', `/ads/rules/${ids.limit}/runs`)).status).toBe(404)
    expect((await h.call(admin.token, 'GET', `/ads/rules/${ids.b}/runs`)).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('规则质量：最近一次评估的命中率；近 30 天执行记录；待办采纳率；没有真正执行过就没有效果（尚未接入）；有已执行动作时按前后 7 天对比', async () => {
    const quality = (await detail(admin, ids.a)).quality
    expect(quality.lastScan).toMatchObject({ evaluated: 3, matched: 1 })
    expect(quality.lastScan.hitRate).toBeCloseTo(1 / 3, 4)
    expect(quality.recent).toMatchObject({ runs: 2, suggested: 2, applied: 0, skipped: 0, failed: 0, objects: 1 })
    expect(quality.adoption).toMatchObject({ state: 'OK', open: 1, handled: 1, notNeeded: 0, falsePositive: 0, adoptionRate: 1 })
    expect(quality.effect).toMatchObject({ state: 'NOT_CONNECTED', samples: 0, before: null, after: null })
    expect((await detail(admin, ids.b)).quality).toMatchObject({ lastScan: { evaluated: null, matched: null, hitRate: null }, adoption: { state: 'NO_DATA', adoptionRate: null } })

    // 已执行的动作（P3-17 之后才会有，这里直接放一条）：10 天前对 cam-1 执行；前 7 天花 20 卖 20，后 7 天花 10 卖 20
    for (let offset = -17; offset <= -11; offset += 1) await summary(`eb-${offset}`, 'c1', offset, { spend: 20, sales: 20, clicks: 20, impressions: 1000, orders: 1 })
    for (const offset of [-9, -8]) await summary(`ea-${offset}`, 'c1', offset, { spend: 10, sales: 20, clicks: 20, impressions: 1000, orders: 2 })
    await insertRow(h.client, 'AdsAutomationRun', {
      id: 'run-applied',
      tenantId,
      ruleId: ids.a,
      ruleVersion: 1,
      entityKey: 'cam-1',
      actionType: 'PAUSE',
      executed: true,
      outcome: 'APPLIED',
      evidenceJson: JSON.stringify({}),
      runAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    })
    const after = (await detail(admin, ids.a)).quality
    expect(after.recent).toMatchObject({ applied: 1 })
    expect(after.effect).toMatchObject({ state: 'OK', samples: 1, windowDays: 7 })
    expect(after.effect.before).toMatchObject({ spend: 140, sales: 140, orders: 7 })
    expect(after.effect.after).toMatchObject({ spend: 70, sales: 140, orders: 14 })
    expect(after.effect.before.acos).toBeCloseTo(100, 1)
    expect(after.effect.after.acos).toBeCloseTo(50, 1)
    expect(after.effect.note).toContain('不代表因果')
  })

  it('表约束：枚举、版本、四块 JSON 必须是对象、评估统计成对且命中数不超过对象数、已执行必须是成功、证据是对象、同一规则同一对象同一时刻只有一条记录', async () => {
    const insert = (values: Record<string, unknown>) =>
      insertRow(h.client, 'AdsAutomationRule', {
        id: `chk-${Math.random().toString(36).slice(2)}`,
        tenantId,
        adsProfileId: 'ap-a',
        name: `约束-${Math.random()}`,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        ...values,
      })
    await expect(insert({ level: 'ADGROUP' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ mode: 'MANUAL' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ status: 'DELETED' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ frequency: 'HOURLY' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ version: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ scopeJson: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ conditionJson: JSON.stringify('x') })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ lastEvaluated: 1, lastMatched: 2 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ lastEvaluated: 1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ lastEvaluated: -1, lastMatched: -1 })).rejects.toMatchObject({ code: '23514' })
    const runValues = { tenantId, ruleId: ids.a, ruleVersion: 1, entityKey: 'chk', actionType: 'PAUSE', outcome: 'SKIPPED', evidenceJson: JSON.stringify({}), runAt: '2026-10-23T03:00:00Z' }
    await expect(insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r1', ...runValues, actionType: 'DELETE' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r2', ...runValues, outcome: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r3', ...runValues, executed: true, outcome: 'SUGGESTED' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r4', ...runValues, evidenceJson: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r5', ...runValues, ruleVersion: 0 })).rejects.toMatchObject({ code: '23514' })
    await insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r6', ...runValues })
    await expect(insertRow(h.client, 'AdsAutomationRun', { id: 'chk-r7', ...runValues })).rejects.toMatchObject({ code: '23505' })
  })

  it('回滚与重放：rollback.sql 删掉两张表，migration.sql 能重新建出来（行级安全与授权随之恢复）', async () => {
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('AdsAutomationRule', 'AdsAutomationRun')`)
    expect(gone[0]!.n).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    const back = await rows<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('AdsAutomationRule', 'AdsAutomationRun') ORDER BY relname`)
    expect(back).toEqual([
      { relname: 'AdsAutomationRule', relrowsecurity: true },
      { relname: 'AdsAutomationRun', relrowsecurity: true },
    ])
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "AdsAutomationRule"`))[0]!.n).toBe(0)
  })
})
