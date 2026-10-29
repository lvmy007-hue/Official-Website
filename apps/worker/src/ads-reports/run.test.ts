import { Readable } from 'node:stream'
import { NonRetryableError } from '@nova/workflow'
import { describe, expect, it, vi } from 'vitest'
import { recorder } from '../importers/ads/ads-fake.test-helper'
import { decodeStream } from '../streaming/download'
import { ADS_REPORT_MAX_WAIT_MS, runAdsReport } from './run'

// 新报告接口任务运行器（单元：记录写库调用的替身）。真实数据库里的幂等、覆盖、历史可用起点、范围隔离见 testing/ads-reports.db.test.ts。

const NOW = new Date('2026-10-20T12:00:00Z')
const profile = { id: 'ap-1', adsAccountId: 'ACC-1', displayName: '主账户', currencyCode: 'USD' }
const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  tenantId: 't-1',
  source: 'V1',
  templateKey: 'CAMPAIGN_DAILY',
  adProduct: 'SPONSORED_PRODUCTS',
  status: 'PENDING',
  externalReportId: null,
  fromDate: new Date('2026-10-01T00:00:00Z'),
  toDate: new Date('2026-10-10T00:00:00Z'),
  startedAt: null,
  importedRows: null,
  skippedRows: null,
  failureCode: null,
  failureMessage: null,
  adsProfile: profile,
  ...over,
})
const stream = (text: string) => decodeStream(Readable.from([Buffer.from(text)]))
const reporting = (state: unknown) => ({ create: vi.fn().mockResolvedValue('RPT-1'), retrieve: vi.fn().mockResolvedValue(state) })
const deps = (api: ReturnType<typeof reporting>, text = '') => ({ reporting: api, today: '2026-10-20', now: () => NOW, open: async () => stream(text) })

describe('新报告接口任务：创建步骤', () => {
  it('创建报告、记下报告编号、任务置为生成中并返回待轮询；请求按模板的维度、指标与任务的广告产品发出', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': job() })
    const api = reporting({ state: 'PENDING', reportId: 'RPT-1' })
    const result = await runAdsReport(ctx, { reportJobId: 'job-1' }, deps(api))
    expect(result).toEqual({ pending: true, reportId: 'RPT-1' })
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'DAILY', from: '2026-10-01', to: '2026-10-10', today: '2026-10-20', dimensions: ['date', 'adProduct', 'campaignId'], adProducts: ['SPONSORED_PRODUCTS'] }),
    )
    expect(of('adsReportJob', 'update')[0].args.data).toMatchObject({ status: 'GENERATING', externalReportId: 'RPT-1', startedAt: NOW })
  })

  it('不是新报告接口的任务、模板不存在：永久失败，不碰亚马逊', async () => {
    const api = reporting({ state: 'PENDING', reportId: 'x' })
    await expect(runAdsReport(recorder({ 'adsReportJob.findUnique': job({ source: 'LEGACY' }) }).ctx, { reportJobId: 'job-1' }, deps(api))).rejects.toBeInstanceOf(NonRetryableError)
    await expect(runAdsReport(recorder({ 'adsReportJob.findUnique': job({ templateKey: 'NOPE' }) }).ctx, { reportJobId: 'job-1' }, deps(api))).rejects.toBeInstanceOf(NonRetryableError)
    await expect(runAdsReport(recorder({ 'adsReportJob.findUnique': null }).ctx, { reportJobId: 'job-1' }, deps(api))).rejects.toBeInstanceOf(NonRetryableError)
    expect(api.create).not.toHaveBeenCalled()
  })

  it('广告档案没有广告账户编号：任务记为失败并写下中文原因，不创建报告', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': job({ adsProfile: { ...profile, adsAccountId: null } }) })
    const api = reporting({ state: 'PENDING', reportId: 'x' })
    await expect(runAdsReport(ctx, { reportJobId: 'job-1' }, deps(api))).rejects.toMatchObject({ code: 'ADS_ACCOUNT_MISSING' })
    expect(of('adsReportJob', 'update')[0].args.data).toMatchObject({ status: 'FAILED', failureCode: 'ADS_ACCOUNT_MISSING' })
    expect(api.create).not.toHaveBeenCalled()
  })

  it('已经完成的任务重复投递：直接返回上次结果，不重复导入', async () => {
    const { ctx, calls } = recorder({ 'adsReportJob.findUnique': job({ status: 'READY', externalReportId: 'RPT-1', importedRows: 7, skippedRows: 1 }) })
    const api = reporting({ state: 'PENDING', reportId: 'x' })
    expect(await runAdsReport(ctx, { reportJobId: 'job-1' }, deps(api))).toEqual({ ready: true, reportId: 'RPT-1', imported: 7, skipped: 1 })
    expect(calls.filter(call => call.op !== 'findUnique')).toEqual([])
  })
})

