import { adsAsinKey, adsRatios, asinAdsShare, mergeTotals, organicOf, stockOf, type AdsAsinRow, type AdsTotals } from '@nova/api-contracts'
import type { AsinFact, ProfileStore, ReportGroup } from './ads-products-load'

// 广告商品页的行装配（P3-09，纯函数，单测不碰数据库）：先把“广告档案 × ASIN × 活动”的分组合成“店铺 × ASIN”，再配上全部销售额、光环销售、广告数与库存。

export interface AsinAggregate {
  key: string
  asin: string
  storeId: string | null
  storeName: string | null
  totals: AdsTotals
  campaigns: number
}

const EMPTY_STORE: ProfileStore = { storeId: null, storeName: null }

/** 花费从高到低（空值在最后），并列按 ASIN 再按行键。 */
const bySpendDesc = (a: AsinAggregate, b: AsinAggregate): number => {
  if (a.totals.spend === null && b.totals.spend !== null) return 1
  if (a.totals.spend !== null && b.totals.spend === null) return -1
  if (a.totals.spend !== null && b.totals.spend !== null && a.totals.spend !== b.totals.spend) return b.totals.spend - a.totals.spend
  if (a.asin !== b.asin) return a.asin < b.asin ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** 把分组合成“店铺 × ASIN”：同一店铺下多个广告档案（不同站点）推广同一个 ASIN 合成一行；活动数按“档案 × 活动编号”去重。 */
export function aggregateGroups(groups: readonly ReportGroup[], stores: ReadonlyMap<string, ProfileStore>): AsinAggregate[] {
  const merged = new Map<string, AsinAggregate & { campaignKeys: Set<string> }>()
  for (const group of groups) {
    const store = stores.get(group.adsProfileId) ?? EMPTY_STORE
    const key = adsAsinKey(store.storeId, group.asin)
    const held = merged.get(key)
    if (held) {
      held.totals = mergeTotals(held.totals, group.totals)
      held.campaignKeys.add(`${group.adsProfileId}|${group.campaignId}`)
    } else {
      merged.set(key, {
        key,
        asin: group.asin,
        storeId: store.storeId,
        storeName: store.storeName,
        totals: group.totals,
        campaigns: 0,
        campaignKeys: new Set([`${group.adsProfileId}|${group.campaignId}`]),
      })
    }
  }
  return [...merged.values()].map(({ campaignKeys, ...rest }): AsinAggregate => ({ ...rest, campaigns: campaignKeys.size })).sort(bySpendDesc)
}

export interface RowFacts {
  /** `店铺|ASIN` → 全部销售额。 */
  totalSales: ReadonlyMap<string, number>
  /** 行键 → 光环销售；没有转化商品行的不在里面。 */
  halo: ReadonlyMap<string, number>
  /** 行键 → 广告数。 */
  ads: ReadonlyMap<string, { enabled: number; total: number }>
  /** `店铺|ASIN` → 商品资料与库存。 */
  facts: ReadonlyMap<string, AsinFact>
}

export function rowOf(aggregate: AsinAggregate, facts: RowFacts): AdsAsinRow {
  const storeKey = aggregate.storeId ? `${aggregate.storeId}|${aggregate.asin}` : null
  // 没有绑定店铺：拿不到该店铺的销售、商品资料与库存，全部留空，不猜
  const totalSales = storeKey ? (facts.totalSales.get(storeKey) ?? null) : null
  const fact = storeKey ? facts.facts.get(storeKey) : undefined
  const organic = organicOf(totalSales, aggregate.totals.sales)
  return {
    key: aggregate.key,
    asin: aggregate.asin,
    title: fact?.title ?? null,
    imageUrl: fact?.imageUrl ?? null,
    storeId: aggregate.storeId,
    storeName: aggregate.storeName,
    totals: aggregate.totals,
    ratios: adsRatios(aggregate.totals),
    totalSales,
    adsShare: asinAdsShare(aggregate.totals.spend, totalSales),
    organicSales: organic.value,
    organicIssue: organic.issue,
    haloSales: facts.halo.get(aggregate.key) ?? null,
    campaigns: aggregate.campaigns,
    ads: facts.ads.get(aggregate.key) ?? null,
    stock: stockOf(fact?.sellable ?? null),
    sellable: fact?.sellable ?? null,
    snapshotDate: fact?.snapshotDate ?? null,
  }
}
