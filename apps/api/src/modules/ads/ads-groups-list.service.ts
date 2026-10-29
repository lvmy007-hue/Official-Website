import { Injectable } from '@nestjs/common'
import {
  ADS_AD_GROUP_ROW_LIMIT,
  ADS_BUCKET_RULE,
  ADS_CONSOLE_CURRENCY,
  ADS_READ,
  AdsAdGroupListQuerySchema,
  adsRangeIssue,
  adsRatios,
  countBuckets,
  inAdsRanges,
  inBucket,
  summarizeLevel,
  type AdsAdGroupListQuery,
  type AdsAdGroupListResponse,
  type AdsAdGroupListRow,
  type AdsAdGroupSort,
  type AdsLevelCountsResponse,
  type AdsTotals,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { asDate } from '../overview'
import { num, portfolioKey, portfolioNames, rangeOf } from './ads-campaigns-common'
import { entitySums } from './ads-campaigns-load'
import { accountOf, GROUP_SELECT } from './ads-groups-common'
import { decodeOffset, pageOf } from './ads-page'

const METRIC_GROUP_LIMIT = 19_999
const NOTE_NEVER = '广告组还没有同步（需要活动管理接口的广告组）；连接广告账户并同步后才会出现'
const NOTE_FILTERED = '没有符合筛选条件的广告组'
const NOTE_OTHER_CURRENCY = '指标只含美元广告账户；非美元广告组的指标不折算，列里显示“尚无记录”'

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortValue(row: AdsAdGroupListRow, sort: AdsAdGroupSort): number | string | null {
  switch (sort) {
    case 'name':
      return row.name
    case 'defaultBid':
      return row.defaultBid
    case 'spend':
    case 'sales':
    case 'orders':
    case 'clicks':
    case 'impressions':
      return row.totals ? row.totals[sort] : null
    default:
      return row.ratios ? row.ratios[sort] : null
  }
}

/** 空值永远排在最后（不论升降序），并列按名称再按系统编号，保证翻页顺序稳定。 */
export function compareAdGroupRows(a: AdsAdGroupListRow, b: AdsAdGroupListRow, sort: AdsAdGroupSort, dir: 'asc' | 'desc'): number {
  const left = sortValue(a, sort)
  const right = sortValue(b, sort)
  if (left === null && right !== null) return 1
  if (left !== null && right === null) return -1
  if (left !== null && right !== null && left !== right) return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1)
  return a.name !== b.name ? compareText(a.name, b.name) : compareText(a.id, b.id)
}

export interface LoadedAdGroups {
  rows: AdsAdGroupListRow[]
  query: AdsAdGroupListQuery
  binding: string
  offset: number
  truncated: boolean
  range: AdsAdGroupListResponse['range']
  hasAny: boolean
  otherCurrency: boolean
  portfolios: Array<{ id: string; name: string }>
}

