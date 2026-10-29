import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'

// 广告新增分析与工具接口（P6-24）：权限先于参数、批量加词的参数与去重与幂等、超预算时间条的范围与精度、冲突与重复关键词的读取。
// 真实数据库里的计算、范围与隔离见 testing/ads-tools.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
const streamBefore = process.env.AMAZON_ADS_STREAM_SINK
beforeEach(() => {
  process.env.AMAZON_ADS_STREAM_SINK = 'https://sink.example.com'
})
afterEach(async () => {
  await harness?.close()
  harness = undefined
  if (streamBefore === undefined) delete process.env.AMAZON_ADS_STREAM_SINK
  else process.env.AMAZON_ADS_STREAM_SINK = streamBefore
})

const stamp = new Date('2026-10-24T08:00:00Z')
const PROFILE = { adsAccountId: 'acct-1', sellerAccountId: 's1' }
const group = { id: 'g1', adsProfileId: 'p1', adGroupId: 'EXT-G1', campaignId: 'EXT-C1', name: '广告组一', state: 'ENABLED', defaultBid: { toString: () => '0.8' }, adsProfile: PROFILE }
const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  adsProfileId: 'p1',
  externalCampaignId: 'EXT-C1',
  adProduct: 'SPONSORED_PRODUCTS',
  name: '活动一',
  state: 'ENABLED',
  budget: { toString: () => '10.000000' },
  budgetType: 'DAILY',
  currency: 'USD',
  bidStrategy: 'SALES_DOWN_ONLY',
  adsProfile: { ...PROFILE, displayName: '账户一', profileId: 'P-1', bindingStatus: 'MANUAL', sellerAccount: { displayName: '店铺一' } },
  ...over,
})
const ALL = ['ads.read', 'ads.negative.write', 'ads.keyword.write']

function stubs(permissions: string[], over: Record<string, any> = {}) {
  let runNo = 0
  return prismaFor(permissions, {
    adsCampaign: { findMany: vi.fn().mockResolvedValue([campaign()]), findFirst: vi.fn().mockResolvedValue(campaign()) },
    adsAdGroup: { findMany: vi.fn().mockResolvedValue([group]), findFirst: vi.fn().mockResolvedValue(group) },
    adsKeyword: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    adsNegativeTarget: { findMany: vi.fn().mockResolvedValue([]) },
    adsPerformanceHourly: { findMany: vi.fn().mockResolvedValue([]) },
    adsMetric: { findMany: vi.fn().mockResolvedValue([]) },
    daypartingStrategy: { findMany: vi.fn().mockResolvedValue([]) },
    adsAutomationRule: { findMany: vi.fn().mockResolvedValue([]) },
    platformConnection: { findFirst: vi.fn().mockResolvedValue({ id: 'conn-1', sellerAccountId: null, healthChecks: [], lastErrorCode: null }) },
    integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: true, autoDisabledReason: null }) },
    adsWriteRun: {
      create: vi.fn().mockImplementation(async () => ({ id: `run-${++runNo}` })),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map(id => ({
          id,
          kind: 'KEYWORD_ADD',
          source: 'MANUAL',
          entityType: 'AD_GROUP',
          entityId: 'g1',
          entityLabel: '广告组一',
          beforeValue: null,
          afterValue: 'x（EXACT）',
          status: 'PENDING',
          failureCode: null,
          requestedBy: 'user-1',
          createdAt: stamp,
          finishedAt: null,
        })),
      ),
    },
    syncJob: { create: vi.fn().mockResolvedValue({ id: 'job-1', priority: 5 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    ...over,
  })
}

const bulk = (over: Record<string, unknown> = {}) => ({ mode: 'KEYWORD', entityId: 'g1', source: 'BRAND_SEARCH_TERM', items: [{ text: 'yoga mat', matchType: 'EXACT' }], ...over })

