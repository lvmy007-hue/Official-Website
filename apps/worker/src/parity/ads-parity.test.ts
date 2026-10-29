import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { AdsReportWarning } from '../connectors/ads-v1-reports'
import { decodeStream } from '../streaming/download'
import { recorder } from '../importers/ads/ads-fake.test-helper'
import type { AdsDayMetric } from '../importers/ads/report-v1-parse'
import { ADS_PARITY_ROW_LIMIT, ADS_PARITY_WINDOW_DAYS, runAdsParity, shiftDay } from './ads-run'
import { saveAdsParityRun } from './ads-store'
import { compareAds, type LegacyAdsDay } from './compare-ads'
import { MAX_STORED_DIFFS, PARITY_INTERVAL_MS } from './store'
import { countByCategory, zeroUnexplained } from './types'

const TODAY = '2026-10-23'
const OLD = '2026-10-10' // 不在近 3 天回补期内
const RECENT = '2026-10-22' // 在回补期内
const SP = 'SPONSORED_PRODUCTS'
const legacyDay = (date: string, over: Partial<LegacyAdsDay> = {}): LegacyAdsDay => ({
  date,
  campaignId: 'c1',
  adProduct: SP,
  impressions: 1000,
  clicks: 50,
  cost: 25,
  sales: 200,
  purchases: 10,
  ...over,
})
const newDay = (date: string, over: Partial<AdsDayMetric> = {}): AdsDayMetric => ({
  date,
  campaignId: 'c1',
  adProduct: SP,
  impressions: 1000,
  clicks: 50,
  cost: 25,
  sales: 200,
  purchases: 10,
  ...over,
})
const run = (legacy: LegacyAdsDay[], next: AdsDayMetric[], warnings: AdsReportWarning[] = [], products: string[] = [SP]) =>
  compareAds({ legacy, next, today: TODAY, legacyAdProducts: new Set(products), warnings })

