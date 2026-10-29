import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告组合与预算（P3-11，真实数据库 + 完整应用）：预算节奏（指定日期范围周期、实际累计只用美元活动级日汇总、理想累计按天均摊）、
// 偏快 / 偏慢 / 正常 / 没有预算 / 周期不认识 / 非美元各自的判断、组合与活动按“广告档案 + 组合编号”归属（别的档案同编号的活动不串）、
// 数据范围（经广告档案绑定的店铺，未绑定账户只有“全部店铺”成员可见）、企业隔离、筛选排序翻页与游标绑定条件、
// 详情（曲线、调整建议、活动预算分配、预算规则功能开关）与 AdsBudgetRule、AdsPortfolio 的表约束。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const RANGE = `from=${dayText(-30)}&to=${dayText(-1)}`

describe('广告组合与预算（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let noAds: Member
  let other: Member
  let empty: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const idsOf = (data: Record<string, any>) => (data.items as Array<{ id: string }>).map(item => item.id)
  const rowOf = (data: Record<string, any>, id: string) => (data.items as Array<Record<string, any>>).find(item => item.id === id)!

  const account = (profile: string, tenant: string) =>
    insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })
  const portfolio = (id: string, profile: string, portfolioId: string, name: string, values: Record<string, unknown> = {}, tenant = tenantId) =>
    insertRow(h.client, 'AdsPortfolio', {
      id,
      tenantId: tenant,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      portfolioId,
      name,
      status: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  const campaign = (id: string, profile: string, external: string, name: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsCampaign', {
      id,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      externalCampaignId: external,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  let seq = 0
  const spend = (profile: string, external: string, offset: number, amount: number | null, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsDailySummary', {
      id: `sum-${++seq}`,
      tenantId,
      adsProfileId: profile,
      adProduct: 'SPONSORED_PRODUCTS',
      campaignId: external,
      summaryDate: dayText(offset),
      spend: amount,
      sales: amount === null ? null : amount * 4,
      impressions: 1000,
      clicks: 20,
      orders: 2,
      metricVersion: 'ads.v1',
      ...values,
    })

  // 预算周期统一取“今天前 9 天起、共 30 天”：昨天为止走完 9 天，理想累计 = 上限 × 9 / 30（没有历史节奏时按天均摊）
  const WINDOW = { budgetPeriod: 'DATE_RANGE', budgetStart: dayText(-9), budgetEnd: dayText(20) }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_portfolios' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    const c = await h.createTenant('c')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-free', tenantId, profileId: 'P-F' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-o', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    for (const profile of ['ap-a', 'ap-b', 'ap-free']) await account(profile, tenantId)
    await account('ap-o', otherTenantId)

    // 组合：偏快、偏慢、正常、无预算（未绑定账户）、加元、按月循环、周期不认识、别的企业
    await portfolio('pf-ahead', 'ap-a', 'PF1', '春季组合', { ...WINDOW, budgetCap: 300, spent: 7 })
    await portfolio('pf-behind', 'ap-a', 'PF2', '夏季组合', { ...WINDOW, budgetCap: 300 })
    await portfolio('pf-on', 'ap-b', 'PF3', '店铺B组合', { ...WINDOW, budgetCap: 300 })
    await portfolio('pf-free', 'ap-free', 'PF4', '无预算组合')
    await portfolio('pf-cad', 'ap-a', 'PF5', '加元组合', { ...WINDOW, budgetCap: 100, currency: 'CAD', spent: 20 })
    await portfolio('pf-month', 'ap-a', 'PF6', '月度组合', { budgetPeriod: 'MONTHLY' })
    await portfolio('pf-unknown', 'ap-a', 'PF7', '日循环组合', { budgetPeriod: 'DAILY', budgetCap: 50, spent: 12 })
    await portfolio('pf-o', 'ap-o', 'PFO', '别家组合', { ...WINDOW, budgetCap: 10 }, otherTenantId)

    // 活动：c1 启用、日预算 50；c2 暂停、日预算 30；c4 日预算 20；c5 属于店铺 B；cb1 在店铺 B 档案里也叫组合 PF1（不能串到 pf-ahead）；c3 没有组合
    await campaign('cam-1', 'ap-a', 'c1', '春季推广', { budget: 50, budgetType: 'DAILY', portfolioId: 'PF1' })
    await campaign('cam-2', 'ap-a', 'c2', '春季暂停', { budget: 30, budgetType: 'DAILY', portfolioId: 'PF1', state: 'PAUSED' })
    await campaign('cam-4', 'ap-a', 'c4', '夏季推广', { budget: 20, budgetType: 'DAILY', portfolioId: 'PF2' })
    await campaign('cam-5', 'ap-b', 'c5', '店铺B推广', { budget: 40, budgetType: 'DAILY', portfolioId: 'PF3' })
    await campaign('cam-b1', 'ap-b', 'cb1', '另一档案同编号', { budget: 99, budgetType: 'DAILY', portfolioId: 'PF1' })
    await campaign('cam-3', 'ap-a', 'c3', '没有组合的活动', { budget: 10, budgetType: 'DAILY' })
    await campaign('cam-cad', 'ap-a', 'ccad', '加元推广', { budget: 10, budgetType: 'DAILY', portfolioId: 'PF5', currency: 'CAD' })

    // 逐日花费：pf-ahead 共 135（c1 近 9 天每天 10，c2 昨天 45）；pf-behind 45；pf-on 90；没有组合的 c3 与别档案的 cb1 花得很多但不能计入
    for (let offset = -9; offset <= -1; offset += 1) await spend('ap-a', 'c1', offset, 10)
    await spend('ap-a', 'c2', -1, 45)
    await spend('ap-a', 'c4', -1, 45)
    for (let offset = -9; offset <= -1; offset += 1) await spend('ap-b', 'c5', offset, 10)
    await spend('ap-a', 'c3', -1, 999)
    await spend('ap-b', 'cb1', -1, 500)
    // 不并入：花费为空的行与加元的行
    await spend('ap-a', 'c1', -2, null, { currency: 'CAD' })
    await spend('ap-a', 'ccad', -1, 77, { currency: 'CAD' })

    // 预算规则：只为 pf-ahead 的活动 c1 放一条
    await insertRow(h.client, 'AdsBudgetRule', {
      id: 'rule-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      campaignId: 'c1',
      ruleType: 'SCHEDULE',
      paramsJson: JSON.stringify({ name: '黑五', startDate: '2026-11-27', endDate: '2026-11-30', increase: 0.5 }),
      status: 'ACTIVE',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })

    const read = ['ads.read']
    admin = await h.createMember(tenantId, 'admin', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', read, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', read)
    empty = await h.createMember(c.tenantId, 'empty', read)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('没有 ads.read 返回 403；全部店铺成员看到本企业全部组合，别的企业的数据看不到', async () => {
    expect((await h.call(noAds.token, 'GET', '/ads/portfolios')).status).toBe(403)
    expect((await h.call(noAds.token, 'GET', '/ads/portfolios/pf-ahead')).status).toBe(403)
    const data = await get(admin, `/ads/portfolios?${RANGE}&sort=name:asc`)
    expect(data.state).toBe('OK')
    expect([...idsOf(data)].sort()).toEqual(['pf-ahead', 'pf-behind', 'pf-cad', 'pf-free', 'pf-month', 'pf-on', 'pf-unknown'])
    expect(idsOf(await get(other, '/ads/portfolios'))).toEqual(['pf-o'])
    expect(await get(empty, '/ads/portfolios')).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
  })

  it('偏快：昨天为止走完 9 天，实际 135 对理想 90，比值 1.5；实际只合计本档案本组合下的美元活动，别的组合与别的档案同编号的活动不串', async () => {
    const row = rowOf(await get(admin, `/ads/portfolios?${RANGE}`), 'pf-ahead')
    expect(row).toMatchObject({
      name: '春季组合',
      spent: 135,
      spentSource: 'REPORTS',
      reportedSpent: 7,
      budget: { cap: 300, kind: 'DATE_RANGE', from: dayText(-9), to: dayText(20) },
      campaigns: { total: 2, enabled: 1 },
      pace: { state: 'OK', verdict: 'AHEAD', elapsedDays: 9, totalDays: 30, idealSpent: 90, shape: 'LINEAR', capReached: false },
      totals: { spend: 135, sales: 540 },
    })
    expect(row.pace.ratio).toBeCloseTo(1.5)
    expect(row.accountName).toBe('P-A')
  })

  it('偏慢、正常、没有预算、周期不认识、非美元、按月循环各自的判断；没有来源的值是空而不是 0', async () => {
    const data = await get(admin, `/ads/portfolios?${RANGE}`)
    expect(rowOf(data, 'pf-behind').pace).toMatchObject({ verdict: 'BEHIND', idealSpent: 90, spent: 45 })
    expect(rowOf(data, 'pf-on').pace).toMatchObject({ verdict: 'ON_TRACK', spent: 90 })
    expect(rowOf(data, 'pf-free')).toMatchObject({ pace: { state: 'NO_BUDGET', verdict: null }, budget: { cap: null }, totals: null, campaigns: { total: 0, enabled: 0 }, accountName: 'P-F' })
    // 周期是 DAILY 不认识：不猜，已用金额退回亚马逊同步来的数
    expect(rowOf(data, 'pf-unknown')).toMatchObject({ pace: { state: 'UNKNOWN_PERIOD', verdict: null }, budget: { kind: 'UNKNOWN', from: null }, spent: 12, spentSource: 'PORTFOLIO' })
    // 加元组合：不用日汇总、不给指标、不折算
    expect(rowOf(data, 'pf-cad')).toMatchObject({ pace: { state: 'OTHER_CURRENCY' }, spent: 20, spentSource: 'PORTFOLIO', totals: null, ratios: null, currency: 'CAD' })
    // 按月循环：窗口是“今天”所在的自然月
    expect(rowOf(data, 'pf-month').budget).toMatchObject({ kind: 'MONTHLY', from: `${dayText(0).slice(0, 7)}-01` })
    expect(data.summary).toMatchObject({ portfolios: 7, ahead: 1, onTrack: 1, behind: 1 })
    expect(data.write.state).toBe('NOT_CONNECTED')
  })

  it('数据范围：只看店铺 A 的成员看不到店铺 B 与未绑定账户的组合；只看店铺 B 的成员只看到店铺 B；主动收窄也拿不到范围外的', async () => {
    expect([...idsOf(await get(scopedA, '/ads/portfolios'))].sort()).toEqual(['pf-ahead', 'pf-behind', 'pf-cad', 'pf-month', 'pf-unknown'])
    expect(idsOf(await get(scopedB, '/ads/portfolios'))).toEqual(['pf-on'])
    expect(idsOf(await get(admin, `/ads/portfolios?storeIds=${storeB}`))).toEqual(['pf-on'])
    expect((await h.call(scopedA.token, 'GET', `/ads/portfolios?storeIds=${storeB}`)).status).toBe(403)
  })

  it('筛选：节奏判断与名称关键字；汇总跟着筛选走；没有匹配是“尚无记录”并说明是被筛掉了', async () => {
    const ahead = await get(admin, `/ads/portfolios?${RANGE}&pace=AHEAD`)
    expect(idsOf(ahead)).toEqual(['pf-ahead'])
    expect(ahead.summary).toMatchObject({ portfolios: 1, ahead: 1, behind: 0, cap: 300, spent: 135 })
    expect(idsOf(await get(admin, `/ads/portfolios?q=${encodeURIComponent('夏季')}`))).toEqual(['pf-behind'])
    const none = await get(admin, '/ads/portfolios?q=nothing-like-this')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(none.note).toContain('没有符合筛选条件')
  })

  it('排序：空值永远在最后（升降序都一样）；按节奏比值排', async () => {
    const desc = idsOf(await get(admin, `/ads/portfolios?${RANGE}&sort=paceRatio:desc`))
    const asc = idsOf(await get(admin, `/ads/portfolios?${RANGE}&sort=paceRatio:asc`))
    expect(desc.slice(0, 3)).toEqual(['pf-ahead', 'pf-on', 'pf-behind'])
    expect(asc.slice(0, 3)).toEqual(['pf-behind', 'pf-on', 'pf-ahead'])
    expect(desc).toHaveLength(7)
    const spendDesc = idsOf(await get(admin, `/ads/portfolios?${RANGE}&sort=spend:desc`))
    expect(spendDesc[0]).toBe('pf-ahead')
  })

  it('翻页：游标带出下一页；换了筛选条件的旧游标返回 400；每页条数不合法返回 422', async () => {
    const first = await get(admin, `/ads/portfolios?${RANGE}&sort=name:asc&pageSize=3`)
    expect(idsOf(first)).toHaveLength(3)
    expect(first.pageInfo).toMatchObject({ hasMore: true })
    const second = await get(admin, `/ads/portfolios?${RANGE}&sort=name:asc&pageSize=3&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
    const third = await get(admin, `/ads/portfolios?${RANGE}&sort=name:asc&pageSize=3&cursor=${encodeURIComponent(second.pageInfo.nextCursor)}`)
    const all = [...idsOf(first), ...idsOf(second), ...idsOf(third)]
    expect(new Set(all).size).toBe(7)
    expect(third.pageInfo.hasMore).toBe(false)
    expect((await h.call(admin.token, 'GET', `/ads/portfolios?${RANGE}&sort=name:asc&pageSize=3&pace=AHEAD&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await h.call(admin.token, 'GET', '/ads/portfolios?pageSize=99999')).status).toBe(422)
  })

  it('详情：曲线整个周期逐日、实际累计只到昨天、理想最后一天等于预算上限；偏快且按近 7 天速度会提前用完时给调整建议', async () => {
    const data = await get(admin, `/ads/portfolios/pf-ahead?${RANGE}`)
    expect(data.row).toMatchObject({ id: 'pf-ahead', spent: 135, pace: { verdict: 'AHEAD' } })
    expect(data.curve).toHaveLength(30)
    expect(data.curve[0]).toMatchObject({ date: dayText(-9), actual: 10, daily: 10 })
    expect(data.curve[8]).toMatchObject({ date: dayText(-1), actual: 135, daily: 55 })
    expect(data.curve[9]).toMatchObject({ date: dayText(0), actual: null, daily: null })
    expect(data.curve[29].ideal).toBeCloseTo(300)
    expect(data.curve[8].ideal).toBeCloseTo(90)
    expect(data.advice).toMatchObject({ kind: 'EXHAUST_EARLY', remainingBudget: 165, remainingDays: 21, currentDailyBudget: 50 })
    expect(data.paceBasis).toBeTruthy()
    expect(data.write.state).toBe('NOT_CONNECTED')
  })

  it('详情的活动预算分配：只含本组合的活动；花费占比按预算周期内美元花费，日预算占比只算启用中的按日预算', async () => {
    const data = await get(admin, `/ads/portfolios/pf-ahead?${RANGE}`)
    expect(data.allocation.state).toBe('OK')
    expect(data.allocation.period).toMatchObject({ from: dayText(-9), to: dayText(-1), basis: 'BUDGET_PERIOD' })
    const items = data.allocation.items as Array<Record<string, any>>
    expect(items.map(item => item.id)).toEqual(['cam-1', 'cam-2'])
    expect(items[0]).toMatchObject({ name: '春季推广', spend: 90, budget: 50, budgetShare: 1 })
    expect(items[0].spendShare).toBeCloseTo(90 / 135)
    expect(items[1]).toMatchObject({ spend: 45, state: 'PAUSED', budgetShare: null })
    // 落后的组合：日预算 20 不低于剩余预算每天可花的 255 / 21，慢不是预算限制的
    const behind = await get(admin, `/ads/portfolios/pf-behind?${RANGE}`)
    expect(behind.advice).toMatchObject({ kind: 'NOT_LIMITED_BY_BUDGET' })
  })

  it('详情：没有预算的组合没有理想线；周期不认识没有曲线；非美元组合的活动花费为空；没有活动的组合分配为“尚无记录”', async () => {
    const free = await get(admin, '/ads/portfolios/pf-free')
    expect(free.row.pace.state).toBe('NO_BUDGET')
    expect(free.curve).toEqual([])
    expect(free.allocation).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(free.advice).toBeNull()
    expect((await get(admin, '/ads/portfolios/pf-unknown')).curve).toEqual([])
    const cad = await get(admin, `/ads/portfolios/pf-cad?${RANGE}`)
    expect((cad.allocation.items as Array<Record<string, any>>)[0]).toMatchObject({ id: 'cam-cad', spend: null, spendShare: null })
    const month = await get(admin, '/ads/portfolios/pf-month')
    expect(month.curve.length).toBeGreaterThanOrEqual(28)
    expect(month.curve.length).toBeLessThanOrEqual(31)
  })

  it('详情的数据范围：范围外、别的企业与不存在的组合都是 404', async () => {
    expect((await h.call(scopedB.token, 'GET', '/ads/portfolios/pf-ahead')).status).toBe(404)
    expect((await h.call(scopedA.token, 'GET', '/ads/portfolios/pf-free')).status).toBe(404)
    expect((await h.call(other.token, 'GET', '/ads/portfolios/pf-ahead')).status).toBe(404)
    expect((await h.call(admin.token, 'GET', '/ads/portfolios/pf-o')).status).toBe(404)
    expect((await h.call(admin.token, 'GET', '/ads/portfolios/not-there')).status).toBe(404)
    expect((await h.call(scopedB.token, 'GET', '/ads/portfolios/pf-on')).status).toBe(200)
  })

  it('预算规则是测试版：功能开关关闭时只给说明；打开后读 AdsBudgetRule，没有规则的组合是“尚无记录”', async () => {
    vi.stubEnv('ADS_BUDGET_RULES_BETA', '')
    const off = await get(admin, '/ads/portfolios/pf-ahead')
    expect(off.rules).toMatchObject({ state: 'DISABLED', flag: 'ADS_BUDGET_RULES_BETA', items: [] })
    vi.stubEnv('ADS_BUDGET_RULES_BETA', '1')
    const on = await get(admin, '/ads/portfolios/pf-ahead')
    expect(on.rules.state).toBe('OK')
    expect(on.rules.items).toHaveLength(1)
    expect(on.rules.items[0]).toMatchObject({ campaignId: 'c1', campaignName: '春季推广', ruleType: 'SCHEDULE', status: 'ACTIVE' })
    expect(on.rules.items[0].params).toEqual(expect.arrayContaining([{ key: 'name', value: '黑五' }]))
    expect((await get(admin, '/ads/portfolios/pf-behind')).rules).toMatchObject({ state: 'NO_DATA', items: [] })
    // 范围外的成员即使打开开关也拿不到规则（详情先 404）
    expect((await h.call(scopedB.token, 'GET', '/ads/portfolios/pf-ahead')).status).toBe(404)
    vi.unstubAllEnvs()
  })

  it('表约束：同一档案同一活动同一规则类型只能有一条；预算起止日要么都空、要么都有且起不晚于止', async () => {
    await expect(
      insertRow(h.client, 'AdsBudgetRule', {
        id: 'rule-dup',
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        campaignId: 'c1',
        ruleType: 'SCHEDULE',
        paramsJson: '{}',
        status: 'ACTIVE',
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      }),
    ).rejects.toThrow()
    await expect(h.client.query(`UPDATE "AdsPortfolio" SET "budgetStart" = '2026-10-10' WHERE "id" = 'pf-month'`)).rejects.toThrow()
    await expect(h.client.query(`UPDATE "AdsPortfolio" SET "budgetStart" = '2026-10-10', "budgetEnd" = '2026-10-01' WHERE "id" = 'pf-month'`)).rejects.toThrow()
    await h.client.query(`UPDATE "AdsPortfolio" SET "budgetStart" = '2026-10-01', "budgetEnd" = '2026-10-01' WHERE "id" = 'pf-month'`)
    await h.client.query(`UPDATE "AdsPortfolio" SET "budgetStart" = NULL, "budgetEnd" = NULL WHERE "id" = 'pf-month'`)
  })
})
