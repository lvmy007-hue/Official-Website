import {
  ADS_PRODUCT_LABEL,
  EMPTY_ADS_TOTALS,
  addNullable,
  addTotals,
  adsRatios,
  asinAdsShare,
  organicOf,
  type AdsEntityMetrics,
  type AdsProductKey,
  type AdsSearchTermRow,
  type AdsTargetRow,
  type AdsTotals,
  type Asin360AdsAdGroupRow,
  type Asin360AdsCampaignRow,
  type Asin360AdsDailyPoint,
  type Asin360AdsSummary,
} from '@nova/api-contracts'

// ASIN 360 广告页签的纯函数（P3-19，单测不碰数据库）：逐日点、汇总、活动行与广告组行的装配、各块的排序与跨档案合并。
// 空值是 null，不是 0：没有记录的日子、没有指标的对象一律留空。

/** 花费从高到低，空值在最后；并列按名称再按键，保证排序稳定。普通字符串比较，不用 localeCompare。 */
export function bySpendDesc<T>(spendOf: (item: T) => number | null, nameOf: (item: T) => string, keyOf: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = spendOf(a)
    const right = spendOf(b)
    if (left === null && right !== null) return 1
    if (left !== null && right === null) return -1
    if (left !== null && right !== null && left !== right) return right - left
    const nameA = nameOf(a).toLowerCase()
    const nameB = nameOf(b).toLowerCase()
    if (nameA !== nameB) return nameA < nameB ? -1 : 1
    const keyA = keyOf(a)
    const keyB = keyOf(b)
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  }
}

/** 范围内每一天一个点：没有被推广商品行的日子广告列为空，没有 ASIN 日汇总的日子销售额与占比为空。 */
export function dailyPoints(days: readonly string[], ads: ReadonlyMap<string, AdsTotals>, totalSales: ReadonlyMap<string, number>): Asin360AdsDailyPoint[] {
  return days.map(date => {
    const day = ads.get(date)
    const sales = totalSales.get(date) ?? null
    return {
      date,
      impressions: day?.impressions ?? null,
      clicks: day?.clicks ?? null,
      spend: day?.spend ?? null,
      sales: day?.sales ?? null,
      orders: day ? day.orders : null,
      totalSales: sales,
      acos: day ? adsRatios(day).acos : null,
      adsShare: asinAdsShare(day?.spend ?? null, sales),
    }
  })
}

export interface SummaryInput {
  ads: ReadonlyMap<string, AdsTotals>
  totalSales: number | null
  campaigns: number
  adCount: { enabled: number; total: number } | null
}

export function summaryOf(input: SummaryInput): Asin360AdsSummary {
  const totals = input.ads.size > 0 ? addTotals([...input.ads.values()]) : EMPTY_ADS_TOTALS
  const organic = organicOf(input.totalSales, totals.sales)
  return {
    totals,
    ratios: adsRatios(totals),
    totalSales: input.totalSales,
    adsShare: asinAdsShare(totals.spend, input.totalSales),
    organicSales: organic.value,
    organicIssue: organic.issue,
    campaigns: input.campaigns,
    ads: input.adCount,
  }
}

export interface CampaignRecord {
  id: string
  adsProfileId: string
  externalCampaignId: string
  adProduct: string
  name: string
  state: string
}

export const profileCampaignKey = (adsProfileId: string, externalCampaignId: string) => `${adsProfileId}|${externalCampaignId}`

/** 同一个外部活动编号在不同广告产品下可能各有一条本地记录：被推广商品报表属于商品推广，优先取它，其余取第一条。 */
export function recordMap(records: readonly CampaignRecord[]): Map<string, CampaignRecord> {
  const map = new Map<string, CampaignRecord>()
  for (const record of records) {
    const key = profileCampaignKey(record.adsProfileId, record.externalCampaignId)
    const held = map.get(key)
    if (!held || (record.adProduct === 'SPONSORED_PRODUCTS' && held.adProduct !== 'SPONSORED_PRODUCTS')) map.set(key, record)
  }
  return map
}

export interface CampaignGroup {
  adsProfileId: string
  campaignId: string
  totals: AdsTotals
}

