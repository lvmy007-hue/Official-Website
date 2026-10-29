import type { Readable } from 'node:stream'
import { ADS_REPORT_WINDOW, adsReportWindowIssue, type AdsReportGranularity } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { decodeUtf8, jsonRows, type Row } from '../streaming/rows'
import { drain, responseStream, type RawSink } from '../streaming/download'
import type { JsonObject } from '../types'
import type { AmazonAdsApiClient } from './amazon-ads-api'
import { ADS_V1_PREFIX } from './amazon-ads-api'
import { UpstreamHttpError } from './http-error'
import { assertRemoteUrl } from './remote-url'

// 新报告接口（Reporting API v1，importers.md A-02）：创建、轮询、分片下载，全程流式。
// 路径取自冻结文档：POST /adsApi/v1/create/reports 创建，POST /adsApi/v1/retrieve/reports 查询（按报告编号）。
// 【未对真实账户验证】请求体与响应的字段名（period、granularity、dimensions、metrics、status、shards）是按“自由组合维度与指标”的描述写的，
// 集中在 buildReportRequest 与 reportStateOf 两个纯函数里，第一次接真实账户时只改这里。官方限额很低（并发可低至 1、约 1 次/秒），
// 所以报告用单独的限速桶，并且不要并发创建（官方也建议大部分场景改用营销数据流）。

export const ADS_REPORT_FAMILY = 'ads-reporting-v1'

export type AdsReportSpec = {
  granularity: AdsReportGranularity
  /** 起止日期 YYYY-MM-DD，含起止。 */
  from: string
  to: string
  /** 企业数据口径时区的今天，用来检查时间范围上限。 */
  today: string
  dimensions: string[]
  metrics: string[]
  /** 广告产品筛选（SPONSORED_PRODUCTS 等）；不传就是全部产品。 */
  adProducts?: string[]
}

/** 活动 × 日的标准报告：A-02 的 AdsMetric 日指标（与旧版并行核对也用它）。 */
export const CAMPAIGN_DAILY_REPORT = {
  dimensions: ['date', 'adProduct', 'campaignId'],
  metrics: ['impressions', 'clicks', 'cost', 'sales', 'purchases'],
} as const

/** 创建报告的请求体；时间范围超限先拒绝（ADS_REPORT_WINDOW，不可重试：重试也不会变合法）。 */
export function buildReportRequest(spec: AdsReportSpec): JsonObject {
  const issue = adsReportWindowIssue(spec)
  if (issue) throw new NonRetryableError(ADS_REPORT_WINDOW, issue)
  if (spec.dimensions.length === 0 || spec.metrics.length === 0) throw new NonRetryableError(ADS_REPORT_WINDOW, '报告至少要选一个维度和一个指标')
  return {
    format: 'GZIP_JSON',
    period: { startDate: spec.from, endDate: spec.to },
    granularity: spec.granularity,
    dimensions: spec.dimensions,
    metrics: spec.metrics,
    ...(spec.adProducts && spec.adProducts.length > 0 ? { filters: { adProducts: spec.adProducts } } : {}),
  }
}

export type AdsReportWarning = { code: string; message: string }
export type AdsReportState =
  { state: 'PENDING'; reportId: string } | { state: 'FAILED'; reportId: string; reason: string } | { state: 'READY'; reportId: string; shardUrls: string[]; warnings: AdsReportWarning[] }

const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined)
const record = (value: unknown): JsonObject | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)

/** 警告信号：报告返回警告时保存信号并在页面角标提示，数据照常入库（ADS_WARNING_SIGNAL）。 */
export function parseWarnings(body: JsonObject): AdsReportWarning[] {
  const found = Array.isArray(body.warnings) ? body.warnings : Array.isArray(body.warningSignals) ? body.warningSignals : []
  return found.flatMap(item => {
    if (typeof item === 'string') return [{ code: item, message: item }]
    const entry = record(item)
    const code = text(entry?.code) ?? text(entry?.type)
    return entry && code ? [{ code, message: text(entry.message) ?? text(entry.description) ?? code }] : []
  })
}