describe('广告新旧核对：差异分类', () => {
  it('完全一致：没有差异，匹配数等于行数', () => {
    const report = run([legacyDay(OLD), legacyDay(RECENT)], [newDay(OLD), newDay(RECENT)])
    expect(report).toEqual({ legacyCount: 2, newCount: 2, matchedCount: 2, diffs: [] })
  })

  it('花费在 0.005 以内的浮点误差不算差异', () => {
    expect(run([legacyDay(OLD, { cost: 25.001 })], [newDay(OLD, { cost: 25 })]).diffs).toEqual([])
    expect(run([legacyDay(OLD, { cost: 25.01 })], [newDay(OLD, { cost: 25 })]).diffs).toHaveLength(1)
  })

  it('近 3 天内的差异是时间口径（亚马逊还在回补）', () => {
    const [diff] = run([legacyDay(RECENT)], [newDay(RECENT, { clicks: 55, cost: 25 })]).diffs
    expect(diff).toMatchObject({ category: 'TIME_BASIS', entityKey: `c1@${RECENT}`, field: 'clicks', legacyValue: '50', newValue: '55' })
    expect(diff.explanation).toContain('近 3 天')
  })

  it('只缺一边的行：近 3 天是时间口径；全零行与旧版没拉的广告产品是范围；其余是未解释', () => {
    const missing = run([legacyDay(RECENT), legacyDay(OLD, { campaignId: 'c2' })], [])
    expect(missing.diffs.map(diff => [diff.entityKey, diff.category])).toEqual([
      [`c1@${RECENT}`, 'TIME_BASIS'],
      [`c2@${OLD}`, 'UNEXPLAINED'],
    ])
    const scope = run(
      [legacyDay(OLD, { campaignId: 'z', impressions: 0, clicks: 0, cost: 0, sales: 0, purchases: 0 })],
      [newDay(OLD, { campaignId: 'sb', adProduct: 'SPONSORED_BRANDS' }), newDay(OLD, { campaignId: 'zero', impressions: 0, clicks: 0, cost: 0, sales: 0, purchases: 0 })],
    )
    expect(scope.diffs.map(diff => diff.category)).toEqual(['SCOPE', 'SCOPE', 'SCOPE'])
    expect(scope.diffs[1].explanation).toContain('SPONSORED_BRANDS')
    expect(run([], [newDay(OLD, { campaignId: 'late' })]).diffs[0].category).toBe('UNEXPLAINED')
  })

  it('流量指标一致、只有销售额与订单不同：新版本不少于旧版本是归因口径；比旧版本少是未解释', () => {
    const more = run([legacyDay(OLD)], [newDay(OLD, { sales: 230, purchases: 12 })])
    expect(more.diffs.map(diff => [diff.field, diff.category])).toEqual([
      ['sales', 'ATTRIBUTION_BASIS'],
      ['purchases', 'ATTRIBUTION_BASIS'],
    ])
    const fewer = run([legacyDay(OLD)], [newDay(OLD, { sales: 150 })])
    expect(fewer.diffs[0]).toMatchObject({ field: 'sales', category: 'UNEXPLAINED' })
  })

  it('曝光点击花费也有差异：销售差异跟着它们走，不单独算归因口径', () => {
    const [clicks, sales] = run([legacyDay(OLD)], [newDay(OLD, { clicks: 60, sales: 230 })]).diffs
    expect([clicks.category, sales.category]).toEqual(['UNEXPLAINED', 'UNEXPLAINED'])
    expect(sales.explanation).toContain('随之')
    const recent = run([legacyDay(RECENT)], [newDay(RECENT, { clicks: 60, sales: 230 })]).diffs
    expect(recent.map(diff => diff.category)).toEqual(['TIME_BASIS', 'TIME_BASIS'])
  })

  it('新报告自己带了警告信号：本来说不通的差异归入范围，并写明警告代码；有解释的差异不受影响', () => {
    const warnings = [{ code: 'DATA_DELAYED', message: '' }]
    const report = run([legacyDay(OLD), legacyDay(RECENT, { campaignId: 'c2' })], [newDay(OLD, { clicks: 60 }), newDay(RECENT, { campaignId: 'c2', clicks: 60 })], warnings)
    expect(report.diffs.map(diff => diff.category)).toEqual(['SCOPE', 'TIME_BASIS'])
    expect(report.diffs[0].explanation).toContain('DATA_DELAYED')
  })

  it('缺的指标（null）不参与比较；同一活动同一天的多个广告产品先合并再比', () => {
    expect(run([legacyDay(OLD)], [newDay(OLD, { cost: null, sales: null })]).diffs).toEqual([])
    const merged = run(
      [legacyDay(OLD, { impressions: 1000 })],
      [newDay(OLD, { impressions: 400 }), newDay(OLD, { adProduct: 'SPONSORED_BRANDS', impressions: 600, clicks: 0, cost: 0, sales: 0, purchases: 0 })],
    )
    expect(merged).toMatchObject({ matchedCount: 1, newCount: 1, diffs: [] })
  })

  it('验收：不论什么输入，每条差异都有四类之一的类别、非空原因与定位', () => {
    const legacy = [legacyDay(OLD), legacyDay(RECENT), legacyDay(OLD, { campaignId: 'c2' }), legacyDay(OLD, { campaignId: 'c3', clicks: 1 })]
    const next = [newDay(OLD, { sales: 1 }), newDay(RECENT, { cost: 99 }), newDay(OLD, { campaignId: 'c3', clicks: 9 }), newDay(OLD, { campaignId: 'x', adProduct: 'SPONSORED_DISPLAY' })]
    const { diffs } = run(legacy, next)
    expect(diffs.length).toBeGreaterThanOrEqual(5)
    for (const diff of diffs) {
      expect(['TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED']).toContain(diff.category)
      expect(diff.explanation.length).toBeGreaterThan(5)
      expect(diff.entityKey).toMatch(/@\d{4}-\d{2}-\d{2}$/)
    }
    expect(zeroUnexplained({ legacyCount: 0, newCount: 0, matchedCount: 0, diffs })).toBe(false)
    expect(Object.values(countByCategory(diffs)).reduce((a, b) => a + b, 0)).toBe(diffs.length)
  })
})

