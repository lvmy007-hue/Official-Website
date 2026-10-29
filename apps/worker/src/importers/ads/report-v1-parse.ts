import type { Row } from '../../streaming/rows'

// 新报告接口（Reporting API v1）的行解析（纯函数）。**列名没有对照真实报告**：这里按 CAMPAIGN_DAILY_REPORT 请求的维度与指标名读取，
// 同时兼容旧版常见别名（spend、sales7d、purchases7d）；缺失的指标记为 null（“没给”），不当成 0。

export type AdsDayMetric = {
  /** 流量日期 YYYY-MM-DD（新报告按流量日期归因）。 */
  date: string
  campaignId: string
  adProduct: string
  impressions: number | null
  clicks: number | null
  cost: number | null
  sales: number | null
  purchases: number | null
}

export type AdsRowSkip = { skipped: 'NO_DATE' | 'NO_CAMPAIGN' }

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/

export function numberOf(row: Row, names: string[]): number | null {
  for (const name of names) {
    const value = row[name]
    if (value === undefined || value === null || value === '') continue
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export const textOf = (row: Row, names: string[]) => {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

export function parseCampaignDailyRow(row: Row): AdsDayMetric | AdsRowSkip {
  const date = DATE_PREFIX.exec(textOf(row, ['date', 'reportDate', 'startDate']))?.[1]
  if (!date) return { skipped: 'NO_DATE' }
  const campaignId = textOf(row, ['campaignId', 'campaign_id'])
  if (!campaignId) return { skipped: 'NO_CAMPAIGN' }
  return {
    date,
    campaignId,
    adProduct: textOf(row, ['adProduct', 'adProductType']).toUpperCase() || 'UNKNOWN',
    impressions: numberOf(row, ['impressions']),
    clicks: numberOf(row, ['clicks']),
    cost: numberOf(row, ['cost', 'spend']),
    sales: numberOf(row, ['sales', 'sales7d', 'sales14d']),
    purchases: numberOf(row, ['purchases', 'orders', 'purchases7d', 'purchases14d']),
  }
}

export type AdsDayParseStats = { read: number; skipped: number; skippedReasons: Record<string, number> }

/** 行流 → 活动日指标流；跳过的行计数（缺日期与缺活动编号的行不写、不猜）。 */
export async function* campaignDailyMetrics(rows: AsyncIterable<Row>, stats: AdsDayParseStats = { read: 0, skipped: 0, skippedReasons: {} }): AsyncGenerator<AdsDayMetric> {
  for await (const row of rows) {
    stats.read += 1
    const parsed = parseCampaignDailyRow(row)
    if ('skipped' in parsed) {
      stats.skipped += 1
      stats.skippedReasons[parsed.skipped] = (stats.skippedReasons[parsed.skipped] ?? 0) + 1
    } else yield parsed
  }
}
