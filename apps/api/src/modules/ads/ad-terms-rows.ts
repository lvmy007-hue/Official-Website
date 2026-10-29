import {
  addTotals,
  adsRatios,
  compareTermRows,
  termAnomaliesOf,
  termKey,
  termRowStatus,
  termStatus,
  type AdsRatios,
  type AdsTermStatus,
  type AdsTotals,
  type AdTermAnomaly,
  type AdTermCampaigns,
  type AdTermSort,
  type AdTermSearchRow,
  type AdTermTargetRow,
} from '@nova/api-contracts'

// 词级中心的行装配（P3-10）：纯函数，不碰数据库。输入是数据库已经按“档案 × 活动 × 词”聚合好的分组，这里在内存里合并成“词”一行并判断状态与异常分组。

/** 词级报表（搜索词层）按“广告档案 × 活动 × 搜索词”分组后的合计。 */
export interface TermGroup {
  adsProfileId: string
  campaignId: string
  term: string
  totals: AdsTotals
}

/** 每个活动里已投放的词与已否定的词（归一化后的文字，键是 `档案|活动`）。 */
export interface Targeting {
  targeted: ReadonlyMap<string, ReadonlySet<string>>
  negated: ReadonlyMap<string, ReadonlySet<string>>
}

/** 按页面选的字段排序（空值在最后，并列按词与键，翻页顺序稳定）；不改动输入数组。 */
export function sortTermRows<T extends { totals: AdsTotals; ratios: AdsRatios }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  labelOf: (row: T) => string,
  sort: AdTermSort,
  dir: 'asc' | 'desc',
): T[] {
  const entries = rows.map(row => ({ row, key: keyOf(row), label: labelOf(row), totals: row.totals, ratios: row.ratios }))
  entries.sort((a, b) => compareTermRows(a, b, sort, dir))
  return entries.map(entry => entry.row)
}

export const campaignKey = (adsProfileId: string, campaignId: string) => `${adsProfileId}|${campaignId}`
const NONE: ReadonlySet<string> = new Set()

/** 把词按归一化文字合并（不分大小写、合并空格）：合计、在每个活动里的状态、店铺数。显示文字取花费最高的那种写法（输入已按花费降序）。 */
export interface TermAggregate {
  key: string
  term: string
  totals: AdsTotals
  campaigns: AdTermCampaigns
  status: AdsTermStatus
  stores: number
}

export function aggregateTerms(groups: readonly TermGroup[], targeting: Targeting, storeOf: (adsProfileId: string) => string | null): TermAggregate[] {
  type Held = { term: string; totals: AdsTotals[]; campaigns: Map<string, AdsTermStatus>; stores: Set<string> }
  const held = new Map<string, Held>()
  for (const group of groups) {
    const key = termKey(group.term)
    if (!key) continue
    const entry: Held = held.get(key) ?? { term: group.term, totals: [], campaigns: new Map(), stores: new Set() }
    entry.totals.push(group.totals)
    const campaign = campaignKey(group.adsProfileId, group.campaignId)
    entry.campaigns.set(campaign, termStatus(group.term, targeting.targeted.get(campaign) ?? NONE, targeting.negated.get(campaign) ?? NONE))
    const store = storeOf(group.adsProfileId)
    if (store) entry.stores.add(store)
    held.set(key, entry)
  }
  return [...held.entries()].map(([key, entry]): TermAggregate => {
    const statuses = [...entry.campaigns.values()]
    const campaigns: AdTermCampaigns = { total: statuses.length, targeted: statuses.filter(status => status === 'TARGETED').length, negated: statuses.filter(status => status === 'NEGATED').length }
    return { key, term: entry.term, totals: addTotals(entry.totals), campaigns, status: termRowStatus(campaigns), stores: entry.stores.size }
  })
}

/** 一个搜索词的异常分组（加词与否定候选只对还没投放的词成立）。 */
export const searchAnomalies = (aggregate: TermAggregate): AdTermAnomaly[] => termAnomaliesOf(aggregate.totals, { kind: 'search-term', status: aggregate.status })

export function searchRowOf(aggregate: TermAggregate): AdTermSearchRow {
  return {
    key: aggregate.key,
    searchTerm: aggregate.term,
    status: aggregate.status,
    campaigns: aggregate.campaigns,
    stores: aggregate.stores,
    totals: aggregate.totals,
    ratios: adsRatios(aggregate.totals),
    anomalies: searchAnomalies(aggregate),
  }
}

/** 词级报表（投放层）按“档案 × 活动 × 广告组 × 投放词 × 匹配方式”分组后的一行。 */
export interface TargetGroup {
  adsProfileId: string
  campaignId: string
  adGroupId: string | null
  targetId: string | null
  expression: string
  matchType: string | null
  campaignName: string | null
  adGroupName: string | null
  totals: AdsTotals
}

export const targetKeyOf = (group: Pick<TargetGroup, 'adsProfileId' | 'campaignId' | 'adGroupId' | 'targetId' | 'expression' | 'matchType'>): string =>
  [group.adsProfileId, group.campaignId, group.adGroupId ?? '', group.targetId ?? '', termKey(group.expression), group.matchType ?? ''].join('|')

export interface TargetRowParts {
  group: TargetGroup
  key: string
  totals: AdsTotals
  ratios: AdsRatios
  anomalies: AdTermAnomaly[]
}
export const targetPartsOf = (group: TargetGroup): TargetRowParts => ({
  group,
  key: targetKeyOf(group),
  totals: group.totals,
  ratios: adsRatios(group.totals),
  anomalies: termAnomaliesOf(group.totals, { kind: 'target' }),
})

/** 投放对象行：名称、竞价与状态由调用方补（只给当前页的行查，不为全部分组去查）。 */
export function targetRowOf(
  parts: TargetRowParts,
  extra: { campaignName: string | null; adGroupName: string | null; storeName: string | null; entityId?: string | null; bid: number | null; state: string | null },
): AdTermTargetRow {
  const { group } = parts
  return {
    key: parts.key,
    adsProfileId: group.adsProfileId,
    externalCampaignId: group.campaignId,
    campaignName: extra.campaignName ?? group.campaignName,
    adGroupId: group.adGroupId,
    adGroupName: extra.adGroupName ?? group.adGroupName,
    targetId: group.targetId,
    expression: group.expression,
    matchType: group.matchType,
    storeName: extra.storeName,
    entityId: extra.entityId ?? null,
    bid: extra.bid,
    state: extra.state,
    totals: parts.totals,
    ratios: parts.ratios,
    anomalies: parts.anomalies,
  }
}