/** 一次查询的响应（可能是单个报告对象，也可能是 { reports: [...] }）→ 报告状态。 */
export function reportStateOf(body: JsonObject, reportId: string): AdsReportState {
  const item = record(body.reports && Array.isArray(body.reports) ? body.reports[0] : body) ?? {}
  const status = String(item.status ?? item.state ?? 'PENDING').toUpperCase()
  if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(status)) return { state: 'FAILED', reportId, reason: status }
  if (!['COMPLETED', 'COMPLETE', 'SUCCESS', 'DONE', 'READY'].includes(status)) return { state: 'PENDING', reportId }
  const urls = [item.shards, item.urls, item.locations].flatMap(value => (Array.isArray(value) ? value : []))
  const shardUrls = [...urls.map(value => (typeof value === 'string' ? value : text(record(value)?.url))), text(item.url), text(item.downloadUrl)].filter((url): url is string => !!url)
  return { state: 'READY', reportId, shardUrls: [...new Set(shardUrls)], warnings: parseWarnings(item) }
}

export class AdsReportingV1 {
  constructor(
    private readonly client: Pick<AmazonAdsApiClient, 'request'>,
    readonly adsAccountId: string,
  ) {
    if (!adsAccountId) throw new Error('ADS_ACCOUNT_ID_REQUIRED')
  }

  private post(path: string, body: unknown): Promise<JsonObject> {
    return this.client.request({ method: 'POST', path: `${ADS_V1_PREFIX}${path}`, adsAccountId: this.adsAccountId, body, family: ADS_REPORT_FAMILY })
  }

  async create(spec: AdsReportSpec): Promise<string> {
    const body = await this.post('/create/reports', buildReportRequest(spec))
    const first = record(Array.isArray(body.reports) ? body.reports[0] : body) ?? {}
    const reportId = text(first.reportId) ?? text(first.id)
    if (!reportId) throw new Error('ADS_REPORT_ID_NOT_RETURNED')
    return reportId
  }

  async retrieve(reportId: string): Promise<AdsReportState> {
    return reportStateOf(await this.post('/retrieve/reports', { reportIds: [reportId] }), reportId)
  }
}

/** 轮询参数：测试里注入 sleep，生产用真实等待。 */
export type PollOptions = { sleep?: (ms: number) => Promise<void>; intervalMs?: number; maxPolls?: number }

/**
 * 创建并等到报告就绪。等太久抛可重试错误（普通 Error，任务运行时按重试处理），失败抛不可重试错误。
 * 只用于单次任务里可以等得起的小报告（核对）；大批量回补走“创建任务 + 轮询任务”的分步流程。
 */
export async function createAndAwait(api: Pick<AdsReportingV1, 'create' | 'retrieve'>, spec: AdsReportSpec, options: PollOptions = {}): Promise<Extract<AdsReportState, { state: 'READY' }>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const reportId = await api.create(spec)
  for (let poll = 0; poll < (options.maxPolls ?? 60); poll += 1) {
    const state = await api.retrieve(reportId)
    if (state.state === 'READY') return state
    if (state.state === 'FAILED') throw new NonRetryableError('ADS_REPORT_FAILED', `广告报告生成失败（${state.reason}）`)
    await sleep(options.intervalMs ?? 10_000)
  }
  throw new Error('ADS_REPORT_NOT_READY')
}

/** 打开一个分片的解压后字节流（流式）；原始字节同时写入 sink。下载地址是预签名的，不带广告请求头。 */
export async function openShard(url: string, options: { sink?: RawSink } = {}): Promise<Readable> {
  const response = await fetch(assertRemoteUrl(url, '广告报告分片下载地址'))
  if (!response.ok) throw new UpstreamHttpError(`ADS_REPORT_DOWNLOAD_${response.status}`, response.status, response.headers, 'download')
  return responseStream(response, { compression: 'auto', sink: options.sink })
}

/**
 * 逐个分片下载并逐条交出行（一次只打开一个分片，内存里只有当前一条记录）。
 * sinkFor：为第 index 个分片提供原始文件的去向；opener 默认用 openShard，测试里可以替换。
 */
export async function* shardRows(
  urls: string[],
  options: { sinkFor?: (index: number) => RawSink | undefined; open?: (url: string, options: { sink?: RawSink }) => Promise<Readable> } = {},
): AsyncGenerator<Row> {
  const open = options.open ?? openShard
  for (const [index, url] of urls.entries()) {
    const stream = await open(url, { sink: options.sinkFor?.(index) })
    yield* jsonRows(decodeUtf8(stream))
    await drain(stream)
  }
}