describe('广告新增分析与工具：权限先于参数', () => {
  it('未登录 401；没有 ads.read 调任何入口都是 403，且不读业务表', async () => {
    const prisma = stubs([])
    harness = await createTestApp(prisma)
    const calls: Array<[string, string, unknown]> = [
      ['GET', '/ads/campaigns/c1/budget-timeline', undefined],
      ['GET', '/ads/conflicts', undefined],
      ['GET', '/ads/duplicate-keywords', undefined],
      ['POST', '/ads/keywords/bulk-add', bulk()],
    ]
    for (const [method, path, body] of calls) {
      expect((await harness.call(method, path, { body, auth: false })).status, path).toBe(401)
      expect((await harness.call(method, path, { body })).status, path).toBe(403)
    }
    expect((await harness.call('GET', '/ads/conflicts?pageSize=0')).status).toBe(403)
    expect(prisma.adsCampaign.findFirst).not.toHaveBeenCalled()
    expect(prisma.adsKeyword.findMany).not.toHaveBeenCalled()
    expect(prisma.daypartingStrategy.findMany).not.toHaveBeenCalled()
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
  })

  it('批量加词要这类写入自己的权限：只有 ads.read 不行；加词权限不能用来加否定；权限判断先于参数校验与对象查询', async () => {
    const prisma = stubs(['ads.read', 'ads.keyword.write'])
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/ads/keywords/bulk-add', { body: bulk({ mode: 'NEGATIVE', level: 'AD_GROUP', items: [{ text: 'x', matchType: 'NEGATIVE_EXACT' }] }) })).status).toBe(403)
    expect((await harness.call('POST', '/ads/keywords/bulk-add', { body: { mode: 'NEGATIVE', junk: true } })).status).toBe(403)
    await harness.close()
    const readOnly = stubs(['ads.read'])
    harness = await createTestApp(readOnly)
    expect((await harness.call('POST', '/ads/keywords/bulk-add', { body: bulk() })).status).toBe(403)
    expect((await harness.call('POST', '/ads/keywords/bulk-add', { body: { items: 'bad' } })).status).toBe(403)
    expect(readOnly.adsAdGroup.findFirst).not.toHaveBeenCalled()
    expect(readOnly.adsWriteRun.create).not.toHaveBeenCalled()
  })
})