describe('广告核对记录与旧通道关闭', () => {
  const scope = { tenantId: 't1', adsProfileId: 'p1' }
  const NOW = new Date('2026-10-23T08:00:00Z')
  const window = { from: '2026-10-10', to: TODAY }
  const state = (over: Record<string, unknown> = {}) => ({ id: 's1', legacyEnabled: true, consecutivePasses: 0, requiredPasses: 7, lastRunAt: null, ...over })
  const input = (report: Parameters<typeof saveAdsParityRun>[2]['report'], warningCount = 0) => ({ window, report, warningCount, startedAt: NOW, now: NOW })

  it('没有未解释差异：通过，连续通过次数加 1；差异按未解释优先保存；窗口按日期保存', async () => {
    const { prisma, of } = recorder({ 'adsParityState.upsert': state({ consecutivePasses: 2 }) })
    const diffs = [
      { category: 'TIME_BASIS' as const, entityKey: 'a', field: 'clicks', explanation: '时间' },
      { category: 'SCOPE' as const, entityKey: 'b', field: 'presence', explanation: '范围' },
    ]
    const saved = await saveAdsParityRun(prisma, scope, input({ legacyCount: 5, newCount: 6, matchedCount: 4, diffs }, 1))
    expect(saved).toMatchObject({ status: 'PASSED', closed: false, counts: { TIME_BASIS: 1, SCOPE: 1, ATTRIBUTION_BASIS: 0, UNEXPLAINED: 0 } })
    expect(of('adsParityRun', 'create')[0].args.data).toMatchObject({
      adsProfileId: 'p1',
      status: 'PASSED',
      windowStart: new Date('2026-10-10T00:00:00Z'),
      windowEnd: new Date('2026-10-23T00:00:00Z'),
      warningCount: 1,
      matchedCount: 4,
    })
    expect(of('adsParityDiff', 'createMany')[0].args.data.map((row: { category: string }) => row.category)).toEqual(['SCOPE', 'TIME_BASIS'])
    expect(of('adsParityState', 'update')[0].args.data).toMatchObject({ consecutivePasses: 3 })
  })

  it('有未解释差异：次数清零，旧通道保持开启', async () => {
    const { prisma, of } = recorder({ 'adsParityState.upsert': state({ consecutivePasses: 6 }) })
    const saved = await saveAdsParityRun(
      prisma,
      scope,
      input({ legacyCount: 1, newCount: 1, matchedCount: 0, diffs: [{ category: 'UNEXPLAINED', entityKey: 'a', field: 'cost', explanation: '说不通' }] }),
    )
    expect(saved).toMatchObject({ status: 'HAS_DIFFS', closed: false })
    expect(of('adsParityState', 'update')[0].args.data).toMatchObject({ consecutivePasses: 0 })
  })

  it('连续通过达到要求次数：关闭旧通道并写明原因与时间；旧版不可用时次数不变', async () => {
    const closing = recorder({ 'adsParityState.upsert': state({ consecutivePasses: 6 }) })
    const saved = await saveAdsParityRun(closing.prisma, scope, input({ legacyCount: 1, newCount: 1, matchedCount: 1, diffs: [] }))
    expect(saved).toMatchObject({ status: 'PASSED', closed: true })
    expect(closing.of('adsParityState', 'update')[0].args.data).toMatchObject({ consecutivePasses: 7, legacyEnabled: false, closedAt: NOW, closedReason: expect.stringContaining('7') })

    const unavailable = recorder({ 'adsParityState.upsert': state({ consecutivePasses: 3 }) })
    expect(await saveAdsParityRun(unavailable.prisma, scope, input(null))).toMatchObject({ status: 'LEGACY_UNAVAILABLE', closed: false })
    expect(unavailable.of('adsParityState', 'update')[0].args.data.consecutivePasses).toBe(3)
    expect(unavailable.of('adsParityDiff', 'createMany')).toHaveLength(0)
  })

  it(`差异行最多保存 ${MAX_STORED_DIFFS} 条，超出部分仍计入各类计数`, async () => {
    const { prisma, of } = recorder({ 'adsParityState.upsert': state() })
    const diffs = Array.from({ length: MAX_STORED_DIFFS + 7 }, (_, index) => ({ category: 'TIME_BASIS' as const, entityKey: `c@${index}`, field: 'clicks', explanation: '时间' }))
    const saved = await saveAdsParityRun(prisma, scope, input({ legacyCount: 0, newCount: 0, matchedCount: 0, diffs }))
    expect(of('adsParityDiff', 'createMany')[0].args.data).toHaveLength(MAX_STORED_DIFFS)
    expect(saved.counts.TIME_BASIS).toBe(MAX_STORED_DIFFS + 7)
  })
})

