import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { ADS_REPORT_WINDOW } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { describe, expect, it, vi } from 'vitest'
import type { Row } from '../streaming/rows'
import { decodeStream } from '../streaming/download'
import { ADS_REPORT_FAMILY, AdsReportingV1, CAMPAIGN_DAILY_REPORT, buildReportRequest, createAndAwait, parseWarnings, reportStateOf, shardRows, type AdsReportSpec } from './ads-v1-reports'

const ACCOUNT = 'amzn1.ads-account.g.test'
const spec = (over: Partial<AdsReportSpec> = {}): AdsReportSpec => ({
  granularity: 'DAILY',
  from: '2026-10-10',
  to: '2026-10-23',
  today: '2026-10-23',
  dimensions: [...CAMPAIGN_DAILY_REPORT.dimensions],
  metrics: [...CAMPAIGN_DAILY_REPORT.metrics],
  ...over,
})

describe('创建报告的请求体', () => {
  it('按“自由组合维度与指标”组装：起止日期、粒度、维度、指标；指定产品时带筛选', () => {
    expect(buildReportRequest(spec())).toEqual({
      format: 'GZIP_JSON',
      period: { startDate: '2026-10-10', endDate: '2026-10-23' },
      granularity: 'DAILY',
      dimensions: ['date', 'adProduct', 'campaignId'],
      metrics: ['impressions', 'clicks', 'cost', 'sales', 'purchases'],
    })
    expect(buildReportRequest(spec({ adProducts: ['SPONSORED_PRODUCTS'] })).filters).toEqual({ adProducts: ['SPONSORED_PRODUCTS'] })
  })

  it('时间范围超限：以不可重试的 ADS_REPORT_WINDOW 拒绝，请求不会发出', async () => {
    expect(() => buildReportRequest(spec({ from: '2026-01-01' }))).toThrow(NonRetryableError)
    try {
      buildReportRequest(spec({ from: '2026-01-01' }))
    } catch (error) {
      expect(error).toMatchObject({ code: ADS_REPORT_WINDOW, retryable: false })
      expect((error as Error).message).toContain('最多取 120 天')
    }
    const request = vi.fn()
    await expect(new AdsReportingV1({ request } as never, ACCOUNT).create(spec({ granularity: 'HOURLY', from: '2026-10-01' }))).rejects.toMatchObject({ code: ADS_REPORT_WINDOW })
    expect(request).not.toHaveBeenCalled()
  })

  it('没有维度或没有指标也拒绝', () => {
    expect(() => buildReportRequest(spec({ dimensions: [] }))).toThrow('至少要选')
    expect(() => buildReportRequest(spec({ metrics: [] }))).toThrow('至少要选')
  })
})

describe('创建与查询走报告专用限速桶', () => {
  it('创建发到 /adsApi/v1/create/reports 并带账户编号，返回报告编号；响应里没有编号是错误', async () => {
    const request = vi.fn(async () => ({ reports: [{ reportId: 'rep-1' }] }))
    const api = new AdsReportingV1({ request } as never, ACCOUNT)
    expect(await api.create(spec())).toBe('rep-1')
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/adsApi/v1/create/reports', adsAccountId: ACCOUNT, family: ADS_REPORT_FAMILY })
    await expect(new AdsReportingV1({ request: vi.fn(async () => ({})) } as never, ACCOUNT).create(spec())).rejects.toThrow('ADS_REPORT_ID_NOT_RETURNED')
  })

  it('查询发到 /adsApi/v1/retrieve/reports，按报告编号', async () => {
    const request = vi.fn(async () => ({ reports: [{ status: 'PROCESSING' }] }))
    const state = await new AdsReportingV1({ request } as never, ACCOUNT).retrieve('rep-1')
    expect(state).toEqual({ state: 'PENDING', reportId: 'rep-1' })
    expect(request.mock.calls[0][0]).toMatchObject({ path: '/adsApi/v1/retrieve/reports', body: { reportIds: ['rep-1'] }, family: ADS_REPORT_FAMILY })
  })
})

