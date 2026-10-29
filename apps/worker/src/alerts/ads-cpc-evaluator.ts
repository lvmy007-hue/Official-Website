import { adsCpc } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { ADS_ALERT_CURRENCY, DAY_MS, campaignKeyOf, campaignRef, dayText, loadCampaigns, loadProfileStores, money, num, profileScope, utcDay, type CampaignKey } from './ads-common'
import { numberParam, scopeFilter } from './params'

// 单次点击成本突增预警评估器（P3-18，09 章 9.1 广告类）：广告日汇总（活动级、美元）里，同一个活动最近 N 天（到昨天为止）的单次点击成本
// （花费 ÷ 点击）不低于它此前基线期成本的指定倍数，且最近与基线的点击都达到下限。花费没有数据（为空）或没有点击的，算不出成本，不判断。
// 这是日级判断：营销数据流的小时数据接收端暂缓（14.10），建成前做不到日内实时；今日广告页的“今日异常”用的是小时数据，规则口径相近但不是同一个。
// 影响金额 = （最近成本 - 基线成本）× 最近点击数：同样的点击量比基线多花的钱，是算术事实，不是预测。

const GROUP_LIMIT = 2000

export interface CpcWindow {
  spend: number | null
  clicks: number
}
export interface CpcLimits {
  ratio: number
  minClicks: number
  minBaselineClicks: number
}
export interface CpcSurgeRow {
  recentCpc: number
  baselineCpc: number
  ratio: number
  extraSpend: number
}

/** 单个活动的最近期与基线期是否构成突增；任何一边算不出成本或样本不够返回 null（纯函数）。 */
export function cpcSurgeOf(recent: CpcWindow, baseline: CpcWindow | undefined, limits: CpcLimits): CpcSurgeRow | null {
  if (!baseline || recent.clicks < limits.minClicks || baseline.clicks < limits.minBaselineClicks) return null
  const recentCpc = adsCpc(recent.spend, recent.clicks)
  const baselineCpc = adsCpc(baseline.spend, baseline.clicks)
  if (recentCpc === null || baselineCpc === null) return null
  const ratio = recentCpc / baselineCpc
  return ratio >= limits.ratio ? { recentCpc, baselineCpc, ratio, extraSpend: (recentCpc - baselineCpc) * recent.clicks } : null
}

