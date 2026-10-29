import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  ADS_CAMPAIGN_WRITE,
  ADS_CONSOLE_CURRENCY,
  ADS_CAMPAIGN_ROW_LIMIT,
  ADS_OVER_BUDGET_NOTE,
  ADS_READ,
  ADS_WRITE_PENDING,
  ADS_BUCKET_RULE,
  AdsCampaignListQuerySchema,
  adsRangeIssue,
  compareCampaignRows,
  countBuckets,
  inAdsRanges,
  inBucket,
  summarizeLevel,
  type AdsCampaignListResponse,
  type AdsCampaignSort,
  type AdsLevelCountsResponse,
  type AdsTotals,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsRelationWhere, ContextService } from '../auth'
import { activeMembers, CAMPAIGN_SELECT, portfolioKey, portfolioNames, rangeOf, rowOf } from './ads-campaigns-common'
import { storeSalesByStore } from './ads-campaigns-load'
import { decodeOffset, pageOf } from './ads-page'
import { campaignKey, type AdsLoadContext, campaignTotals } from './ads-overview-load'

const NOTE_NEVER = '可见范围内还没有同步到广告活动；连接广告账户并同步活动后才会出现'
const NOTE_FILTERED = '没有符合筛选条件的广告活动'

// 广告活动列表（08 章 8.3）：活动来自活动管理接口同步的 AdsCampaign，指标来自广告日汇总（美元）。
// 做法：数据库按筛选取活动（最多 ADS_CAMPAIGN_ROW_LIMIT 个）+ 数据库聚合指标 → 内存里算比率、异常、排序 → 偏移游标分页（游标签名并绑定全部查询条件）。
// 空值是 null，不是 0：没有汇总行的活动指标列显示“尚无记录”，排序时排在最后。
@Injectable()
export class AdsCampaignListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsCampaignListResponse> {
    const loaded = await this.load(req, rawQuery)
    return this.respond(loaded)
  }

  /** 分类计数（P6-23）：同一套筛选，分类筛选之前的行按曝光、点击、订单分四类。 */
  async counts(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsLevelCountsResponse> {
    const loaded = await this.load(req, rawQuery)
    const { buckets, withoutMetrics } = countBuckets(loaded.rows.map(row => row.totals))
    return {
      level: 'campaigns',
      state: loaded.rows.length === 0 ? 'NO_DATA' : 'OK',
      note: loaded.rows.length === 0 ? NOTE_FILTERED : null,
      range: loaded.range,
      total: loaded.rows.length,
      buckets,
      withoutMetrics,
      rule: ADS_BUCKET_RULE,
      truncated: loaded.truncated,
    }
  }

  async load(req: RequestWithContext, rawQuery: Record<string, string>) {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsCampaignListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const ctx: AdsLoadContext = { tenantId, scope }
    const { period, defaulted } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const canWrite = hasPermission(context.permissions, ADS_CAMPAIGN_WRITE)
    const rangeIssue = adsRangeIssue(query)
    if (rangeIssue) throw appError('VALIDATION_FAILED', rangeIssue, { fieldErrors: { range: [rangeIssue] } })
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)

    const base: Prisma.AdsCampaignWhereInput = { tenantId, ...adsRelationWhere(scope) }
    const where: Prisma.AdsCampaignWhereInput = {
      ...base,
      ...(query.adProduct ? { adProduct: query.adProduct } : {}),
      ...(query.state ? { state: { equals: query.state, mode: 'insensitive' } } : {}),
      ...(query.portfolioId ? { portfolioId: query.portfolioId } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.q ? (query.qMode === 'excludes' ? { NOT: { name: { contains: query.q, mode: 'insensitive' } } } : { name: { contains: query.q, mode: 'insensitive' } }) : {}),
    }

    const [found, totals, stores, options, members] = await Promise.all([
      this.prisma.adsCampaign.findMany({ where, select: CAMPAIGN_SELECT, orderBy: [{ id: 'asc' }], take: ADS_CAMPAIGN_ROW_LIMIT + 1 }),
      campaignTotals(this.prisma, ctx, period.from, period.to),
      storeSalesByStore(this.prisma, ctx, period.from, period.to),
      this.filterOptions(tenantId, base),
      canWrite ? activeMembers(this.prisma, tenantId) : Promise.resolve([]),
    ])
    const truncated = found.length > ADS_CAMPAIGN_ROW_LIMIT
    const records = found.slice(0, ADS_CAMPAIGN_ROW_LIMIT)
    const metricByKey = new Map<string, AdsTotals>(totals.rows.map(row => [row.key, row.totals]))
    const [portfolios, owners] = await Promise.all([
      portfolioNames(this.prisma, tenantId, records),
      memberNames(this.prisma, tenantId, [...records.map(record => record.ownerId), ...options.ownerIds]),
    ])

    const rows = records
      .map(record =>
        rowOf({
          record,
          // 指标只含美元活动（汇总按币种分行，不折算）；没有汇总行为 null
          totals: record.currency === ADS_CONSOLE_CURRENCY ? (metricByKey.get(campaignKey(record.adsProfileId, record.adProduct, record.externalCampaignId)) ?? null) : null,
          storeSales: record.adsProfile.sellerAccountId ? (stores.get(record.adsProfile.sellerAccountId) ?? null) : null,
          from: period.from,
          to: period.to,
          portfolioName: record.portfolioId ? (portfolios.get(portfolioKey(record.adsProfileId, record.portfolioId)) ?? null) : null,
          ownerName: record.ownerId ? (owners.get(record.ownerId) ?? null) : null,
        }),
      )
      .filter(row => !query.anomaly || row.anomaly === query.anomaly)
      .filter(row => inAdsRanges(row.totals, query))
      .sort((a, b) => compareCampaignRows(a, b, query.sort.field as AdsCampaignSort, query.sort.dir))

    return {
      rows,
      query,
      binding,
      offset,
      base,
      mixedCurrency: records.some(record => record.currency !== ADS_CONSOLE_CURRENCY),
      range: { from: period.from, to: period.to, defaulted },
      options,
      owners,
      members,
      canWrite,
      truncated,
      metricsTruncated: totals.truncated,
    }
  }

  private async respond(loaded: Awaited<ReturnType<AdsCampaignListService['load']>>): Promise<AdsCampaignListResponse> {
    const { query, binding, offset, base, options, owners } = loaded
    // 分类筛选在最后：汇总行是分类筛选之后全部行的合计，与表格里显示的行一致
    const rows = loaded.rows.filter(row => inBucket(row.totals, query.bucket))
    const { page, pageInfo } = pageOf(rows, offset, query.pageSize, binding)
    let state: AdsCampaignListResponse['state'] = 'OK'
    let note: string | null = null
    if (rows.length === 0) {
      state = (await this.hasAny(base)) ? 'NO_DATA' : 'NOT_CONNECTED'
      note = state === 'NOT_CONNECTED' ? NOTE_NEVER : NOTE_FILTERED
    } else if (loaded.mixedCurrency) {
      note = '指标只含美元活动；非美元活动的指标不折算，列里显示“尚无记录”'
    }

    return {
      state,
      note,
      items: page,
      pageInfo,
      range: loaded.range,
      currency: ADS_CONSOLE_CURRENCY,
      filterOptions: {
        portfolios: options.portfolios,
        tags: options.tags,
        owners: options.ownerIds.map(id => ({ id, name: owners.get(id) ?? id })),
      },
      members: loaded.members,
      canWrite: loaded.canWrite,
      avgOverBudget: { state: 'NOT_CONNECTED', note: ADS_OVER_BUDGET_NOTE },
      write: ADS_WRITE_PENDING,
      summary: summarizeLevel(rows.map(row => row.totals)),
      truncated: loaded.truncated,
      metricsTruncated: loaded.metricsTruncated,
    }
  }

  private async hasAny(base: Prisma.AdsCampaignWhereInput): Promise<boolean> {
    return (await this.prisma.adsCampaign.findFirst({ where: base, select: { id: true } })) !== null
  }

  /** 筛选下拉：只看可见范围内已有的广告组合、标签、负责人（不随当前筛选变化，避免选了一项其他选项就消失）。 */
  private async filterOptions(tenantId: string, base: Prisma.AdsCampaignWhereInput) {
    const [portfolioGroups, tagRows, ownerGroups] = await Promise.all([
      this.prisma.adsCampaign.groupBy({ by: ['adsProfileId', 'portfolioId'], where: { ...base, portfolioId: { not: null } }, orderBy: [{ adsProfileId: 'asc' }, { portfolioId: 'asc' }], take: 500 }),
      this.prisma.adsCampaign.findMany({ where: { ...base, tags: { isEmpty: false } }, select: { tags: true }, orderBy: [{ id: 'asc' }], take: 5000 }),
      this.prisma.adsCampaign.groupBy({ by: ['ownerId'], where: { ...base, ownerId: { not: null } }, orderBy: { ownerId: 'asc' }, take: 200 }),
    ])
    const names = await portfolioNames(
      this.prisma,
      tenantId,
      portfolioGroups.map(group => ({ adsProfileId: group.adsProfileId, portfolioId: group.portfolioId })),
    )
    const seen = new Map<string, string>()
    for (const group of portfolioGroups) {
      if (!group.portfolioId || seen.has(group.portfolioId)) continue
      seen.set(group.portfolioId, names.get(portfolioKey(group.adsProfileId, group.portfolioId)) ?? group.portfolioId)
    }
    const tags = [...new Set(tagRows.flatMap(row => row.tags))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 200)
    return {
      portfolios: [...seen].map(([id, name]) => ({ id, name })),
      tags,
      ownerIds: ownerGroups.flatMap(group => (group.ownerId ? [group.ownerId] : [])),
    }
  }
}