describe('广告核对运行器', () => {
  const scope = { tenantId: 't1', adsProfileId: 'p1' }
  const NOW = new Date('2026-10-23T08:00:00Z')
  const shard = (rows: object[]) => async () => decodeStream(Readable.from([gzipSync(rows.map(row => JSON.stringify(row)).join('\n'))]))
  const dbRow = (over: Record<string, unknown> = {}) => ({
    reportDate: new Date(`${OLD}T00:00:00Z`),
    externalCampaignId: 'c1',
    adProduct: SP,
    impressions: 1000,
    clicks: 50,
    cost: 25,
    sales: 200,
    purchases: 10,
    ...over,
  })
  const reporting = (shardUrls = ['u/1'], warnings: AdsReportWarning[] = []) => ({
    create: vi.fn(async () => 'rep'),
    retrieve: vi.fn(async () => ({ state: 'READY' as const, reportId: 'rep', shardUrls, warnings })),
  })
  const stateRow = { id: 's1', legacyEnabled: true, consecutivePasses: 0, requiredPasses: 7, lastRunAt: null }

  it('窗口是最近 14 天：旧版日指标按这个窗口读，新报告按同一个窗口申请（按日、活动 × 日）', async () => {
    const { ctx, of } = recorder({ 'adsParityState.upsert': stateRow, 'adsMetric.findMany': [dbRow()], 'adsReportJob.findMany': [{ adProduct: SP }] })
    const api = reporting()
    const outcome = await runAdsParity(ctx, scope, {
      reporting: api,
      today: TODAY,
      now: () => NOW,
      open: shard([{ date: OLD, campaignId: 'c1', adProduct: SP, impressions: 1000, clicks: 50, cost: 25, sales: 230, purchases: 12 }]),
    })
    expect(outcome).toMatchObject({ ran: true, status: 'PASSED', counts: { ATTRIBUTION_BASIS: 2, UNEXPLAINED: 0 } })
    expect(ADS_PARITY_WINDOW_DAYS).toBe(14)
    expect(api.create.mock.calls[0][0]).toMatchObject({ granularity: 'DAILY', from: '2026-10-10', to: TODAY, dimensions: ['date', 'adProduct', 'campaignId'] })
    const where = of('adsMetric', 'findMany')[0].args.where
    expect(where).toMatchObject({ adsProfileId: 'p1', reportDate: { gte: new Date('2026-10-10T00:00:00Z'), lt: new Date('2026-10-24T00:00:00Z') } })
    expect(of('adsParityRun', 'create')[0].args.data).toMatchObject({ legacyCount: 1, newCount: 1, status: 'PASSED' })
  })

  it('旧版近 14 天没有数据：记为旧版不可用，不请求新报告', async () => {
    const { ctx } = recorder({ 'adsParityState.upsert': stateRow, 'adsMetric.findMany': [] })
    const api = reporting()
    expect(await runAdsParity(ctx, scope, { reporting: api, today: TODAY, now: () => NOW })).toMatchObject({ ran: true, status: 'LEGACY_UNAVAILABLE' })
    expect(api.create).not.toHaveBeenCalled()
  })

  it('间隔不到一天或旧通道已关闭：不运行，什么都不读', async () => {
    for (const closed of [{ lastRunAt: new Date(NOW.getTime() - PARITY_INTERVAL_MS + 60_000) }, { legacyEnabled: false }]) {
      const { ctx, of } = recorder({ 'adsParityState.upsert': { ...stateRow, ...closed } })
      const api = reporting()
      expect(await runAdsParity(ctx, scope, { reporting: api, today: TODAY, now: () => NOW })).toEqual({ ran: false })
      expect(of('adsMetric', 'findMany')).toHaveLength(0)
      expect(api.create).not.toHaveBeenCalled()
    }
  })

  it('新报告的警告信号带进核对：警告数写进记录，说不通的差异归入范围', async () => {
    const { ctx, of } = recorder({ 'adsParityState.upsert': stateRow, 'adsMetric.findMany': [dbRow()], 'adsReportJob.findMany': [] })
    const outcome = await runAdsParity(ctx, scope, {
      reporting: reporting(['u/1'], [{ code: 'PARTIAL_DATA', message: '' }]),
      today: TODAY,
      now: () => NOW,
      open: shard([{ date: OLD, campaignId: 'c1', adProduct: SP, impressions: 1000, clicks: 99, cost: 25, sales: 200, purchases: 10 }]),
    })
    expect(outcome).toMatchObject({ status: 'PASSED', counts: { SCOPE: 1, UNEXPLAINED: 0 } })
    expect(of('adsParityRun', 'create')[0].args.data.warningCount).toBe(1)
  })

  it('旧版行数达到读取上限：不核对（不然截断会造出假差异），以不可重试错误结束', async () => {
    const rows = Array.from({ length: ADS_PARITY_ROW_LIMIT }, (_, index) => dbRow({ externalCampaignId: `c${index}` }))
    const { ctx, of } = recorder({ 'adsParityState.upsert': stateRow, 'adsMetric.findMany': rows })
    await expect(runAdsParity(ctx, scope, { reporting: reporting(), today: TODAY, now: () => NOW })).rejects.toMatchObject({ code: 'ADS_PARITY_TOO_LARGE', retryable: false })
    expect(of('adsParityRun', 'create')).toHaveLength(0)
  })

  it('日期平移按日历算', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-10-23', -13)).toBe('2026-10-10')
    expect(() => shiftDay('bad', 1)).toThrow('ADS_PARITY_BAD_DAY')
  })
})
