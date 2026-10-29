import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告新增分析与工具（P6-24，真实数据库 + 完整应用）：超预算时间条与归因窗口的计算、冲突判定（时间重叠、对象重叠、规则与分时策略）、
// 重复关键词判定、批量加词的预览前去重、幂等键重放、逐项写入记录与审计，以及数据范围与企业隔离。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const SWITCHES = ['sw.ads.negative', 'sw.ads.keyword']

describe('广告新增分析与工具（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeB: string
  let admin: Member
  let scopedB: Member
  let readOnly: Member
  let noAds: Member
  let other: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const count = async (table: string, where = 'TRUE', params: unknown[] = []) => ((await h.client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`, params)).rows[0] as { n: number }).n
  const bulk = (member: Member, body: Record<string, unknown>, idempotencyKey?: string) =>
    h.call(member.token, 'POST', '/ads/keywords/bulk-add', { body, ...(idempotencyKey ? { idempotencyKey } : {}) })

  const campaign = (id: string, profile: string, external: string, name: string, values: Record<string, unknown> = {}, tenant = tenantId) =>
    insertRow(h.client, 'AdsCampaign', {
      id,
      tenantId: tenant,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      externalCampaignId: external,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state: 'ENABLED',
      budget: 10,
      budgetType: 'DAILY',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  const group = (id: string, profile: string, adGroupId: string, campaignId: string, name: string) =>
    insertRow(h.client, 'AdsAdGroup', { id, tenantId, adsProfileId: profile, adsAccountId: `ACC-${profile}`, adGroupId, campaignId, name, state: 'ENABLED', sourceUpdatedAt: '2026-10-01T00:00:00Z' })
  const keyword = (id: string, profile: string, adGroupId: string, text: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsKeyword', {
      id,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      keywordId: `K-${id}`,
      campaignId: profile === 'ap-a' ? 'x-cam-1' : 'x-cam-b',
      adGroupId,
      text,
      matchType: 'EXACT',
      bid: 1,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  const hourly = (id: string, hourIso: string, spend: number, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsPerformanceHourly', {
      id,
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      entityType: 'CAMPAIGN',
      entityId: 'x-cam-1',
      hourStart: hourIso,
      impressions: 100,
      clicks: 5,
      spend,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const strategy = (id: string, cell: number, value: number, targets: string[]) =>
    insertRow(h.client, 'DaypartingStrategy', {
      id,
      tenantId,
      adsProfileId: 'ap-a',
      name: `策略 ${id}`,
      kind: 'ON_OFF',
      targetLevel: 'CAMPAIGN',
      scopeJson: JSON.stringify({ ids: targets }),
      hourlyMultipliersJson: JSON.stringify(Array.from({ length: 168 }, (_, index) => (index === cell ? value : 1))),
      timezone: 'UTC',
      status: 'ACTIVE',
      createdBy: admin.userId,
      updatedBy: admin.userId,
    })
  const rule = (id: string, profile: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsAutomationRule', {
      id,
      tenantId,
      adsProfileId: profile,
      name: `规则 ${id}`,
      level: 'CAMPAIGN',
      mode: 'AUTO',
      status: 'ACTIVE',
      frequency: 'DAILY',
      scopeJson: JSON.stringify({ campaignIds: [] }),
      conditionJson: JSON.stringify({ conditions: [{ metric: 'spend', op: 'GT', value: 1, windowDays: 7 }], textFilters: [] }),
      actionJson: JSON.stringify({ type: 'PAUSE' }),
      guardrailJson: JSON.stringify({ minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 10 }),
      createdBy: admin.userId,
      updatedBy: admin.userId,
      ...values,
    })

  beforeAll(async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    h = await createDbTestApp({ database: 'ads_tools' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    const profiles: Array<[string, string, string, string]> = [
      ['ap-a', 'P-A', a.sellerAccountId, tenantId],
      ['ap-b', 'P-B', storeB, tenantId],
      ['ap-o', 'P-O', b.sellerAccountId, otherTenantId],
    ]
    for (const [id, profileId, store, tenant] of profiles) {
      await insertRow(h.client, 'AdsProfile', { id, tenantId: tenant, profileId, sellerAccountId: store, bindingStatus: 'MANUAL', adsAccountId: `ACC-${id}` })
      await insertRow(h.client, 'AdsAccount', { id: `acct-${id}`, tenantId: tenant, adsProfileId: id, adsAccountId: `ACC-${id}`, name: id })
    }
    await campaign('cam-1', 'ap-a', 'x-cam-1', '活动一')
    await campaign('cam-2', 'ap-a', 'x-cam-2', '活动二')
    await campaign('cam-3', 'ap-a', 'x-cam-3', '活动三')
    await campaign('cam-b', 'ap-b', 'x-cam-b', '店铺 B 活动')
    await campaign('cam-o', 'ap-o', 'x-cam-o', '别的企业活动', {}, otherTenantId)
    await group('ag-1', 'ap-a', 'AG1', 'x-cam-1', '广告组一')
    await group('ag-2', 'ap-a', 'AG2', 'x-cam-1', '广告组二')
    await group('ag-b', 'ap-b', 'AGB', 'x-cam-b', '店铺 B 广告组')
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    for (const key of SWITCHES) await insertRow(h.client, 'IntegrationSwitch', { id: `sw-${key}`, tenantId, switchKey: key, enabled: true })

    admin = await h.createMember(tenantId, 'admin', ['ads.read', 'ads.keyword.write', 'ads.negative.write'])
    scopedB = await h.createMember(tenantId, 'scopedb', ['ads.read', 'ads.keyword.write'], { scopes: [{ sellerAccountId: storeB }] })
    readOnly = await h.createMember(tenantId, 'readonly', ['ads.read'])
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', ['ads.read', 'ads.keyword.write'])
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('超预算时间条：累计花费超过日预算的第一个小时起算，并给预算内活跃时长与平均超预算时长；别的日子没有记录就是空', async () => {
    const day = dayText(-2)
    await hourly('hr-1', `${day}T08:00:00Z`, 4)
    await hourly('hr-2', `${day}T09:00:00Z`, 4)
    await hourly('hr-3', `${day}T10:00:00Z`, 3)
    await hourly('hr-cad', `${day}T11:00:00Z`, 500, { currency: 'CAD' })
    await hourly('hr-other', `${day}T12:00:00Z`, 500, { entityId: 'x-cam-2' })
    const data = await get(admin, `/ads/campaigns/cam-1/budget-timeline?from=${day}&to=${dayText(-1)}`)
    expect(data).toMatchObject({ state: 'OK', zone: 'UTC', currency: 'USD', budget: 10, historyDays: 14, defaultWindow: 7, averageOverBudgetHours: 14 })
    expect(data.days).toHaveLength(2)
    expect(data.days[0]).toMatchObject({ date: day, spend: 11, exceededAtHour: 10, overBudgetHours: 14, activeHours: 3, activeHoursWithinBudget: 2, hoursRecorded: 3 })
    expect(data.days[0].hours[10]).toMatchObject({ spend: 3, cumulative: 11, over: true })
    expect(data.days[1]).toMatchObject({ spend: null, hoursRecorded: 0, overBudgetHours: 0 })
    expect(data.precisionNote).toContain('精度说明')
  })

  it('超预算时间条：数据流没配置是 NOT_CONNECTED；预算是 LIFETIME 只显示花费；范围倒置或超过 14 天 422；范围外与别的企业的活动 404', async () => {
    const day = dayText(-2)
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', '')
    expect(await get(admin, `/ads/campaigns/cam-1/budget-timeline?from=${day}&to=${day}`)).toMatchObject({ state: 'NOT_CONNECTED', days: [] })
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    await h.client.query(`UPDATE "AdsCampaign" SET "budgetType" = 'LIFETIME' WHERE id = 'cam-1'`)
    const lifetime = await get(admin, `/ads/campaigns/cam-1/budget-timeline?from=${day}&to=${day}`)
    await h.client.query(`UPDATE "AdsCampaign" SET "budgetType" = 'DAILY' WHERE id = 'cam-1'`)
    expect(lifetime).toMatchObject({ budget: null })
    expect(lifetime.days[0]).toMatchObject({ spend: 11, exceededAtHour: null, overBudgetHours: null })
    await get(admin, `/ads/campaigns/cam-1/budget-timeline?from=${dayText(-30)}&to=${day}`, 422)
    await get(admin, `/ads/campaigns/cam-1/budget-timeline?from=${dayText(-1)}&to=${day}`, 422)
    await get(scopedB, '/ads/campaigns/cam-1/budget-timeline', 404)
    await get(other, '/ads/campaigns/cam-1/budget-timeline', 404)
    await get(admin, '/ads/campaigns/cam-o/budget-timeline', 404)
    await get(noAds, '/ads/campaigns/cam-1/budget-timeline', 403)
    expect(await get(scopedB, '/ads/campaigns/cam-b/budget-timeline')).toMatchObject({ state: 'NO_DATA', days: [] })
  })

  it('归因窗口：报告行带哪个窗口的列哪个才可用；缺一天的窗口置灰并写明覆盖几天', async () => {
    const metric = (id: string, date: string, raw: Record<string, unknown>) =>
      insertRow(h.client, 'AdsMetric', {
        id,
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        sourceUpdatedAt: new Date().toISOString(),
        reportDate: date,
        adProduct: 'SPONSORED_PRODUCTS',
        entityType: 'CAMPAIGN',
        entityId: 'x-cam-1',
        externalCampaignId: 'x-cam-1',
        raw: JSON.stringify(raw),
      })
    await metric('am-1', dayText(-3), { sales7d: 12.5, purchases7d: 2, sales14d: 20, purchases14d: 3 })
    await metric('am-2', dayText(-2), { sales7d: 7.5, purchases7d: 1 })
    const data = await get(admin, `/ads/campaigns/cam-1/budget-timeline?from=${dayText(-3)}&to=${dayText(-2)}`)
    const view = (window: number) => data.windows.find((item: { window: number }) => item.window === window)
    expect(view(7)).toMatchObject({ available: true, sales: 20, orders: 3, coveredDays: 2, totalDays: 2 })
    expect(view(14)).toMatchObject({ available: false, sales: null, coveredDays: 1, totalDays: 2 })
    expect(view(14).reason).toContain('sales14d')
    expect(view(1)).toMatchObject({ available: false })
    expect(view(30)).toMatchObject({ available: false })
  })

  it('冲突：分时策略取值不同才冲突、编号大的生效；自动规则覆盖本账户全部活动且被分时策略覆盖；建议模式与已暂停的规则不参与', async () => {
    await strategy('s-1', 5, 0, ['cam-1', 'cam-2'])
    await strategy('s-2', 5, 1, ['cam-1'])
    await strategy('s-3', 9, 0, ['cam-2']) // 与 s-1 在第 5、9 两格取值不同，cam-2 上重叠 2 小时
    await rule('r-1', 'ap-a')
    await rule('r-suggest', 'ap-a', { mode: 'SUGGEST' })
    await rule('r-paused', 'ap-a', { status: 'PAUSED' })
    await rule('r-b', 'ap-b')
    const all = await get(admin, '/ads/conflicts')
    expect(all).toMatchObject({ state: 'OK', truncated: false })
    const keys = (all.items as Array<{ key: string }>).map(item => item.key)
    expect(keys).toHaveLength(2)
    const cam1 = (all.items as Array<Record<string, any>>).find(item => item.objectId === 'cam-1')!
    expect(cam1).toMatchObject({ kind: 'RULE_VS_DAYPARTING', objectName: '活动一', overlapHours: 1 })
    expect(cam1.parties.map((party: { id: string; effective: boolean }) => [party.id, party.effective])).toEqual([
      ['s-1', false],
      ['s-2', true],
      ['r-1', false],
    ])
    expect(all.counts['r-1']).toBeGreaterThanOrEqual(2)
    expect(all.counts['r-suggest']).toBeUndefined()
    expect(all.counts['r-paused']).toBeUndefined()
    // 规则 r-b 在店铺 B 的活动上只有它自己，没有冲突
    expect(all.items.map((item: { objectId: string }) => item.objectId).sort()).toEqual(['cam-1', 'cam-2'])
    expect((await get(admin, '/ads/conflicts?kind=RULE_OVERLAP')).total).toBe(0)
    expect((await get(admin, `/ads/conflicts?q=${encodeURIComponent('活动一')}`)).total).toBe(1)
    const page = await get(admin, '/ads/conflicts?pageSize=1')
    expect(page.items).toHaveLength(1)
    expect(page.pageInfo.hasMore).toBe(true)
    await get(admin, '/ads/conflicts?pageSize=0', 422)
  })

  it('冲突：两条自动规则改同一活动状态也算，编号大的生效；范围只看到自己的活动；别的企业与无权限', async () => {
    await rule('r-2', 'ap-a', { actionJson: JSON.stringify({ type: 'ENABLE' }) })
    const all = await get(admin, '/ads/conflicts?kind=RULE_OVERLAP')
    expect(all.total).toBeGreaterThanOrEqual(1)
    const overlap = (all.items as Array<Record<string, any>>)[0]!
    expect(overlap.parties.map((party: { id: string; effective: boolean }) => [party.id, party.effective])).toEqual([
      ['r-1', false],
      ['r-2', true],
    ])
    // 店铺 B 的范围里：规则 r-b 只有一条，分时策略不在 B，没有冲突
    expect((await get(scopedB, '/ads/conflicts')).items).toEqual([])
    expect((await get(other, '/ads/conflicts')).items).toEqual([])
    await get(noAds, '/ads/conflicts', 403)
    await get(noAds, '/ads/conflicts?pageSize=0', 403)
  })

  it('重复关键词：同账户同词同匹配方式在多个广告组才算；不分大小写；已归档的、同一广告组里的、别的账户与别的匹配方式都不算', async () => {
    await keyword('k-1', 'ap-a', 'AG1', 'Yoga Mat')
    await keyword('k-2', 'ap-a', 'AG2', ' yoga  mat ')
    await keyword('k-3', 'ap-a', 'AG2', 'yoga mat', { matchType: 'PHRASE' })
    await keyword('k-4', 'ap-a', 'AG1', 'yoga mat', { matchType: 'BROAD', state: 'ARCHIVED' })
    await keyword('k-5', 'ap-a', 'AG2', 'yoga mat', { matchType: 'BROAD' })
    await keyword('k-6', 'ap-b', 'AGB', 'yoga mat')
    await keyword('k-7', 'ap-a', 'AG1', 'solo')
    await keyword('k-8', 'ap-a', 'AG1', 'solo', { keywordId: 'K-8' })
    const data = await get(admin, '/ads/duplicate-keywords')
    expect(data).toMatchObject({ state: 'OK', total: 1, truncated: false })
    expect(data.items[0]).toMatchObject({ text: 'yoga mat', matchType: 'EXACT', matchLabel: '精确匹配', adGroupCount: 2 })
    expect(data.items[0].locations).toEqual([
      expect.objectContaining({ keywordId: 'k-1', adGroupId: 'ag-1', adGroupName: '广告组一', campaignId: 'cam-1', campaignName: '活动一', bid: 1 }),
      expect.objectContaining({ keywordId: 'k-2', adGroupId: 'ag-2', adGroupName: '广告组二' }),
    ])
    expect((await get(admin, '/ads/duplicate-keywords?matchType=BROAD')).items).toEqual([])
    expect((await get(admin, '/ads/duplicate-keywords?q=zzz')).items).toEqual([])
    expect((await get(scopedB, '/ads/duplicate-keywords')).items).toEqual([])
    expect((await get(other, '/ads/duplicate-keywords')).state).toBe('NOT_CONNECTED')
    await get(noAds, '/ads/duplicate-keywords', 403)
    await get(admin, '/ads/duplicate-keywords?matchType=NOPE', 422)
  })

  it('批量加词：已有词与批内重复词被跳过并说明；其余每项一条写入记录与同步任务；审计带来源；整批全有或全无', async () => {
    const before = [await count('AdsWriteRun'), await count('SyncJob', `type = 'ADS_WRITE'`)]
    const res = await bulk(admin, {
      mode: 'KEYWORD',
      entityId: 'ag-1',
      source: 'BRAND_SEARCH_TERM',
      items: [
        { text: 'YOGA MAT', matchType: 'EXACT' },
        { text: 'pilates ring', matchType: 'PHRASE', amount: 0.75 },
        { text: 'Pilates  Ring', matchType: 'PHRASE' },
        { text: 'foam roller', matchType: 'BROAD' },
      ],
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'QUEUED', requested: 4 })
    expect(res.json.data.runs.map((run: { after: string }) => run.after)).toEqual(['pilates ring（PHRASE）', 'foam roller（BROAD）'])
    expect(res.json.data.skipped.map((item: { index: number }) => item.index)).toEqual([0, 2])
    expect(await count('AdsWriteRun')).toBe(before[0]! + 2)
    expect(await count('SyncJob', `type = 'ADS_WRITE'`)).toBe(before[1]! + 2)
    const run = (await h.client.query(`SELECT * FROM "AdsWriteRun" WHERE "afterValue" = 'pilates ring（PHRASE）'`)).rows[0]
    expect(run).toMatchObject({ kind: 'KEYWORD_ADD', source: 'MANUAL', entityId: 'ag-1', externalId: 'AG1', entityType: 'AD_GROUP', status: 'PENDING', requestedBy: admin.userId })
    expect(run.requestJson).toMatchObject({ text: 'pilates ring', matchType: 'PHRASE', amount: 0.75 })
    const audit = (await h.client.query(`SELECT * FROM "AuditEvent" WHERE action = 'ADS_WRITE_SUBMITTED' AND "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [tenantId])).rows[0]
    expect(JSON.stringify(audit)).toContain('BRAND_SEARCH_TERM')
    // 词在匹配方式和模式对不上时整批 422，不留下任何写入记录
    const bad = await bulk(admin, {
      mode: 'KEYWORD',
      entityId: 'ag-1',
      items: [
        { text: 'ok one', matchType: 'EXACT' },
        { text: 'bad one', matchType: 'NEGATIVE_EXACT' },
      ],
    })
    expect(bad.status).toBe(422)
    expect(await count('AdsWriteRun')).toBe(before[0]! + 2)
  })

  it('批量加词：同一个幂等键重放不会重复写入；全部已存在时不提交；权限、范围与开关', async () => {
    const body = { mode: 'KEYWORD', entityId: 'ag-2', items: [{ text: 'resistance band', matchType: 'EXACT' }] }
    const first = await bulk(admin, body, 'idem-bulk-1')
    expect(first.status, JSON.stringify(first.json)).toBe(200)
    const runs = await count('AdsWriteRun')
    const replay = await bulk(admin, body, 'idem-bulk-1')
    expect(replay.status).toBe(200)
    expect(replay.json.data.runs.map((run: { id: string }) => run.id)).toEqual(first.json.data.runs.map((run: { id: string }) => run.id))
    expect(await count('AdsWriteRun')).toBe(runs)
    const none = await bulk(admin, { mode: 'KEYWORD', entityId: 'ag-1', items: [{ text: 'solo', matchType: 'EXACT' }] })
    expect(none.json.data).toMatchObject({ state: 'NOTHING_TO_ADD', runs: [] })
    expect(await count('AdsWriteRun')).toBe(runs)
    // 权限：只读 403；没有这类写入权限的人加否定也 403；范围外与别的企业的广告组 404
    expect((await bulk(readOnly, body)).status).toBe(403)
    expect((await bulk(scopedB, { mode: 'NEGATIVE', entityId: 'ag-b', level: 'AD_GROUP', items: [{ text: 'x', matchType: 'NEGATIVE_EXACT' }] })).status).toBe(403)
    expect((await bulk(scopedB, body)).status).toBe(404)
    expect((await bulk(other, body)).status).toBe(404)
    expect((await bulk(noAds, body)).status).toBe(403)
    // 否定投放加到活动：开关关闭 409，整批不写
    const negative = { mode: 'NEGATIVE', entityId: 'cam-1', level: 'CAMPAIGN', items: [{ text: 'free', matchType: 'NEGATIVE_EXACT' }] }
    await h.client.query(`UPDATE "IntegrationSwitch" SET enabled = false WHERE "tenantId" = $1`, [tenantId])
    const blocked = await bulk(admin, negative)
    expect(blocked.status).toBe(409)
    expect(await count('AdsWriteRun')).toBe(runs)
    await h.client.query(`UPDATE "IntegrationSwitch" SET enabled = true WHERE "tenantId" = $1`, [tenantId])
    const ok = await bulk(admin, negative)
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.data.runs[0]).toMatchObject({ kind: 'NEGATIVE_ADD', entityType: 'CAMPAIGN' })
  })
})
