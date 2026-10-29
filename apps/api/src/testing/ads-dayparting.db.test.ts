import { gridIndexOf } from '@nova/api-contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 分时策略（P3-12，真实数据库 + 完整应用）：创建 / 修改（版本号乐观锁、重名、取值与作用对象校验）、审计、数据范围（经广告档案绑定的店铺）、
// 企业隔离、热力图（数据流已配置 / 没配置 / 没数据）、效果模拟（按星期 × 小时累计，只读）、执行记录，以及 DaypartingStrategy / DaypartingRun 的表约束。

type Member = { userId: string; token: string }
const HOUR = 3_600_000
const grid = (fill: number, patch: Record<number, number> = {}) => Array.from({ length: 168 }, (_, index) => patch[index] ?? fill)
const hourStart = (offsetHours: number) => new Date(Math.floor(Date.now() / HOUR) * HOUR + offsetHours * HOUR)
const cellOf = (at: Date) => {
  const day = (at.getUTCDay() + 6) % 7 // 周一为 0，与热力图一致
  return gridIndexOf(day, at.getUTCHours())
}

describe('分时策略（真实数据库）', () => {
  let h: DbTestApp
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

  const body = (patch: Record<string, unknown> = {}) => ({
    adsProfileId: 'ap-a',
    name: '夜间关停',
    kind: 'ON_OFF',
    level: 'CAMPAIGN',
    targetIds: ['cam-1'],
    grid: grid(1, { 0: 0 }),
    timezone: 'UTC',
    status: 'PAUSED',
    ...patch,
  })
  const create = (member: Member, patch: Record<string, unknown> = {}) => h.call(member.token, 'POST', '/ads/dayparting', { body: body(patch) })
  const list = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/ads/dayparting')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as Record<string, any>
  }
  const audits = async (action: string) =>
    (await h.client.query(`SELECT "resourceId", "beforeJson", "afterJson", result FROM "AuditEvent" WHERE action = $1 AND "tenantId" = $2 ORDER BY "occurredAt"`, [action, tenantId])).rows

  beforeAll(async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    h = await createDbTestApp({ database: 'ads_dayparting' })
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
    const campaign = (id: string, profile: string, external: string, tenant = tenantId) =>
      insertRow(h.client, 'AdsCampaign', {
        id,
        tenantId: tenant,
        adsProfileId: profile,
        adsAccountId: `ACC-${profile}`,
        externalCampaignId: external,
        adProduct: 'SPONSORED_PRODUCTS',
        name: `活动 ${id}`,
        state: 'ENABLED',
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      })
    await campaign('cam-1', 'ap-a', 'c1')
    await campaign('cam-2', 'ap-a', 'c2')
    await campaign('cam-b', 'ap-b', 'cb')
    await campaign('cam-o', 'ap-o', 'co', otherTenantId)
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

    const write = ['ads.read', 'ads.rule.write']
    admin = await h.createMember(tenantId, 'admin', write)
    scopedA = await h.createMember(tenantId, 'scopeda', write, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', write, { scopes: [{ sellerAccountId: storeB }] })
    reader = await h.createMember(tenantId, 'reader', ['ads.read'])
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', write)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('还没有策略：列表是“尚无记录”，执行记录也是“尚无记录”；有写权限的人 canWrite，只读的人不能；可选账户按数据范围', async () => {
    const data = await list(admin)
    expect(data.strategies).toMatchObject({ state: 'NO_DATA', items: [], truncated: false })
    expect(data.runs).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(data.canWrite).toBe(true)
    expect(data.execution.state).toBe('CONNECTED')
    expect(data.assumptions.length).toBeGreaterThan(0)
    expect((data.profiles as Array<{ id: string }>).map(p => p.id).sort()).toEqual(['ap-a', 'ap-b'])
    expect((await list(reader)).canWrite).toBe(false)
    expect(((await list(scopedA)).profiles as Array<{ id: string }>).map(p => p.id)).toEqual(['ap-a'])
    expect((await h.call(noAds.token, 'GET', '/ads/dayparting')).status).toBe(403)
  })

  it('创建：保存策略、写审计；返回对象名称、此刻应执行的值与版本 1；只改系统内数据', async () => {
    const res = await create(admin)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const row = res.json.data.strategy
    ids.main = row.id
    expect(row).toMatchObject({ name: '夜间关停', kind: 'ON_OFF', level: 'CAMPAIGN', status: 'PAUSED', timezone: 'UTC', version: 1, baseBid: null, accountName: 'P-A' })
    expect(row.targets).toEqual([{ id: 'cam-1', name: '活动 cam-1' }])
    expect(row.grid).toHaveLength(168)
    expect(row.due.label).toBeTruthy()
    const events = await audits('ADS_DAYPARTING_CREATED')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ resourceId: row.id, result: 'SUCCEEDED' })
    expect(events[0].afterJson).toMatchObject({ name: '夜间关停', kind: 'ON_OFF', targetCount: 1, version: 1 })
    // 审计里不存 168 个数
    expect(JSON.stringify(events[0].afterJson).length).toBeLessThan(800)
  })

  it('创建的校验：重名 409；别的账户、别的企业、范围外的广告账户与对象 404（整批不保存）；只读成员 403；取值不合法 422', async () => {
    const dup = await create(admin)
    expect(dup.status).toBe(409)
    expect(JSON.stringify(dup.json.error)).toContain('name')
    // 同名但在另一个广告账户里可以
    const second = await create(admin, { adsProfileId: 'ap-b', targetIds: ['cam-b'] })
    expect(second.status, JSON.stringify(second.json)).toBe(201)
    ids.b = second.json.data.strategy.id
    // 对象属于别的广告账户 / 别的企业 / 不存在：整批拒绝，什么也没保存
    expect((await create(admin, { name: 'x1', targetIds: ['cam-1', 'cam-b'] })).status).toBe(404)
    expect((await create(admin, { name: 'x2', targetIds: ['cam-o'] })).status).toBe(404)
    expect((await create(admin, { name: 'x3', targetIds: ['nope'] })).status).toBe(404)
    // 层级不匹配：活动编号当广告组用
    expect((await create(admin, { name: 'x4', level: 'AD_GROUP', targetIds: ['cam-1'] })).status).toBe(404)
    expect((await create(admin, { name: 'x5', adsProfileId: 'ap-o', targetIds: ['cam-o'] })).status).toBe(404)
    expect((await create(scopedA, { name: 'x6', adsProfileId: 'ap-b', targetIds: ['cam-b'] })).status).toBe(404)
    expect((await create(reader, { name: 'x7' })).status).toBe(403)
    expect((await create(admin, { name: 'x8', grid: grid(0.5) })).status).toBe(422)
    const count = await h.client.query(`SELECT count(*)::int AS n FROM "DaypartingStrategy" WHERE "tenantId" = $1`, [tenantId])
    expect(count.rows[0].n).toBe(2)
    // 别的企业的人看到的是自己的空列表
    expect((await list(other)).strategies).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('广告组层级与竞价倍率策略：倍率在 0.1 到 3 之间，基准竞价只属于倍率策略', async () => {
    const res = await create(admin, { name: '广告组倍率', kind: 'BID_MULTIPLIER', level: 'AD_GROUP', targetIds: ['ag-1'], grid: grid(1, { 5: 1.5, 6: 0.5 }), baseBid: 1.2 })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    ids.bid = res.json.data.strategy.id
    expect(res.json.data.strategy).toMatchObject({ kind: 'BID_MULTIPLIER', level: 'AD_GROUP', baseBid: 1.2 })
    expect(res.json.data.strategy.targets).toEqual([{ id: 'ag-1', name: '核心词组' }])
    expect((await create(admin, { name: '太大', kind: 'BID_MULTIPLIER', grid: grid(3.5) })).status).toBe(422)
    expect((await create(admin, { name: '太小', kind: 'BID_MULTIPLIER', grid: grid(0.05) })).status).toBe(422)
    expect((await create(admin, { name: '启停带基准', baseBid: 1 })).status).toBe(422)
  })

  it('修改：版本号对得上才改；改后版本 +1 并写审计（含修改前后）；旧版本 409', async () => {
    const before = await h.call(admin.token, 'PATCH', `/ads/dayparting/${ids.main}`, { body: { version: 1, name: '夜间关停（改）', status: 'ACTIVE', grid: grid(1, { 0: 0, 1: 0 }) } })
    expect(before.status, JSON.stringify(before.json)).toBe(200)
    expect(before.json.data.strategy).toMatchObject({ name: '夜间关停（改）', status: 'ACTIVE', version: 2 })
    const events = await audits('ADS_DAYPARTING_UPDATED')
    expect(events).toHaveLength(1)
    expect(events[0].beforeJson).toMatchObject({ name: '夜间关停', status: 'PAUSED', version: 1 })
    expect(events[0].afterJson).toMatchObject({ name: '夜间关停（改）', status: 'ACTIVE', version: 2 })
    const stale = await h.call(admin.token, 'PATCH', `/ads/dayparting/${ids.main}`, { body: { version: 1, name: '又改' } })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('CONFLICT')
    expect((await audits('ADS_DAYPARTING_UPDATED')).length).toBe(1)
  })

  it('修改的校验：按策略类型检查取值；启停不能带基准竞价；改名重名 409；作用对象整批校验；范围外与别的企业 404；只读 403', async () => {
    const path = (id: string) => `/ads/dayparting/${id}`
    const patch = (member: Member, id: string, payload: Record<string, unknown>) => h.call(member.token, 'PATCH', path(id), { body: payload })
    expect((await patch(admin, ids.main, { version: 2, grid: grid(0.5) })).status).toBe(422)
    expect((await patch(admin, ids.main, { version: 2, baseBid: 1.5 })).status).toBe(422)
    expect((await patch(admin, ids.bid, { version: 1, grid: grid(3.5) })).status).toBe(422)
    expect((await patch(admin, ids.bid, { version: 1, baseBid: 2.5 })).status).toBe(200)
    expect((await patch(admin, ids.bid, { version: 2, baseBid: null })).status).toBe(200)
    expect((await patch(admin, ids.main, { version: 2, name: '夜间关停' })).status).toBe(200) // 自己改回原来的名称不算重名
    expect((await patch(admin, ids.b, { version: 1, name: '夜间关停' })).status).toBe(200) // 别的账户下同名可以
    expect((await patch(admin, ids.main, { version: 3, targetIds: ['cam-1', 'cam-b'] })).status).toBe(404)
    expect((await patch(admin, ids.main, { version: 3, targetIds: ['cam-2'] })).status).toBe(200)
    expect((await patch(scopedB, ids.main, { version: 4, name: '偷改' })).status).toBe(404)
    expect((await patch(other, ids.main, { version: 4, name: '偷改' })).status).toBe(404)
    expect((await patch(reader, ids.main, { version: 4, name: '偷改' })).status).toBe(403)
    expect((await patch(admin, 'not-there', { version: 1, name: 'x' })).status).toBe(404)
    const row = (await h.client.query(`SELECT name, version, "scopeJson" FROM "DaypartingStrategy" WHERE id = $1`, [ids.main])).rows[0]
    expect(row).toMatchObject({ name: '夜间关停', version: 4, scopeJson: { ids: ['cam-2'] } })
  })

  it('数据范围：只看店铺 A 的成员看不到店铺 B 账户下的策略，反之亦然；别的企业看不到', async () => {
    expect(((await list(admin)).strategies.items as Array<{ id: string }>).map(item => item.id).sort()).toEqual([ids.main, ids.b, ids.bid].sort())
    expect(((await list(scopedA)).strategies.items as Array<{ id: string }>).map(item => item.id).sort()).toEqual([ids.main, ids.bid].sort())
    expect(((await list(scopedB)).strategies.items as Array<{ id: string }>).map(item => item.id)).toEqual([ids.b])
    expect((await list(other)).strategies.items).toEqual([])
  })

  it('热力图：数据流没配置是“尚未接入”；配置了但没有小时指标是“尚无记录”；有指标按星期 × 小时累计，只含美元的活动级数据', async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', '')
    expect((await list(admin)).heatmap).toMatchObject({ state: 'NOT_CONNECTED', cells: [] })
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    expect((await list(admin)).heatmap).toMatchObject({ state: 'NO_DATA', cells: [], historyDays: 14 })
    const hourly = (id: string, entity: string, at: Date, values: Record<string, unknown>, profile = 'ap-a', entityType = 'CAMPAIGN') =>
      insertRow(h.client, 'AdsPerformanceHourly', {
        id,
        tenantId,
        adsProfileId: profile,
        adsAccountId: `ACC-${profile}`,
        entityType,
        entityId: entity,
        hourStart: at.toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        ...values,
      })
    const first = hourStart(-24)
    const second = hourStart(-48)
    await hourly('hr-1', 'c1', first, { clicks: 10, spend: 4, sales: 20, orders: 2 })
    await hourly('hr-2', 'c1', second, { clicks: 20, spend: 6, sales: 30, orders: 3 })
    await hourly('hr-3', 'c2', first, { clicks: 5, spend: 1, sales: 0, orders: 0 })
    await hourly('hr-cad', 'c1', hourStart(-72), { clicks: 99, spend: 99, sales: 99, orders: 9, currency: 'CAD' })
    await hourly('hr-group', 'AG1', hourStart(-96), { clicks: 77, spend: 77, sales: 77, orders: 7 }, 'ap-a', 'AD_GROUP')
    await hourly('hr-b', 'cb', first, { clicks: 40, spend: 40, sales: 40, orders: 4 }, 'ap-b')
    const all = await list(admin)
    expect(all.heatmap.state).toBe('OK')
    const cell = (data: Record<string, any>, at: Date) => (data.heatmap.cells as Array<Record<string, any>>).find(c => c.weekday === (at.getUTCDay() + 6) % 7 && c.hour === at.getUTCHours())
    expect(cell(all, first)).toMatchObject({ clicks: 55, spend: 45, samples: 1 }) // c1 + c2 + 店铺 B 的 cb，同一个小时先合并成一条（samples 是小时数）
    expect(all.heatmap.cells).toHaveLength(2) // 加元与广告组级别的行不进热力图
    // 只看店铺 A：不含店铺 B 的行
    expect(cell(await list(scopedA), first)).toMatchObject({ clicks: 15, spend: 5 })
  })

  it('效果模拟：只看策略作用对象；启停格子关掉后估算只剩开着的格子；不写库', async () => {
    const first = hourStart(-24)
    const second = hourStart(-48)
    // 作用对象 c1：把“昨天这个小时”关掉
    const made = await create(admin, { name: '模拟用', targetIds: ['cam-1'], grid: grid(1, { [cellOf(first)]: 0 }) })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const before = (await h.client.query(`SELECT count(*)::int AS n FROM "DaypartingStrategy"`)).rows[0].n
    const res = await h.call(admin.token, 'POST', `/ads/dayparting/${made.json.data.strategy.id}/simulate`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const sim = res.json.data
    expect(sim).toMatchObject({ state: 'OK', coveredCells: 2, changedCells: 1, historyDays: 14 })
    expect(sim.baseline).toMatchObject({ clicks: 30, spend: 10, sales: 50, orders: 5 })
    expect(sim.estimated).toMatchObject({ clicks: 20, spend: 6, sales: 30, orders: 3 })
    expect(sim.assumptions.length).toBeGreaterThan(0)
    expect(cellOf(second)).not.toBe(cellOf(first))
    expect((await h.client.query(`SELECT count(*)::int AS n FROM "DaypartingStrategy"`)).rows[0].n).toBe(before)
    expect(await audits('ADS_DAYPARTING_SIMULATED')).toEqual([])
    // 倍率策略：昨天这个小时提高到 2 倍，估算的花费上升
    const bid = await create(admin, { name: '模拟倍率', kind: 'BID_MULTIPLIER', targetIds: ['cam-1'], grid: grid(1, { [cellOf(first)]: 2 }) })
    const up = (await h.call(admin.token, 'POST', `/ads/dayparting/${bid.json.data.strategy.id}/simulate`)).json.data
    expect(up.estimated.spend).toBeGreaterThan(up.baseline.spend)
  })

  it('效果模拟的边界：数据流没配置是“尚未接入”；对象没有小时指标是“尚无记录”；范围外与别的企业 404；没有 ads.read 403', async () => {
    await insertRow(h.client, 'AdsCampaign', {
      id: 'cam-quiet',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      externalCampaignId: 'cq',
      adProduct: 'SPONSORED_PRODUCTS',
      name: '没有小时指标的活动',
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    const quiet = await create(admin, { name: '没数据', targetIds: ['cam-quiet'] })
    const sim = (await h.call(admin.token, 'POST', `/ads/dayparting/${quiet.json.data.strategy.id}/simulate`)).json.data
    expect(sim).toMatchObject({ state: 'NO_DATA', baseline: null, estimated: null })
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', '')
    expect((await h.call(admin.token, 'POST', `/ads/dayparting/${ids.main}/simulate`)).json.data).toMatchObject({ state: 'NOT_CONNECTED', baseline: null })
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    expect((await h.call(scopedB.token, 'POST', `/ads/dayparting/${ids.main}/simulate`)).status).toBe(404)
    expect((await h.call(other.token, 'POST', `/ads/dayparting/${ids.main}/simulate`)).status).toBe(404)
    expect((await h.call(noAds.token, 'POST', `/ads/dayparting/${ids.main}/simulate`)).status).toBe(403)
    expect((await h.call(reader.token, 'POST', `/ads/dayparting/${ids.main}/simulate`)).status).toBe(200)
  })

  it('执行记录：有记录时按时间倒序列出并解析对象名称；范围外的策略的记录不可见', async () => {
    const run = (id: string, strategy: string, entity: string, at: string) =>
      insertRow(h.client, 'DaypartingRun', { id, tenantId, strategyId: strategy, entityId: entity, hour: 3, appliedMultiplier: 0, executed: false, outcome: 'SKIPPED', message: '未接入', runAt: at })
    await run('run-1', ids.main, 'cam-2', '2026-10-20T03:00:00Z')
    await run('run-2', ids.main, 'cam-2', '2026-10-21T03:00:00Z')
    await run('run-b', ids.b, 'cam-b', '2026-10-22T03:00:00Z')
    const data = await list(scopedA)
    expect(data.runs.state).toBe('OK')
    expect((data.runs.items as Array<{ id: string }>).map(item => item.id)).toEqual(['run-2', 'run-1'])
    expect(data.runs.items[0]).toMatchObject({ strategyName: '夜间关停', entityName: '活动 cam-2', executed: false, outcome: 'SKIPPED' })
    expect(((await list(scopedB)).runs.items as Array<{ id: string }>).map(item => item.id)).toEqual(['run-b'])
    expect((await list(other)).runs).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('表约束：类型、层级、状态、168 格、基准竞价只属于倍率策略、已执行必须是成功、小时 0 到 23、同一策略同一对象同一时刻只有一条记录', async () => {
    const insert = (values: Record<string, unknown>) =>
      insertRow(h.client, 'DaypartingStrategy', { id: `chk-${Math.random().toString(36).slice(2)}`, tenantId, adsProfileId: 'ap-a', name: `约束-${Math.random()}`, ...values })
    await expect(insert({ kind: 'SHIFT' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ targetLevel: 'TARGET' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ status: 'DELETED' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ hourlyMultipliersJson: JSON.stringify([1, 1]) })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ kind: 'ON_OFF', baseBid: 1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ kind: 'BID_MULTIPLIER', baseBid: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ version: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ scopeJson: JSON.stringify([]) })).rejects.toMatchObject({ code: '23514' })
    const runValues = { tenantId, strategyId: ids.main, entityId: 'cam-2', hour: 3, appliedMultiplier: 0, outcome: 'SKIPPED', runAt: '2026-10-23T03:00:00Z' }
    await expect(insertRow(h.client, 'DaypartingRun', { id: 'chk-r1', ...runValues, hour: 24 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'DaypartingRun', { id: 'chk-r2', ...runValues, executed: true })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(h.client, 'DaypartingRun', { id: 'chk-r3', ...runValues, outcome: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await insertRow(h.client, 'DaypartingRun', { id: 'chk-r4', ...runValues, executed: true, outcome: 'APPLIED' })
    await expect(insertRow(h.client, 'DaypartingRun', { id: 'chk-r5', ...runValues, executed: true, outcome: 'APPLIED' })).rejects.toMatchObject({ code: '23505' })
  })
})