describe('新报告接口任务：轮询步骤', () => {
  const polling = (over: Record<string, unknown> = {}) => job({ status: 'GENERATING', externalReportId: 'RPT-1', startedAt: new Date(NOW.getTime() - 60_000), ...over })

  it('还没好：继续待轮询；超过 6 小时：永久失败并说明', async () => {
    const api = reporting({ state: 'PENDING', reportId: 'RPT-1' })
    expect(await runAdsReport(recorder({ 'adsReportJob.findUnique': polling() }).ctx, { reportJobId: 'job-1' }, deps(api))).toEqual({ pending: true, reportId: 'RPT-1' })
    const late = recorder({ 'adsReportJob.findUnique': polling({ startedAt: new Date(NOW.getTime() - ADS_REPORT_MAX_WAIT_MS - 1000) }) })
    await expect(runAdsReport(late.ctx, { reportJobId: 'job-1' }, deps(api))).rejects.toMatchObject({ code: 'ADS_REPORT_NOT_READY' })
    expect(late.of('adsReportJob', 'update')[0].args.data).toMatchObject({ status: 'FAILED', failureCode: 'ADS_REPORT_NOT_READY' })
  })

  it('亚马逊说失败：永久失败，失败原因写在任务上', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': polling() })
    await expect(runAdsReport(ctx, { reportJobId: 'job-1' }, deps(reporting({ state: 'FAILED', reportId: 'RPT-1', reason: 'EXPIRED' })))).rejects.toMatchObject({ code: 'ADS_REPORT_FAILED' })
    expect(of('adsReportJob', 'update')[0].args.data.failureMessage).toContain('EXPIRED')
  })

  it('好了：按模板写入活动日指标，登记导入与跳过的行数、警告信号与历史可用起点', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': polling() })
    const text = [
      JSON.stringify({ date: '2026-10-03', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C1', impressions: 10, clicks: 2, cost: 1.5, sales: 9, purchases: 1 }),
      JSON.stringify({ date: '2026-10-01', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'C2', impressions: 5 }),
      JSON.stringify({ date: '2026-10-02', impressions: 3 }),
    ].join('\n')
    const state = { state: 'READY', reportId: 'RPT-1', shardUrls: ['u/1'], warnings: [{ code: 'DATA_DELAYED', message: '数据延迟' }] }
    const result = await runAdsReport(ctx, { reportJobId: 'job-1' }, deps(reporting(state), text))
    expect(result).toEqual({ ready: true, reportId: 'RPT-1', imported: 2, skipped: 1 })
    expect(of('adsAccount', 'upsert')).toHaveLength(1)
    const writes = of('adsMetric', 'upsert')
    expect(writes).toHaveLength(2)
    expect(writes[0].args.create).toMatchObject({ externalCampaignId: 'C1', entityType: 'CAMPAIGN', cost: 1.5, sales: 9, purchases: 1, adsAccountId: 'ACC-1', currency: 'USD' })
    // 第二行没给花费、销售额：create 里是 undefined（库里留空），不是 0
    expect(writes[1].args.create.cost).toBeUndefined()
    expect(writes[1].args.update.cost).toBeUndefined()
    const done = of('adsReportJob', 'update').pop()!.args.data
    expect(done).toMatchObject({ status: 'READY', importedRows: 2, skippedRows: 1, warningSignals: [{ code: 'DATA_DELAYED', message: '数据延迟' }] })
    const history = of('adsProfile', 'updateMany')[0].args
    expect(history.data.historyFrom).toEqual(new Date('2026-10-01T00:00:00Z'))
    expect(history.where.id).toBe('ap-1')
  })

  it('有行但一行都读不出来（字段名对不上）：任务失败并说明跳过原因，不登记历史可用起点', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': polling() })
    const text = JSON.stringify({ day: '2026-10-03', campaign: 'C1', imps: 4 })
    await expect(runAdsReport(ctx, { reportJobId: 'job-1' }, deps(reporting({ state: 'READY', reportId: 'RPT-1', shardUrls: ['u/1'], warnings: [] }), text))).rejects.toMatchObject({
      code: 'ADS_REPORT_ROWS_UNREADABLE',
    })
    expect(of('adsReportJob', 'update')[0].args.data.failureMessage).toContain('没有日期')
    expect(of('adsProfile', 'updateMany')).toHaveLength(0)
    expect(of('adsMetric', 'upsert')).toHaveLength(0)
  })

  it('空报告（亚马逊说完成但没有行）：任务算完成，导入 0 行，不登记历史可用起点', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': polling() })
    const result = await runAdsReport(ctx, { reportJobId: 'job-1' }, deps(reporting({ state: 'READY', reportId: 'RPT-1', shardUrls: ['u/1'], warnings: [] }), '[]'))
    expect(result).toMatchObject({ ready: true, imported: 0, skipped: 0 })
    expect(of('adsProfile', 'updateMany')).toHaveLength(0)
  })

  it('小时报告不登记历史可用起点（只有日粒度任务登记）', async () => {
    const { ctx, of } = recorder({ 'adsReportJob.findUnique': polling({ templateKey: 'CAMPAIGN_HOURLY' }) })
    const text = JSON.stringify({ hour: '2026-10-05T09:00:00Z', campaignId: 'C1', clicks: 3 })
    const result = await runAdsReport(ctx, { reportJobId: 'job-1' }, deps(reporting({ state: 'READY', reportId: 'RPT-1', shardUrls: ['u/1'], warnings: [] }), text))
    expect(result).toMatchObject({ imported: 1 })
    expect(of('adsPerformanceHourly', 'upsert')[0].args.create).toMatchObject({ entityType: 'CAMPAIGN', entityId: 'C1', clicks: 3 })
    expect(of('adsProfile', 'updateMany')).toHaveLength(0)
  })
})