// 广告组列表（P6-23，16 章第 8 节）：可见范围内全部广告组，指标来自指标表（对象类型 AD_GROUP，美元），数据库聚合后在内存里算比率、筛选、排序，偏移游标分页。
// 空值是 null，不是 0：没有指标行的广告组指标列显示“尚无记录”。
@Injectable()
export class AdsGroupListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsAdGroupListResponse> {
    const loaded = await this.load(req, rawQuery)
    const rows = loaded.rows.filter(row => inBucket(row.totals, loaded.query.bucket))
    const { page, pageInfo } = pageOf(rows, loaded.offset, loaded.query.pageSize, loaded.binding)
    const state = rows.length > 0 ? 'OK' : loaded.hasAny ? 'NO_DATA' : 'NOT_CONNECTED'
    const note = state === 'NOT_CONNECTED' ? NOTE_NEVER : state === 'NO_DATA' ? NOTE_FILTERED : loaded.otherCurrency ? NOTE_OTHER_CURRENCY : null
    return {
      state,
      note,
      items: page,
      pageInfo,
      range: loaded.range,
      currency: ADS_CONSOLE_CURRENCY,
      summary: summarizeLevel(rows.map(row => row.totals)),
      filterOptions: { portfolios: loaded.portfolios },
      truncated: loaded.truncated,
    }
  }

  async counts(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsLevelCountsResponse> {
    const loaded = await this.load(req, rawQuery)
    const { buckets, withoutMetrics } = countBuckets(loaded.rows.map(row => row.totals))
    const state = loaded.rows.length > 0 ? 'OK' : loaded.hasAny ? 'NO_DATA' : 'NOT_CONNECTED'
    const note = state === 'NOT_CONNECTED' ? NOTE_NEVER : state === 'NO_DATA' ? NOTE_FILTERED : null
    return { level: 'ad-groups', state, note, range: loaded.range, total: loaded.rows.length, buckets, withoutMetrics, rule: ADS_BUCKET_RULE, truncated: loaded.truncated }
  }

  /** 分类筛选之前的行（已按筛选、区间与排序处理）。 */
  async load(req: RequestWithContext, rawQuery: Record<string, string>): Promise<LoadedAdGroups> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsAdGroupListQuerySchema.parse(rawQuery)
    const rangeIssue = adsRangeIssue(query)
    if (rangeIssue) throw appError('VALIDATION_FAILED', rangeIssue, { fieldErrors: { range: [rangeIssue] } })
    const tenantId = context.tenantId
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const base: Prisma.AdsAdGroupWhereInput = { tenantId, ...adsRelationWhere(scope) }

    // 上级活动筛选（系统编号 → 档案 + 外部编号）与广告组合筛选都要先落到活动上
    const parentWhere = await this.parentFilter(tenantId, scope, query)
    if (parentWhere === 'NONE') return this.empty(base, { from: period.from, to: period.to, defaulted }, query, binding, offset)
    const where: Prisma.AdsAdGroupWhereInput = {
      ...base,
      ...(query.state ? { state: { equals: query.state, mode: 'insensitive' } } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(parentWhere ?? {}),
    }
    const found = await this.prisma.adsAdGroup.findMany({ where, select: GROUP_SELECT, orderBy: [{ id: 'asc' }], take: ADS_AD_GROUP_ROW_LIMIT + 1 })
    const truncated = found.length > ADS_AD_GROUP_ROW_LIMIT
    const records = found.slice(0, ADS_AD_GROUP_ROW_LIMIT)

    const [metrics, campaigns] = await Promise.all([this.metricMap(tenantId, scope, period.from, period.to), this.campaignsOf(tenantId, records)])
    const portfolios = await portfolioNames(
      this.prisma,
      tenantId,
      [...campaigns.values()].map(campaign => ({ adsProfileId: campaign.adsProfileId, portfolioId: campaign.portfolioId })),
    )
    const rows = records
      .map((record): AdsAdGroupListRow => {
        const campaign = campaigns.get(`${record.adsProfileId}|${record.campaignId}`) ?? null
        const account = accountOf(record.adsProfile)
        const currency = campaign?.currency ?? record.adsProfile.currencyCode
        const totals: AdsTotals | null = currency === ADS_CONSOLE_CURRENCY ? (metrics.get(`${record.adsProfileId}|${record.adGroupId}`) ?? null) : null
        return {
          id: record.id,
          adsProfileId: record.adsProfileId,
          adGroupId: record.adGroupId,
          name: record.name,
          state: record.state,
          defaultBid: num(record.defaultBid),
          campaignId: campaign?.id ?? null,
          campaignName: campaign?.name ?? null,
          externalCampaignId: record.campaignId,
          portfolioId: campaign?.portfolioId ?? null,
          currency,
          storeName: account.storeName,
          accountName: account.name,
          totals,
          ratios: totals ? adsRatios(totals) : null,
        }
      })
      .filter(row => inAdsRanges(row.totals, query))
      .sort((a, b) => compareAdGroupRows(a, b, query.sort.field as AdsAdGroupSort, query.sort.dir))
    const portfolioOptions = new Map<string, string>()
    for (const campaign of campaigns.values()) {
      if (campaign.portfolioId && !portfolioOptions.has(campaign.portfolioId))
        portfolioOptions.set(campaign.portfolioId, portfolios.get(portfolioKey(campaign.adsProfileId, campaign.portfolioId)) ?? campaign.portfolioId)
    }
    return {
      rows,
      query,
      binding,
      offset,
      truncated,
      range: { from: period.from, to: period.to, defaulted },
      hasAny: found.length > 0 || (await this.prisma.adsAdGroup.findFirst({ where: base, select: { id: true } })) !== null,
      otherCurrency: rows.some(row => row.currency !== ADS_CONSOLE_CURRENCY),
      portfolios: [...portfolioOptions].map(([id, name]) => ({ id, name })),
    }
  }

  private async empty(base: Prisma.AdsAdGroupWhereInput, range: AdsAdGroupListResponse['range'], query: AdsAdGroupListQuery, binding: string, offset: number): Promise<LoadedAdGroups> {
    return {
      rows: [],
      query,
      binding,
      offset,
      truncated: false,
      range,
      hasAny: (await this.prisma.adsAdGroup.findFirst({ where: base, select: { id: true } })) !== null,
      otherCurrency: false,
      portfolios: [],
    }
  }

  /** 按上级活动筛选：活动系统编号、广告组合。落到“档案 + 外部活动编号”的组合条件；没有任何活动符合时返回 NONE。 */
  private async parentFilter(tenantId: string, scope: ResolvedScope, query: { campaignId?: string; portfolioId?: string }): Promise<Prisma.AdsAdGroupWhereInput | 'NONE' | null> {
    if (!query.campaignId && !query.portfolioId) return null
    const campaigns = await this.prisma.adsCampaign.findMany({
      where: { tenantId, ...adsRelationWhere(scope), ...(query.campaignId ? { id: query.campaignId } : {}), ...(query.portfolioId ? { portfolioId: query.portfolioId } : {}) },
      select: { adsProfileId: true, externalCampaignId: true },
      orderBy: [{ id: 'asc' }],
      take: 2000,
    })
    if (campaigns.length === 0) return 'NONE'
    return { OR: campaigns.map(campaign => ({ adsProfileId: campaign.adsProfileId, campaignId: campaign.externalCampaignId })) }
  }

  private async campaignsOf(tenantId: string, records: ReadonlyArray<{ adsProfileId: string; campaignId: string }>) {
    const profileIds = [...new Set(records.map(record => record.adsProfileId))]
    const externalIds = [...new Set(records.map(record => record.campaignId))]
    const map = new Map<string, { id: string; adsProfileId: string; name: string; portfolioId: string | null; currency: string }>()
    if (records.length === 0) return map
    const found = await this.prisma.adsCampaign.findMany({
      where: { tenantId, adsProfileId: { in: profileIds }, externalCampaignId: { in: externalIds } },
      select: { id: true, adsProfileId: true, externalCampaignId: true, name: true, portfolioId: true, currency: true },
      orderBy: [{ id: 'desc' }],
      take: 20_000 - 1,
    })
    // 同一编号理论上不会在多个广告产品下重复；重复时取编号小的（倒序写入，小的最后覆盖）
    for (const campaign of found) map.set(`${campaign.adsProfileId}|${campaign.externalCampaignId}`, campaign)
    return map
  }

  /** 每个广告组在范围内的指标合计（美元）：键是 `档案|广告组编号`。 */
  private async metricMap(tenantId: string, scope: ResolvedScope, from: string, to: string): Promise<Map<string, AdsTotals>> {
    const groups = await this.prisma.adsMetric.groupBy({
      by: ['adsProfileId', 'entityId'],
      where: { tenantId, ...adsRelationWhere(scope), currency: ADS_CONSOLE_CURRENCY, entityType: 'AD_GROUP', reportDate: { gte: asDate(from), lte: asDate(to) } },
      _sum: { impressions: true, clicks: true, cost: true, sales: true, purchases: true },
      orderBy: [{ adsProfileId: 'asc' }, { entityId: 'asc' }],
      take: METRIC_GROUP_LIMIT,
    })
    const map = new Map<string, AdsTotals>()
    for (const group of groups) if (group.entityId) map.set(`${group.adsProfileId}|${group.entityId}`, entitySums(group._sum))
    return map
  }
}
