import type { Readable } from 'node:stream'
import { dayStamp } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { CAMPAIGN_DAILY_REPORT, createAndAwait, shardRows, type AdsReportingV1, type PollOptions } from '../connectors/ads-v1-reports'
import { campaignDailyMetrics, type AdsDayMetric } from '../importers/ads/report-v1-parse'
import type { RawSink } from '../streaming/download'
import type { ImportContext } from '../types'
import { compareAds, type LegacyAdsDay } from './compare-ads'
import { ensureAdsParityState, saveAdsParityRun, type SavedAdsParity } from './ads-store'
import { shouldRunParity } from './store'

// 广告核对运行器（P3-01，A-04）：同一时间窗内，旧版日指标（已入库的 AdsMetric）与新报告接口（刚下载的报告）各取一遍，逐行比对后落核对记录。
// 只读：不改业务表。旧版近 14 天没有任何数据时记为“旧版不可用”，不算通过也不算失败。
// 触发（每日一次）由后续包接入：广告账户的全球编号在 P3-02 的迁移里才有，调度现在没有可用的输入。

/** 核对时间窗：最近 14 天（含今天）。 */
export const ADS_PARITY_WINDOW_DAYS = 14
/** 两边最多各读这么多行（Prisma 的 take 上限是 20000）；超过就不核对，免得截断造成假差异。 */
export const ADS_PARITY_ROW_LIMIT = 19_999

const DAY_MS = 86_400_000
export function shiftDay(day: string, days: number): string {
  const stamp = dayStamp(day)
  if (stamp === null) throw new Error('ADS_PARITY_BAD_DAY')
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10)
}

export type AdsParityOutcome = { ran: false } | ({ ran: true } & SavedAdsParity)

export type AdsParityDeps = {
  reporting: Pick<AdsReportingV1, 'create' | 'retrieve'>
  /** 企业数据口径时区的今天。 */
  today: string
  now?: () => Date
  poll?: PollOptions
  open?: (url: string, options: { sink?: RawSink }) => Promise<Readable>
}

async function loadLegacy(ctx: ImportContext, adsProfileId: string, window: { from: string; to: string }): Promise<LegacyAdsDay[]> {
  const rows = await ctx.prisma.adsMetric.findMany({
    where: { adsProfileId, entityType: 'CAMPAIGN', reportDate: { gte: new Date(`${window.from}T00:00:00Z`), lt: new Date(`${shiftDay(window.to, 1)}T00:00:00Z`) } },
    select: { reportDate: true, externalCampaignId: true, adProduct: true, impressions: true, clicks: true, cost: true, sales: true, purchases: true },
    take: ADS_PARITY_ROW_LIMIT,
  })
  if (rows.length >= ADS_PARITY_ROW_LIMIT) throw new NonRetryableError('ADS_PARITY_TOO_LARGE', '旧版日指标行数过多，核对窗口需要缩小')
  return rows
    .filter(row => row.externalCampaignId)
    .map(row => ({
      date: row.reportDate.toISOString().slice(0, 10),
      campaignId: row.externalCampaignId as string,
      adProduct: row.adProduct,
      impressions: row.impressions,
      clicks: row.clicks,
      cost: row.cost === null ? null : Number(row.cost),
      sales: row.sales === null ? null : Number(row.sales),
      purchases: row.purchases,
    }))
}

async function downloadNew(deps: AdsParityDeps, window: { from: string; to: string }) {
  const ready = await createAndAwait(
    deps.reporting,
    { granularity: 'DAILY', ...window, today: deps.today, dimensions: [...CAMPAIGN_DAILY_REPORT.dimensions], metrics: [...CAMPAIGN_DAILY_REPORT.metrics] },
    deps.poll,
  )
  const rows: AdsDayMetric[] = []
  for await (const row of campaignDailyMetrics(shardRows(ready.shardUrls, { open: deps.open }))) {
    rows.push(row)
    if (rows.length >= ADS_PARITY_ROW_LIMIT) throw new NonRetryableError('ADS_PARITY_TOO_LARGE', '新报告行数过多，核对窗口需要缩小')
  }
  return { rows, warnings: ready.warnings }
}

export async function runAdsParity(ctx: ImportContext, scope: { tenantId: string; adsProfileId: string }, deps: AdsParityDeps): Promise<AdsParityOutcome> {
  const now = deps.now ?? (() => new Date())
  const startedAt = now()
  const state = await ensureAdsParityState(ctx.prisma, scope)
  if (!shouldRunParity(state, startedAt)) return { ran: false }
  const window = { from: shiftDay(deps.today, -(ADS_PARITY_WINDOW_DAYS - 1)), to: deps.today }
  const legacy = await loadLegacy(ctx, scope.adsProfileId, window)
  if (legacy.length === 0) {
    ctx.logger.warn({ adsProfileId: scope.adsProfileId }, 'no legacy ads metrics in window; parity skipped')
    return { ran: true, ...(await saveAdsParityRun(ctx.prisma, scope, { window, report: null, warningCount: 0, startedAt, now: now() })) }
  }
  const products = await ctx.prisma.adsReportJob.findMany({ where: { adsProfileId: scope.adsProfileId }, distinct: ['adProduct'], select: { adProduct: true }, take: 50 })
  const legacyAdProducts = new Set([...products.map(row => row.adProduct), ...legacy.map(row => row.adProduct)])
  const next = await downloadNew(deps, window)
  const report = compareAds({ legacy, next: next.rows, today: deps.today, legacyAdProducts, warnings: next.warnings })
  return { ran: true, ...(await saveAdsParityRun(ctx.prisma, scope, { window, report, warningCount: next.warnings.length, startedAt, now: now() })) }
}
