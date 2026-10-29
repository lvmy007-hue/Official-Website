// 关键词份额趋势（P6-29）。数据只来自品牌分析搜索查询表现，不是前台关键词排名。零 zod。

export const SHARE_TREND_READ = 'analytics.read'
export const SHARE_TREND_DISCLAIMER = '这不是前台排名，而是品牌分析搜索查询表现报告中的展示份额与点击份额。'
export const SHARE_TREND_PERIOD_LIMIT = 16
export const SHARE_TREND_ROW_LIMIT = 8000

export type ShareTrendState = 'OK' | 'NO_DATA' | 'RESTRICTED' | 'TRUNCATED'

export interface ShareTrendPoint {
  periodStart: string
  impressionShare: number | null
  clickShare: number | null
  searchVolume: number | null
}

export interface ShareTrendRaw {
  periodStart: string
  searchQuery: string
  impressionsOwn: number | null
  impressionsTotal: number | null
  clicksOwn: number | null
  clicksTotal: number | null
  searchVolume: number | null
}

export interface ShareTrendResponse {
  asin: string
  state: ShareTrendState
  message: string | null
  disclaimer: string
  points: ShareTrendPoint[]
  truncated: boolean
}

const share = (own: number, total: number) => (total > 0 ? Math.round((own / total) * 1_000_000) / 1_000_000 : null)

/**
 * 同一周期、同一搜索词只留展示次数最高的一行（多店不把市场总量相加）。
 * 周期超过上限时只留最近的若干周，并标明截断。
 */
export function aggregateShareTrend(rows: readonly ShareTrendRaw[], limit = SHARE_TREND_PERIOD_LIMIT): { points: ShareTrendPoint[]; truncated: boolean } {
  const byPeriod = new Map<string, Map<string, ShareTrendRaw>>()
  for (const row of rows) {
    const terms = byPeriod.get(row.periodStart) ?? new Map<string, ShareTrendRaw>()
    const prev = terms.get(row.searchQuery)
    if (!prev || (row.impressionsOwn ?? -1) > (prev.impressionsOwn ?? -1)) terms.set(row.searchQuery, row)
    byPeriod.set(row.periodStart, terms)
  }
  const days = [...byPeriod.keys()].sort()
  const truncated = days.length > limit
  const kept = truncated ? days.slice(days.length - limit) : days
  const points = kept.map(periodStart => {
    const terms = [...(byPeriod.get(periodStart)?.values() ?? [])]
    let impressionsOwn = 0
    let impressionsTotal = 0
    let clicksOwn = 0
    let clicksTotal = 0
    let volume = 0
    let volumeCount = 0
    let impressionRows = 0
    let clickRows = 0
    for (const term of terms) {
      if (term.impressionsOwn !== null && term.impressionsTotal !== null && term.impressionsTotal > 0) {
        impressionsOwn += term.impressionsOwn
        impressionsTotal += term.impressionsTotal
        impressionRows += 1
      }
      if (term.clicksOwn !== null && term.clicksTotal !== null && term.clicksTotal > 0) {
        clicksOwn += term.clicksOwn
        clicksTotal += term.clicksTotal
        clickRows += 1
      }
      if (term.searchVolume !== null) {
        volume += term.searchVolume
        volumeCount += 1
      }
    }
    return {
      periodStart,
      impressionShare: impressionRows > 0 ? share(impressionsOwn, impressionsTotal) : null,
      clickShare: clickRows > 0 ? share(clicksOwn, clicksTotal) : null,
      searchVolume: volumeCount > 0 ? volume : null,
    }
  })
  return { points, truncated }
}