export const adsCpcSurgeEvaluator: AlertEvaluator = {
  type: 'ads.cpc-surge',
  async evaluate({ db, tenantId, rule, now }) {
    const recentDays = numberParam(rule, 'recentDays', 3, { min: 1, max: 14 })
    const baselineDays = numberParam(rule, 'baselineDays', 14, { min: 3, max: 60 })
    const limits: CpcLimits = {
      ratio: numberParam(rule, 'ratio', 1.5, { min: 1.05, max: 20 }),
      minClicks: numberParam(rule, 'minClicks', 30, { min: 1, max: 1_000_000 }),
      minBaselineClicks: numberParam(rule, 'minBaselineClicks', 100, { min: 1, max: 1_000_000 }),
    }
    const scope = scopeFilter(rule)
    const today = utcDay(now)
    const recentFrom = today - recentDays * DAY_MS
    const baselineFrom = recentFrom - baselineDays * DAY_MS
    const base = { tenantId, currency: ADS_ALERT_CURRENCY, campaignId: { not: '' }, ...profileScope(scope) }

    const recentGroups = await db.adsDailySummary.groupBy({
      by: ['adsProfileId', 'adProduct', 'campaignId'],
      where: { ...base, summaryDate: { gte: new Date(recentFrom), lte: new Date(today - DAY_MS) } },
      _sum: { spend: true, clicks: true },
      having: { clicks: { _sum: { gte: limits.minClicks } } },
      orderBy: { _sum: { spend: 'desc' } },
      take: GROUP_LIMIT,
    })
    if (recentGroups.length === 0) return []
    // 基线只读这些活动：档案与活动编号各取并集，再按完整键对上
    const baselineGroups = await db.adsDailySummary.groupBy({
      by: ['adsProfileId', 'adProduct', 'campaignId'],
      where: {
        ...base,
        adsProfileId: { in: [...new Set(recentGroups.map(group => group.adsProfileId))] },
        campaignId: { in: [...new Set(recentGroups.map(group => group.campaignId))] },
        summaryDate: { gte: new Date(baselineFrom), lt: new Date(recentFrom) },
      },
      _sum: { spend: true, clicks: true },
      orderBy: { _sum: { spend: 'desc' } },
      take: GROUP_LIMIT * 2,
    })
    const baselineOf = new Map(baselineGroups.map(group => [campaignKeyOf(group), { spend: num(group._sum.spend), clicks: group._sum.clicks ?? 0 }]))

    const surged = recentGroups
      .flatMap(group => {
        const key: CampaignKey = { adsProfileId: group.adsProfileId, adProduct: group.adProduct, campaignId: group.campaignId }
        const recent = { spend: num(group._sum.spend), clicks: group._sum.clicks ?? 0 }
        const surge = cpcSurgeOf(recent, baselineOf.get(campaignKeyOf(key)), limits)
        return surge ? [{ key, recent, baseline: baselineOf.get(campaignKeyOf(key)) as CpcWindow, surge }] : []
      })
      .sort((a, b) => b.surge.extraSpend - a.surge.extraSpend || (campaignKeyOf(a.key) < campaignKeyOf(b.key) ? -1 : 1))
    if (surged.length === 0) return []

    const [campaigns, stores] = await Promise.all([
      loadCampaigns(
        db,
        tenantId,
        surged.map(item => item.key),
      ),
      loadProfileStores(
        db,
        tenantId,
        surged.map(item => item.key.adsProfileId),
      ),
    ])
    const recentRange = `${dayText(recentFrom)} 至 ${dayText(today - DAY_MS)}`
    const baselineRange = `${dayText(baselineFrom)} 至 ${dayText(recentFrom - DAY_MS)}`
    return surged.map(({ key, recent, baseline, surge }): AlertHit => {
      const ref = campaignRef(key, campaigns.get(campaignKeyOf(key)))
      const storeId = stores.storeOf.get(key.adsProfileId) ?? null
      const store = storeId ? (stores.storeName.get(storeId) ?? '店铺') : null
      const extra = money(surge.extraSpend)
      return {
        entityType: ref.entityType,
        entityId: ref.entityId,
        sellerAccountId: storeId,
        entityLabel: store ? `${ref.name}（${store}）` : ref.name,
        title: `广告活动“${ref.name}”近 ${recentDays} 天单次点击成本 ${ADS_ALERT_CURRENCY} ${money(surge.recentCpc)}，是此前 ${baselineDays} 天（${money(surge.baselineCpc)}）的 ${Math.round(surge.ratio * 100) / 100} 倍`,
        suggestedAction: '到广告活动详情的投放对象与广告位页签看是哪些词或位置变贵：竞价是否被抬高、是否有新的高价词、竞争是否加剧；确认不合理就降价或暂停对应投放对象',
        evidence: {
          campaignName: ref.name,
          adProduct: key.adProduct,
          storeName: store,
          currency: ADS_ALERT_CURRENCY,
          recentRange,
          baselineRange,
          recentCpc: money(surge.recentCpc),
          baselineCpc: money(surge.baselineCpc),
          ratio: surge.ratio,
          threshold: limits.ratio,
          recentClicks: recent.clicks,
          baselineClicks: baseline.clicks,
          recentSpend: recent.spend === null ? null : money(recent.spend),
          extraSpend: extra,
        },
        impact: { min: extra, max: extra, currency: ADS_ALERT_CURRENCY },
      }
    })
  },
}