/** 活动行：先是有被推广商品行的活动（按花费从高到低，调用方已排好序），再是只有广告关联、没有报表行的活动（按名称）。 */
export function campaignRowsOf(
  groups: readonly CampaignGroup[],
  linked: ReadonlyArray<{ adsProfileId: string; campaignId: string }>,
  records: ReadonlyMap<string, CampaignRecord>,
): Asin360AdsCampaignRow[] {
  const rowOf = (adsProfileId: string, campaignId: string, metrics: AdsEntityMetrics | null): Asin360AdsCampaignRow => {
    const key = profileCampaignKey(adsProfileId, campaignId)
    const record = records.get(key)
    return {
      key,
      id: record?.id ?? null,
      adsProfileId,
      externalCampaignId: campaignId,
      name: record?.name ?? null,
      state: record?.state ?? null,
      productLabel: record ? (ADS_PRODUCT_LABEL[record.adProduct as AdsProductKey] ?? record.adProduct) : null,
      metrics,
    }
  }
  const seen = new Set(groups.map(group => profileCampaignKey(group.adsProfileId, group.campaignId)))
  const reported = groups.map(group => rowOf(group.adsProfileId, group.campaignId, { ...group.totals }))
  const onlyLinked = [...new Map(linked.map(item => [profileCampaignKey(item.adsProfileId, item.campaignId), item])).values()]
    .filter(item => !seen.has(profileCampaignKey(item.adsProfileId, item.campaignId)))
    .map(item => rowOf(item.adsProfileId, item.campaignId, null))
    .sort((a, b) => ((a.name ?? '').toLowerCase() < (b.name ?? '').toLowerCase() ? -1 : (a.name ?? '').toLowerCase() > (b.name ?? '').toLowerCase() ? 1 : a.key < b.key ? -1 : 1))
  return [...reported, ...onlyLinked]
}

export interface AdGroupRecord {
  id: string
  adsProfileId: string
  adGroupId: string
  campaignId: string
  name: string
  state: string
  defaultBid: number | null
}

export const groupKey = (adsProfileId: string, adGroupId: string) => `${adsProfileId}|${adGroupId}`

export interface AdGroupFacts {
  /** `档案|广告组` → 关联本 ASIN 的广告数。 */
  asinAds: ReadonlyMap<string, { enabled: number; total: number }>
  /** `档案|广告组` → 广告组里不同 ASIN 的个数。 */
  groupAsins: ReadonlyMap<string, number>
  /** `档案|活动` → 活动记录。 */
  campaigns: ReadonlyMap<string, CampaignRecord>
  /** `档案|广告组` → 广告组自己的指标合计。 */
  metrics: ReadonlyMap<string, AdsEntityMetrics>
}

export function adGroupRowsOf(groups: readonly AdGroupRecord[], facts: AdGroupFacts): Asin360AdsAdGroupRow[] {
  return groups
    .map((group): Asin360AdsAdGroupRow => {
      const key = groupKey(group.adsProfileId, group.adGroupId)
      const campaign = facts.campaigns.get(profileCampaignKey(group.adsProfileId, group.campaignId))
      return {
        id: group.id,
        adsProfileId: group.adsProfileId,
        adGroupId: group.adGroupId,
        name: group.name,
        state: group.state,
        defaultBid: group.defaultBid,
        externalCampaignId: group.campaignId,
        campaignName: campaign?.name ?? null,
        campaignId: campaign?.id ?? null,
        asinAds: facts.asinAds.get(key) ?? { enabled: 0, total: 0 },
        groupAsins: facts.groupAsins.get(key) ?? 0,
        metrics: facts.metrics.get(key) ?? null,
      }
    })
    .sort(
      bySpendDesc(
        row => row.metrics?.spend ?? null,
        row => row.name,
        row => `${row.adsProfileId}|${row.adGroupId}`,
      ),
    )
}

/** 多个广告档案的投放对象行合并后再按花费排序（只有一个档案时与原顺序一致）。 */
export const mergeTargetRows = (lists: readonly AdsTargetRow[][]): AdsTargetRow[] =>
  lists.flat().sort(
    bySpendDesc(
      row => row.metrics?.spend ?? null,
      row => row.expression,
      row => row.key,
    ),
  )

/** 多个广告档案的同一个搜索词合并（金额只要有一边给了就算已知）；状态以第一个出现的为准（各档案用各自的投放词判断，合并时不重判）。 */
export function mergeTerms(lists: readonly AdsSearchTermRow[][]): AdsSearchTermRow[] {
  const merged = new Map<string, AdsSearchTermRow>()
  for (const row of lists.flat()) {
    const held = merged.get(row.searchTerm)
    if (!held) {
      merged.set(row.searchTerm, { ...row, metrics: { ...row.metrics } })
      continue
    }
    held.metrics = {
      impressions: held.metrics.impressions + row.metrics.impressions,
      clicks: held.metrics.clicks + row.metrics.clicks,
      spend: addNullable([held.metrics.spend, row.metrics.spend]),
      sales: addNullable([held.metrics.sales, row.metrics.sales]),
      orders: held.metrics.orders + row.metrics.orders,
    }
  }
  return [...merged.values()].sort(
    bySpendDesc(
      row => row.metrics.spend,
      row => row.searchTerm,
      row => row.searchTerm,
    ),
  )
}