describe('批量加词', () => {
  it('不合法的请求都是 422：空列表、超过 50 个、否定没给层级、关键词给了层级、匹配方式和模式对不上、未声明字段', async () => {
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    const many = Array.from({ length: 51 }, (_, index) => ({ text: `w${index}`, matchType: 'EXACT' }))
    const bad = [
      bulk({ items: [] }),
      bulk({ items: many }),
      bulk({ mode: 'NEGATIVE', items: [{ text: 'x', matchType: 'NEGATIVE_EXACT' }] }),
      bulk({ level: 'AD_GROUP' }),
      bulk({ items: [{ text: 'x', matchType: 'NEGATIVE_EXACT' }] }),
      bulk({ mode: 'NEGATIVE', level: 'AD_GROUP', items: [{ text: 'x', matchType: 'EXACT' }] }),
      bulk({ items: [{ text: 'x', matchType: 'EXACT', amount: 0 }] }),
      bulk({ extra: 1 }),
      bulk({ entityId: '带空格' }),
    ]
    for (const body of bad) {
      const res = await harness.call('POST', '/ads/keywords/bulk-add', { body })
      expect(res.status, JSON.stringify(body).slice(0, 90)).toBe(422)
    }
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
  })

  it('广告组不存在或不在范围内 404，什么也不写', async () => {
    const prisma = stubs(ALL, { adsAdGroup: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } })
    harness = await createTestApp(prisma)
    expect((await harness.call('POST', '/ads/keywords/bulk-add', { body: bulk() })).status).toBe(404)
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
  })

  it('去掉目标里已有的词和批内重复的词，其余逐项成写入记录；响应逐条说明被跳过的原因；审计带来源', async () => {
    const prisma = stubs(ALL, { adsKeyword: { findMany: vi.fn().mockResolvedValue([{ text: 'Yoga  Mat', matchType: 'exact' }]), findFirst: vi.fn() } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/ads/keywords/bulk-add', {
      body: bulk({
        items: [
          { text: 'yoga mat', matchType: 'EXACT' },
          { text: 'pilates', matchType: 'PHRASE', amount: 0.5 },
          { text: 'Pilates', matchType: 'PHRASE' },
          { text: 'pilates', matchType: 'BROAD' },
        ],
      }),
    })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'QUEUED', requested: 4 })
    expect(res.json.data.runs).toHaveLength(2)
    expect(res.json.data.skipped.map((item: { index: number }) => item.index)).toEqual([0, 2])
    expect(prisma.adsWriteRun.create).toHaveBeenCalledTimes(2)
    const first = prisma.adsWriteRun.create.mock.calls[0][0].data
    expect(first).toMatchObject({ kind: 'KEYWORD_ADD', source: 'MANUAL', entityId: 'g1', externalId: 'EXT-G1', afterValue: 'pilates（PHRASE）' })
    expect(first.requestJson).toMatchObject({ text: 'pilates', matchType: 'PHRASE', amount: 0.5 })
    const audit = prisma.auditEvent.create.mock.calls.map((call: any[]) => call[0].data).find((data: any) => data.action === 'ADS_WRITE_SUBMITTED')
    expect(JSON.stringify(audit)).toContain('BRAND_SEARCH_TERM')
  })

  it('全部已存在：不提交任何写入，状态是“没有可添加的词”（再提交一次同样的请求是幂等的）', async () => {
    const prisma = stubs(ALL, { adsKeyword: { findMany: vi.fn().mockResolvedValue([{ text: 'yoga mat', matchType: 'EXACT' }]), findFirst: vi.fn() } })
    harness = await createTestApp(prisma)
    const res = await harness.call('POST', '/ads/keywords/bulk-add', { body: bulk() })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'NOTHING_TO_ADD', runs: [], requested: 1 })
    expect(res.json.data.skipped).toHaveLength(1)
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
    expect(harness.queue.add).not.toHaveBeenCalled()
  })

  it('否定投放：挂在活动或广告组，对照各自已有的否定词；写入开关关闭 409 且整批不写', async () => {
    const prisma = stubs(ALL, { adsNegativeTarget: { findMany: vi.fn().mockResolvedValue([{ expression: 'free', matchType: 'NEGATIVE_EXACT' }]) } })
    harness = await createTestApp(prisma)
    const negative = bulk({
      mode: 'NEGATIVE',
      entityId: 'c1',
      level: 'CAMPAIGN',
      items: [
        { text: 'free', matchType: 'NEGATIVE_EXACT' },
        { text: 'cheap', matchType: 'NEGATIVE_PHRASE' },
      ],
    })
    const ok = await harness.call('POST', '/ads/keywords/bulk-add', { body: negative })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.data.skipped.map((item: { text: string }) => item.text)).toEqual(['free'])
    expect(prisma.adsNegativeTarget.findMany.mock.calls[0][0].where).toMatchObject({ level: 'CAMPAIGN', campaignId: 'EXT-C1' })
    expect(prisma.adsWriteRun.create.mock.calls[0][0].data).toMatchObject({ kind: 'NEGATIVE_ADD', entityType: 'CAMPAIGN' })
    await harness.close()
    const off = stubs(ALL, { integrationSwitch: { findFirst: vi.fn().mockResolvedValue({ enabled: false, autoDisabledReason: null }) } })
    harness = await createTestApp(off)
    const blocked = await harness.call('POST', '/ads/keywords/bulk-add', { body: bulk() })
    expect(blocked.status).toBe(409)
    expect(off.adsWriteRun.create).not.toHaveBeenCalled()
  })
})