describe('报告状态与警告信号', () => {
  it('完成：取出所有分片地址（去重），带上警告信号', () => {
    const state = reportStateOf(
      { reports: [{ status: 'completed', shards: ['https://x/1', { url: 'https://x/2' }, 'https://x/1'], warnings: [{ code: 'DATA_DELAYED', message: '近一天数据可能延迟' }, 'PARTIAL'] }] },
      'r',
    )
    expect(state).toEqual({
      state: 'READY',
      reportId: 'r',
      shardUrls: ['https://x/1', 'https://x/2'],
      warnings: [
        { code: 'DATA_DELAYED', message: '近一天数据可能延迟' },
        { code: 'PARTIAL', message: 'PARTIAL' },
      ],
    })
  })

  it('单个下载地址也认；处理中、排队中是等待；失败、取消、过期是失败', () => {
    expect(reportStateOf({ status: 'DONE', url: 'https://x/a' }, 'r')).toMatchObject({ state: 'READY', shardUrls: ['https://x/a'] })
    for (const status of ['PENDING', 'PROCESSING', 'IN_PROGRESS', undefined]) expect(reportStateOf({ status }, 'r').state).toBe('PENDING')
    for (const status of ['FAILED', 'CANCELLED', 'EXPIRED']) expect(reportStateOf({ status }, 'r')).toEqual({ state: 'FAILED', reportId: 'r', reason: status })
  })

  it('警告信号：没有、格式不认识的都忽略，不报错', () => {
    expect(parseWarnings({})).toEqual([])
    expect(parseWarnings({ warningSignals: [{ type: 'X' }, { nothing: 1 }, 5] })).toEqual([{ code: 'X', message: 'X' }])
  })
})

describe('等待报告就绪', () => {
  const noWait = { sleep: async () => undefined }

  it('先等待再就绪：按间隔轮询直到完成', async () => {
    const states = [
      { state: 'PENDING', reportId: 'r' },
      { state: 'PENDING', reportId: 'r' },
      { state: 'READY', reportId: 'r', shardUrls: ['u'], warnings: [] },
    ]
    const api = { create: vi.fn(async () => 'r'), retrieve: vi.fn(async () => states.shift()) }
    const sleep = vi.fn(async () => undefined)
    const ready = await createAndAwait(api as never, spec(), { sleep, intervalMs: 5 })
    expect(ready.shardUrls).toEqual(['u'])
    expect(api.retrieve).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5)
  })

  it('报告失败：不可重试；等太久：普通错误（任务运行时会重试）', async () => {
    const failed = { create: async () => 'r', retrieve: async () => ({ state: 'FAILED', reportId: 'r', reason: 'FAILED' }) }
    await expect(createAndAwait(failed as never, spec(), noWait)).rejects.toMatchObject({ code: 'ADS_REPORT_FAILED', retryable: false })
    const slow = { create: async () => 'r', retrieve: async () => ({ state: 'PENDING', reportId: 'r' }) }
    const error = await createAndAwait(slow as never, spec(), { ...noWait, maxPolls: 3 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(NonRetryableError)
    expect((error as Error).message).toBe('ADS_REPORT_NOT_READY')
  })
})

describe('分片下载（流式）', () => {
  const stream = (text: string, gzip = false) => decodeStream(Readable.from([gzip ? gzipSync(text) : Buffer.from(text)]))
  const collect = async (rows: AsyncIterable<Row>) => {
    const out: Row[] = []
    for await (const row of rows) out.push(row)
    return out
  }

  it('按顺序一个分片一个分片地读：压缩与未压缩的混用、逐行 JSON 与 JSON 数组混用', async () => {
    const files: Record<string, Readable> = {
      'u/1': stream('{"campaignId":"a","cost":1}\n{"campaignId":"b","cost":2}\n', true),
      'u/2': stream('[{"campaignId":"c","cost":3}]'),
    }
    const opened: string[] = []
    const open = vi.fn(async (url: string) => {
      opened.push(url)
      return files[url]
    })
    const rows = await collect(shardRows(['u/1', 'u/2'], { open }))
    expect(rows.map(row => row.campaignId)).toEqual(['a', 'b', 'c'])
    expect(opened).toEqual(['u/1', 'u/2'])
  })

  it('下载某个分片失败：错误向上抛，前面分片的行已经交出', async () => {
    const open = vi.fn(async (url: string) => {
      if (url === 'u/2') throw new Error('ADS_REPORT_DOWNLOAD_500')
      return stream('{"campaignId":"a"}\n')
    })
    const seen: Row[] = []
    await expect(
      (async () => {
        for await (const row of shardRows(['u/1', 'u/2'], { open })) seen.push(row)
      })(),
    ).rejects.toThrow('ADS_REPORT_DOWNLOAD_500')
    expect(seen).toHaveLength(1)
  })

  it('没有分片就没有行', async () => {
    expect(await collect(shardRows([], { open: vi.fn() }))).toEqual([])
  })
})
