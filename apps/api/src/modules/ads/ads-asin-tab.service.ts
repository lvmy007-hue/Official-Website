import { Injectable } from '@nestjs/common'
import {
  ADS_ASIN_HALO_NOTE,
  ASIN360_ADS_BASIS,
  ASIN360_ADS_BRAND_NOTE,
  ASIN360_ADS_EMPTY_NOTE,
  ASIN360_ADS_NEVER_NOTE,
  ASIN360_ADS_OTHER_CURRENCY_NOTE,
  ASIN360_ADS_ROW_LIMIT,
  ASIN360_ADS_SHARED_NOTE,
  ASIN360_ADS_UNBOUND_NOTE,
  stockOf,
  type AdsSearchTermRow,
  type AdsTargetRow,
  type Asin360AdsAdGroupRow,
  type Asin360AdsBlock,
  type Asin360AdsCampaignRow,
  type Asin360AdsHalo,
  type Asin360AdsResponse,
  type Asin360AdsStock,
  type Asin360AdsSummary,
  type DashState,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { eachDay, type ScopeDates } from '../overview'
import {
  adGroupRecords,
  adGroupMetrics,
  adsEver,
  advertisedCampaigns,
  advertisedDaily,
  asinAdLinks,
  campaignRecordsOf,
  convertedEver,
  dailyTotalSales,
  groupAsinCounts,
  reportPresence,
  storeProfileIds,
  type AsinAdLink,
  type AsinTarget,
} from './ads-asin-tab-load'
import { entityEver, groupsByProfile, profileTargets, profileTerms } from './ads-asin-tab-entities'
import { adGroupRowsOf, campaignRowsOf, dailyPoints, groupKey, mergeTargetRows, mergeTerms, recordMap, summaryOf, type AdGroupRecord } from './ads-asin-tab-math'
import { rangeOf } from './ads-campaigns-common'
import type { AdsLoadContext } from './ads-overview-load'
import { asinFacts, haloByAsin } from './ads-products-load'
import { MATCH_BASIS } from './ads-terms-load'

/** 投放对象与搜索词每个档案先读多少行再合并排序；超过的部分标记截断。 */
const ENTITY_READ_LIMIT = 200
const NO_PARENT_NOTE = '需要先有关联这个 ASIN 的广告组（广告表里按 ASIN 找到），所以这里没有内容'

export interface AsinAdsInput {
  tenantId: string
  scope: ResolvedScope
  /** 商品所在店铺与 ASIN（同一 ASIN 的多个 SKU 合在一起）。调用方已经校验过商品在成员的数据范围内。 */
  storeId: string
  asin: string
  query: ScopeDates
  now?: Date
}

interface Empty {
  state: DashState
  note: string
}

function block<T>(items: T[], truncated: boolean, empty: Empty): Asin360AdsBlock<T> {
  if (items.length > 0) return { state: 'OK', note: null, items: items.slice(0, ASIN360_ADS_ROW_LIMIT), truncated: truncated || items.length > ASIN360_ADS_ROW_LIMIT }
  return { state: empty.state, note: empty.note, items: [], truncated: false }
}

const idle = (note: string) => ({ state: 'NOT_CONNECTED' as const, note, items: [], truncated: false })

// ASIN 360“广告”页签（05 章 5.2 第 3 个页签，P3-19）：关联的广告活动、广告组、投放对象、搜索词；花费、销售额、广告成本销售比、广告占总销售比趋势；
// 光环销售；品牌分析份额高但尚未投放的搜索词（P4-04 之前恒“尚未接入”）。
// 做法：被推广商品日报表按 ASIN 在数据库里聚合（日、活动两个维度）→ 广告表按 ASIN 找到关联的广告组 → 再取广告组、投放对象、搜索词。
// 活动一行是这个 ASIN 自己的数字；广告组、投放对象、搜索词是对象自己的合计（亚马逊没有按 ASIN 拆开），响应里的 `sharedNote` 与 `groupAsins` 写明。
@Injectable()
export class AsinAdsTabService {
  constructor(private readonly prisma: PrismaService) {}

  async tab(input: AsinAdsInput): Promise<Asin360AdsResponse> {
    const { tenantId, scope, storeId, asin } = input
    const ctx: AdsLoadContext = { tenantId, scope }
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, input.query, input.now)
    const range = { from: period.from, to: period.to, defaulted }
    const profileIds = await storeProfileIds(this.prisma, ctx, storeId)
    const target: AsinTarget = { storeId, asin, profileIds }
    if (profileIds.length === 0) return this.unbound(range)

    const profileSet = new Set(profileIds)
    const keyOfProfile = (adsProfileId: string, key: string) => (profileSet.has(adsProfileId) ? key : `other|${adsProfileId}`)
    const [daily, campaigns, presence, salesByDay, haloEver, halo, links, facts] = await Promise.all([
      advertisedDaily(this.prisma, ctx, target, range.from, range.to),
      advertisedCampaigns(this.prisma, ctx, target, range.from, range.to),
      reportPresence(this.prisma, ctx, target, range.from, range.to),
      dailyTotalSales(this.prisma, ctx, target, range.from, range.to),
      convertedEver(this.prisma, ctx, target),
      haloByAsin(this.prisma, ctx, [asin], range.from, range.to, keyOfProfile),
      asinAdLinks(this.prisma, ctx, target),
      asinFacts(this.prisma, ctx, [storeId], [asin]),
    ])
    const [asinCounts, groupRecords] = await Promise.all([groupAsinCounts(this.prisma, ctx, target, links), adGroupRecords(this.prisma, ctx, target, links)])
    const records = groupRecords.records
    const externalIds = [...campaigns.groups.map(group => group.campaignId), ...records.map(record => record.campaignId)]
    const [campaignRecords, metrics, everAds, ever] = await Promise.all([
      campaignRecordsOf(this.prisma, ctx, target, externalIds),
      adGroupMetrics(this.prisma, ctx, records, range.from, range.to),
      links.length === 0 ? adsEver(this.prisma, ctx, target) : Promise.resolve(true),
      entityEver(this.prisma, ctx, profileIds),
    ])
    const campaignByKey = recordMap(campaignRecords)

    const totalSales = salesByDay.size > 0 ? [...salesByDay.values()].reduce((sum, value) => sum + value, 0) : null
    const adCount = links.length > 0 ? { enabled: links.reduce((sum, link) => sum + link.enabled, 0), total: links.reduce((sum, link) => sum + link.total, 0) } : null
    const summary = summaryOf({ ads: daily, totalSales, campaigns: campaigns.groups.length, adCount })

    const campaignRows = campaignRowsOf(
      campaigns.groups,
      records.map(record => ({ adsProfileId: record.adsProfileId, campaignId: record.campaignId })),
      campaignByKey,
    )
    const asinAds = new Map(links.map((link: AsinAdLink) => [groupKey(link.adsProfileId, link.adGroupId), { enabled: link.enabled, total: link.total }]))
    const adGroupRows = adGroupRowsOf(records, { asinAds, groupAsins: asinCounts, campaigns: campaignByKey, metrics })
    const { targets, terms } = await this.entities(ctx, records, range, { adGroups: this.adGroupEmpty(links.length, records.length, everAds), ever })

    const haloView: Asin360AdsHalo = haloEver ? { state: 'OK', note: null, sales: halo.get(asin) ?? null } : { state: 'NOT_CONNECTED', note: ADS_ASIN_HALO_NOTE, sales: null }
    const state = this.stateOf(daily.size, presence.everSynced)
    return {
      ...state,
      note: this.noteOf(state.state, presence.otherCurrency),
      range,
      currency: 'USD',
      summary,
      trend: dailyPoints(eachDay(range.from, range.to), daily, salesByDay),
      halo: haloView,
      stock: this.stockOf(facts.get(`${storeId}|${asin}`) ?? null, summary),
      campaigns: block<Asin360AdsCampaignRow>(campaignRows, campaigns.truncated, {
        state: presence.everSynced ? 'NO_DATA' : 'NOT_CONNECTED',
        note: presence.everSynced ? ASIN360_ADS_EMPTY_NOTE : ASIN360_ADS_NEVER_NOTE,
      }),
      adGroups: block<Asin360AdsAdGroupRow>(adGroupRows, groupRecords.truncated, this.adGroupEmpty(links.length, records.length, everAds)),
      targets,
      searchTerms: { ...terms, matchBasis: MATCH_BASIS },
      brandGaps: { state: 'NOT_CONNECTED', note: ASIN360_ADS_BRAND_NOTE },
      sharedNote: ASIN360_ADS_SHARED_NOTE,
      basis: ASIN360_ADS_BASIS,
    }
  }

  private stateOf(dailyRows: number, everSynced: boolean): { state: Asin360AdsResponse['state'] } {
    if (dailyRows > 0) return { state: 'OK' }
    return { state: everSynced ? 'NO_DATA' : 'NOT_CONNECTED' }
  }

  private noteOf(state: Asin360AdsResponse['state'], otherCurrency: boolean): string | null {
    const base = state === 'NOT_CONNECTED' ? ASIN360_ADS_NEVER_NOTE : state === 'NO_DATA' ? ASIN360_ADS_EMPTY_NOTE : null
    return [base, otherCurrency ? ASIN360_ADS_OTHER_CURRENCY_NOTE : null].filter((note): note is string => note !== null).join('；') || null
  }

  private stockOf(fact: { sellable: number | null; snapshotDate: string | null } | null, summary: Asin360AdsSummary): Asin360AdsStock {
    const sellable = fact?.sellable ?? null
    return { stock: stockOf(sellable), sellable, snapshotDate: fact?.snapshotDate ?? null, spend: summary.totals.spend }
  }

  private adGroupEmpty(linkCount: number, recordCount: number, everAds: boolean): Empty {
    if (linkCount === 0) {
      return everAds
        ? { state: 'NO_DATA', note: '广告表里没有关联这个 ASIN 的广告；没有记录不代表没有投放，可能是广告实体还没有完整同步' }
        : { state: 'NOT_CONNECTED', note: '广告实体（广告组与广告）还没有同步，无法找出关联这个 ASIN 的广告组' }
    }
    return recordCount === 0 ? { state: 'NO_DATA', note: '找到了关联这个 ASIN 的广告，但对应的广告组记录还没有同步下来' } : { state: 'NO_DATA', note: '没有广告组' }
  }

  private async entities(
    ctx: AdsLoadContext,
    records: readonly AdGroupRecord[],
    range: { from: string; to: string },
    context: { adGroups: Empty; ever: { targets: boolean; terms: boolean } },
  ): Promise<{ targets: Asin360AdsBlock<AdsTargetRow>; terms: Asin360AdsBlock<AdsSearchTermRow> }> {
    if (records.length === 0) {
      // 没有广告组就没有投放对象与搜索词：沿用广告组为空的状态，没同步过就沿用它的原因，否则说明依赖关系
      const parent = { state: context.adGroups.state, note: context.adGroups.state === 'NOT_CONNECTED' ? context.adGroups.note : NO_PARENT_NOTE, items: [], truncated: false }
      return { targets: parent, terms: parent }
    }
    const profiles = groupsByProfile(records)
    const input = { from: range.from, to: range.to, limit: ENTITY_READ_LIMIT }
    const [targetParts, termParts] = await Promise.all([
      Promise.all(profiles.map(profile => profileTargets(this.prisma, ctx, { ...profile, ...input }))),
      Promise.all(profiles.map(profile => profileTerms(this.prisma, ctx, { ...profile, ...input }))),
    ])
    const targetRows = mergeTargetRows(targetParts.map(part => part.rows))
    const termRows = mergeTerms(termParts.map(part => part.rows))
    return {
      targets: block<AdsTargetRow>(
        targetRows,
        targetParts.some(part => part.truncated),
        {
          state: context.ever.targets ? 'NO_DATA' : 'NOT_CONNECTED',
          note: context.ever.targets ? '这些广告组下没有投放对象记录' : '投放表与关键词表还没有同步（广告实体同步器尚未交付），暂无法列出投放对象',
        },
      ),
      terms: block<AdsSearchTermRow>(
        termRows,
        termParts.some(part => part.truncated),
        {
          state: context.ever.terms ? 'NO_DATA' : 'NOT_CONNECTED',
          note: context.ever.terms ? '所选日期范围内这些广告组没有搜索词报表行' : '搜索词报表还没有同步（需要广告报表的“搜索词”报告），暂无法列出搜索词',
        },
      ),
    }
  }

  /** 店铺没有绑定任何广告账户：整页“尚未接入”，不查业务表。 */
  private unbound(range: Asin360AdsResponse['range']): Asin360AdsResponse {
    const none = idle(ASIN360_ADS_UNBOUND_NOTE)
    return {
      state: 'NOT_CONNECTED',
      note: ASIN360_ADS_UNBOUND_NOTE,
      range,
      currency: 'USD',
      summary: summaryOf({ ads: new Map(), totalSales: null, campaigns: 0, adCount: null }),
      trend: [],
      halo: { state: 'NOT_CONNECTED', note: ASIN360_ADS_UNBOUND_NOTE, sales: null },
      stock: { stock: 'UNKNOWN', sellable: null, snapshotDate: null, spend: null },
      campaigns: none,
      adGroups: none,
      targets: none,
      searchTerms: { ...none, matchBasis: MATCH_BASIS },
      brandGaps: { state: 'NOT_CONNECTED', note: ASIN360_ADS_BRAND_NOTE },
      sharedNote: ASIN360_ADS_SHARED_NOTE,
      basis: ASIN360_ADS_BASIS,
    }
  }
}