const hourRow = (iso: string, spend: number, impressions = 10) => ({ hourStart: new Date(iso), spend: { toString: () => String(spend) }, impressions, clicks: 1 })

describe('超预算时间条', () => {
  const day = '?from=2026-10-20&to=2026-10-20'

  it('活动不存在或不在范围内 404；时间范围倒置或超过 14 天 422', async () => {
    harness = await createTestApp(stubs(ALL, { adsCampaign: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) } }))
    expect((await harness.call('GET', `/ads/campaigns/c9/budget-timeline${day}`)).status).toBe(404)
    await harness.close()
    harness = await createTestApp(stubs(ALL))
    expect((await harness.call('GET', '/ads/campaigns/c1/budget-timeline?from=2026-10-20&to=2026-10-10')).status).toBe(422)
    expect((await harness.call('GET', '/ads/campaigns/c1/budget-timeline?from=2026-09-01&to=2026-10-20')).status).toBe(422)
  })

  it('数据流接收端没配置：NOT_CONNECTED，不查小时表，并写明原因；归因窗口仍可读', async () => {
    delete process.env.AMAZON_ADS_STREAM_SINK
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    const data = (await harness.call('GET', `/ads/campaigns/c1/budget-timeline${day}`)).json.data
    expect(data).toMatchObject({ state: 'NOT_CONNECTED', days: [], averageOverBudgetHours: null, historyDays: 14 })
    expect(data.note).toContain('AMAZON_ADS_STREAM_SINK')
    expect(data.precisionNote).toContain('精度说明')
    expect(data.windows).toHaveLength(4)
    expect(prisma.adsPerformanceHourly.findMany).not.toHaveBeenCalled()
  })

  it('没有小时记录：NO_DATA；有记录：按企业时区归到日期与小时，累计花费超过日预算的小时标出，并标注预算与币种', async () => {
    harness = await createTestApp(stubs(ALL))
    expect((await harness.call('GET', `/ads/campaigns/c1/budget-timeline${day}`)).json.data).toMatchObject({ state: 'NO_DATA', days: [] })
    await harness.close()
    // 企业时区是洛杉矶（10 月是 UTC-7）：15:00Z 是本地 8 点
    const rows = [hourRow('2026-10-20T15:00:00Z', 4), hourRow('2026-10-20T16:00:00Z', 4), hourRow('2026-10-20T17:00:00Z', 3), hourRow('2026-10-19T03:00:00Z', 99)]
    harness = await createTestApp(stubs(ALL, { adsPerformanceHourly: { findMany: vi.fn().mockResolvedValue(rows) } }))
    const data = (await harness.call('GET', `/ads/campaigns/c1/budget-timeline${day}`)).json.data
    expect(data).toMatchObject({ state: 'OK', zone: 'America/Los_Angeles', currency: 'USD', budget: 10, averageOverBudgetHours: 14, period: { from: '2026-10-20', to: '2026-10-20' } })
    expect(data.days).toHaveLength(1)
    expect(data.days[0]).toMatchObject({ date: '2026-10-20', spend: 11, exceededAtHour: 10, overBudgetHours: 14, activeHours: 3, activeHoursWithinBudget: 2, hoursRecorded: 3 })
    expect(data.days[0].hours[8]).toMatchObject({ spend: 4, cumulative: 4, over: false })
    expect(data.days[0].hours[10]).toMatchObject({ spend: 3, cumulative: 11, over: true })
  })

  it('预算没同步或不是日预算：只显示花费，不判断超预算，并说明原因', async () => {
    const rows = [hourRow('2026-10-20T15:00:00Z', 400)]
    harness = await createTestApp(
      stubs(ALL, { adsPerformanceHourly: { findMany: vi.fn().mockResolvedValue(rows) }, adsCampaign: { findFirst: vi.fn().mockResolvedValue(campaign({ budget: null })), findMany: vi.fn() } }),
    )
    const unknown = (await harness.call('GET', `/ads/campaigns/c1/budget-timeline${day}`)).json.data
    expect(unknown).toMatchObject({ budget: null })
    expect(unknown.budgetNote).toContain('没有同步')
    expect(unknown.days[0]).toMatchObject({ spend: 400, exceededAtHour: null, overBudgetHours: null })
    await harness.close()
    harness = await createTestApp(
      stubs(ALL, {
        adsPerformanceHourly: { findMany: vi.fn().mockResolvedValue(rows) },
        adsCampaign: { findFirst: vi.fn().mockResolvedValue(campaign({ budgetType: 'LIFETIME' })), findMany: vi.fn() },
      }),
    )
    const lifetime = (await harness.call('GET', `/ads/campaigns/c1/budget-timeline${day}`)).json.data
    expect(lifetime.budget).toBeNull()
    expect(lifetime.budgetNote).toContain('LIFETIME')
  })

  it('归因窗口：报告行带哪个窗口的列哪个才可用，其余置灰写原因；默认窗口 7 天', async () => {
    const raws = [
      { reportDate: new Date('2026-10-20T00:00:00Z'), raw: { sales7d: 12.5, purchases7d: 2, sales14d: 20, purchases14d: 3 } },
      { reportDate: new Date('2026-10-21T00:00:00Z'), raw: { sales7d: 7.5, purchases7d: 1 } },
    ]
    harness = await createTestApp(stubs(ALL, { adsMetric: { findMany: vi.fn().mockResolvedValue(raws) } }))
    const data = (await harness.call('GET', '/ads/campaigns/c1/budget-timeline?from=2026-10-20&to=2026-10-21')).json.data
    expect(data.defaultWindow).toBe(7)
    const view = (window: number) => data.windows.find((item: { window: number }) => item.window === window)
    expect(view(7)).toMatchObject({ available: true, sales: 20, orders: 3 })
    expect(view(14)).toMatchObject({ available: false, coveredDays: 1, totalDays: 2 })
    expect(view(14).reason).toContain('sales14d')
    expect(view(1)).toMatchObject({ available: false, sales: null })
  })
})

