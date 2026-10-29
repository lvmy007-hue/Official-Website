import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { ADS_ALERT_CURRENCY, DAY_MS, campaignKeyOf, campaignRef, dayText, loadCampaigns, loadProfileStores, money, num, percent, profileScope, utcDay, type CampaignKey } from './ads-common'
import { numberParam, scopeFilter } from './params'

// 广告高花费低产出预警评估器（P3-18，09 章 9.1 广告类）：广告日汇总（P3-04，活动级、美元）里，同一个活动在回看窗口内
// 花费与点击都达到下限，且广告销售额为 0（也没有订单），或广告成本销售比（花费 ÷ 销售额）不低于阈值。
// 窗口到昨天为止（今天的数据不全），因为广告转化有数天滞后，最近几天的销售额还会补记，所以默认看 7 天。
// 销售额没有数据（来源行都没给）的活动不判断，不当作 0；销售额为 0 但有订单的矛盾数据也不判断。
// 阈值是我们自定的默认值，不是亚马逊口径。不给影响金额：花出去的钱是否“浪费”取决于毛利与滞后补记，没有可靠依据。

const GROUP_LIMIT = 2000

export interface CampaignWindowRow extends CampaignKey {
  spend: number
  clicks: number
  orders: number
  /** 来源没给销售额为 null */
  sales: number | null
}

export interface LowReturnLimits {
  minSpend: number
  minClicks: number
  acosThreshold: number
}

export type LowReturnKind = 'NO_SALES' | 'HIGH_ACOS'
export interface LowReturnItem {
  row: CampaignWindowRow
  kind: LowReturnKind
  acos: number | null
}

/** 筛出高花费低产出的活动，花费高的排前面（纯函数）。 */
export function lowReturnRows(rows: readonly CampaignWindowRow[], limits: LowReturnLimits): LowReturnItem[] {
  return rows
    .flatMap((row): LowReturnItem[] => {
      if (row.spend < limits.minSpend || row.clicks < limits.minClicks || row.sales === null) return []
      if (row.sales <= 0) return row.orders === 0 ? [{ row, kind: 'NO_SALES', acos: null }] : []
      const acos = row.spend / row.sales
      return acos >= limits.acosThreshold ? [{ row, kind: 'HIGH_ACOS', acos }] : []
    })
    .sort((a, b) => b.row.spend - a.row.spend || (campaignKeyOf(a.row) < campaignKeyOf(b.row) ? -1 : 1))
}

export const adsLowReturnEvaluator: AlertEvaluator = {
  type: 'ads.high-spend-low-return',
  async evaluate({ db, tenantId, rule, now }) {
    const windowDays = numberParam(rule, 'windowDays', 7, { min: 1, max: 60 })
    const limits: LowReturnLimits = {
      minSpend: numberParam(rule, 'minSpend', 50, { min: 0.01, max: 1_000_000 }),
      minClicks: numberParam(rule, 'minClicks', 20, { min: 1, max: 1_000_000 }),
      acosThreshold: numberParam(rule, 'acosThreshold', 1, { min: 0.05, max: 100 }),
    }
    const scope = scopeFilter(rule)
    const today = utcDay(now)
    const groups = await db.adsDailySummary.groupBy({
      by: ['adsProfileId', 'adProduct', 'campaignId'],
      where: {
        tenantId,
        currency: ADS_ALERT_CURRENCY,
        campaignId: { not: '' },
        summaryDate: { gte: new Date(today - windowDays * DAY_MS), lte: new Date(today - DAY_MS) },
        ...profileScope(scope),
      },
      _sum: { spend: true, sales: true, clicks: true, orders: true },
      having: { spend: { _sum: { gte: limits.minSpend } } },
      orderBy: { _sum: { spend: 'desc' } },
      take: GROUP_LIMIT,
    })
    const rows = groups.map((group): CampaignWindowRow => ({
      adsProfileId: group.adsProfileId,
      adProduct: group.adProduct,
      campaignId: group.campaignId,
      spend: num(group._sum.spend) ?? 0,
      clicks: group._sum.clicks ?? 0,
      orders: group._sum.orders ?? 0,
      sales: num(group._sum.sales),
    }))
    const abnormal = lowReturnRows(rows, limits)
    if (abnormal.length === 0) return []

    const [campaigns, stores] = await Promise.all([
      loadCampaigns(
        db,
        tenantId,
        abnormal.map(item => item.row),
      ),
      loadProfileStores(
        db,
        tenantId,
        abnormal.map(item => item.row.adsProfileId),
      ),
    ])
    const range = `${dayText(today - windowDays * DAY_MS)} 至 ${dayText(today - DAY_MS)}`
    return abnormal.map(({ row, kind, acos }): AlertHit => {
      const ref = campaignRef(row, campaigns.get(campaignKeyOf(row)))
      const storeId = stores.storeOf.get(row.adsProfileId) ?? null
      const store = storeId ? (stores.storeName.get(storeId) ?? '店铺') : null
      return {
        entityType: ref.entityType,
        entityId: ref.entityId,
        sellerAccountId: storeId,
        entityLabel: store ? `${ref.name}（${store}）` : ref.name,
        title:
          kind === 'NO_SALES'
            ? `广告活动“${ref.name}”近 ${windowDays} 天花费 ${ADS_ALERT_CURRENCY} ${money(row.spend)}、点击 ${row.clicks} 次，没有广告销售额`
            : `广告活动“${ref.name}”近 ${windowDays} 天广告成本销售比 ${percent(acos ?? 0)}（花 ${ADS_ALERT_CURRENCY} ${money(row.spend)}，卖 ${ADS_ALERT_CURRENCY} ${money(row.sales ?? 0)}）`,
        suggestedAction: '到广告活动详情查看搜索词、投放对象与广告位的花费分布：先否定无转化的搜索词、降低高成本投放对象的竞价，仍无改善再考虑暂停；最近几天的销售额可能还没回传，请对照更长的周期',
        evidence: {
          kind,
          campaignName: ref.name,
          adProduct: row.adProduct,
          storeName: store,
          range,
          currency: ADS_ALERT_CURRENCY,
          spend: money(row.spend),
          clicks: row.clicks,
          orders: row.orders,
          sales: row.sales === null ? null : money(row.sales),
          acos,
          acosThreshold: limits.acosThreshold,
        },
      }
    })
  },
}