describe('冲突检查与重复关键词', () => {
  const strategy = (id: string, grid: number[]) => ({
    id,
    adsProfileId: 'p1',
    name: `策略${id}`,
    kind: 'ON_OFF',
    targetLevel: 'CAMPAIGN',
    scopeJson: { ids: ['c1'] },
    hourlyMultipliersJson: grid,
    baseBid: null,
    timezone: 'America/Los_Angeles',
    status: 'ACTIVE',
    version: 1,
    createdAt: stamp,
    updatedAt: stamp,
    updatedBy: 'user-1',
    adsProfile: { displayName: null, profileId: 'P-1', sellerAccount: null },
  })
  const grid = (cell: number, value: number) => Array.from({ length: 168 }, (_, index) => (index === cell ? value : 1))

  it('冲突：分时策略之间取值不同、自动规则覆盖本账户全部活动；分页、筛选与计数；非法参数 422', async () => {
    const rule = { id: 'r1', name: '规则一', adsProfileId: 'p1', status: 'ACTIVE', mode: 'AUTO', level: 'CAMPAIGN', actionJson: { type: 'PAUSE' }, scopeJson: { campaignIds: [] } }
    harness = await createTestApp(
      stubs(ALL, {
        daypartingStrategy: { findMany: vi.fn().mockResolvedValue([strategy('s1', grid(3, 0)), strategy('s2', grid(3, 1))]) },
        adsAutomationRule: { findMany: vi.fn().mockResolvedValue([rule]) },
        adsCampaign: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'c1', name: '活动一', adsProfileId: 'p1' },
            { id: 'c2', name: '活动二', adsProfileId: 'p1' },
          ]),
          findFirst: vi.fn(),
        },
      }),
    )
    const data = (await harness.call('GET', '/ads/conflicts')).json.data
    expect(data).toMatchObject({ state: 'OK', total: 1, truncated: false })
    expect(data.items[0]).toMatchObject({ kind: 'RULE_VS_DAYPARTING', objectId: 'c1', field: 'state' })
    expect(data.items[0].parties.map((party: { id: string; effective: boolean }) => [party.id, party.effective])).toEqual([
      ['s1', false],
      ['s2', true],
      ['r1', false],
    ])
    expect(data.counts).toEqual({ s1: 1, s2: 1, r1: 1 })
    expect(data.ruleNote).toContain('编号大的')
    expect((await harness.call('GET', '/ads/conflicts?kind=RULE_OVERLAP')).json.data).toMatchObject({ total: 0, state: 'OK', items: [] })
    expect((await harness.call('GET', '/ads/conflicts?q=不存在的名字')).json.data.items).toEqual([])
    expect((await harness.call('GET', '/ads/conflicts?pageSize=0')).status).toBe(422)
    expect((await harness.call('GET', '/ads/conflicts?kind=NOPE')).status).toBe(422)
  })

  it('没有冲突时 NO_DATA 并写明；只读，不写任何东西', async () => {
    const prisma = stubs(ALL)
    harness = await createTestApp(prisma)
    const data = (await harness.call('GET', '/ads/conflicts')).json.data
    expect(data).toMatchObject({ state: 'NO_DATA', items: [], total: 0 })
    expect(data.note).toContain('没有发现冲突')
    expect(prisma.adsWriteRun.create).not.toHaveBeenCalled()
  })

  it('重复关键词：同账户同词同匹配方式出现在多个广告组，带广告组与活动名称；没同步任何关键词是 NOT_CONNECTED', async () => {
    const keyword = (id: string, adGroupId: string, text = 'Yoga Mat') => ({
      id,
      adsProfileId: 'p1',
      campaignId: 'EXT-C1',
      adGroupId,
      text,
      matchType: 'EXACT',
      bid: { toString: () => '1.2' },
      state: 'ENABLED',
    })
    harness = await createTestApp(
      stubs(ALL, {
        adsKeyword: { findMany: vi.fn().mockResolvedValue([keyword('k1', 'EXT-G1'), keyword('k2', 'EXT-G2', ' yoga  mat'), keyword('k3', 'EXT-G1', 'solo')]), findFirst: vi.fn() },
        adsAdGroup: {
          findMany: vi.fn().mockResolvedValue([
            { id: 'g1', adsProfileId: 'p1', adGroupId: 'EXT-G1', name: '广告组一' },
            { id: 'g2', adsProfileId: 'p1', adGroupId: 'EXT-G2', name: '广告组二' },
          ]),
          findFirst: vi.fn(),
        },
        adsCampaign: { findMany: vi.fn().mockResolvedValue([{ id: 'c1', adsProfileId: 'p1', externalCampaignId: 'EXT-C1', name: '活动一' }]), findFirst: vi.fn() },
      }),
    )
    const data = (await harness.call('GET', '/ads/duplicate-keywords')).json.data
    expect(data).toMatchObject({ state: 'OK', total: 1, truncated: false })
    expect(data.items[0]).toMatchObject({ text: 'yoga mat', matchType: 'EXACT', matchLabel: '精确匹配', adGroupCount: 2 })
    expect(data.items[0].locations).toEqual([
      expect.objectContaining({ keywordId: 'k1', adGroupName: '广告组一', campaignName: '活动一', bid: 1.2 }),
      expect.objectContaining({ keywordId: 'k2', adGroupName: '广告组二', campaignId: 'c1' }),
    ])
    expect((await harness.call('GET', '/ads/duplicate-keywords?q=nothing')).json.data.items).toEqual([])
    expect((await harness.call('GET', '/ads/duplicate-keywords?matchType=NOPE')).status).toBe(422)
    await harness.close()
    harness = await createTestApp(stubs(ALL))
    expect((await harness.call('GET', '/ads/duplicate-keywords')).json.data).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
  })
})
