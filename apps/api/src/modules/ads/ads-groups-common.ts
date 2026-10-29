import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  ADS_PRODUCT_LABEL,
  ADS_READ,
  AdsCampaignTabQuerySchema,
  ScopeSearchSchema,
  ADS_TARGET_KIND_LABEL,
  suggestedBidOf,
  type AdsCampaignTabQuery,
  type AdsEntityAccount,
  type AdsParentCampaign,
  type AdsProductKey,
  type AdsSuggestedBid,
  type AdsTargetKind,
  type DashPeriod,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { CAMPAIGN_ID_PATTERN, num, rangeOf } from './ads-campaigns-common'
import type { MetricRef } from './ads-campaigns-load'
import type { AdsLoadContext } from './ads-overview-load'
import { decodeOffset } from './ads-page'

// 广告组与投放对象详情的公共部分（P3-08）：按系统编号找对象并校验数据范围、上级活动与广告组的解析、身份区的账户块、建议竞价。
// 范围外与不存在的对象一样返回 404，不泄露存在性。

const PROFILE_SELECT = {
  displayName: true,
  profileId: true,
  adsAccountId: true,
  bindingStatus: true,
  sellerAccountId: true,
  currencyCode: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.AdsProfileSelect
type ProfileRecord = Prisma.AdsProfileGetPayload<{ select: typeof PROFILE_SELECT }>

export const GROUP_SELECT = {
  id: true,
  adsProfileId: true,
  adGroupId: true,
  campaignId: true,
  name: true,
  state: true,
  defaultBid: true,
  syncedAt: true,
  adsProfile: { select: PROFILE_SELECT },
} satisfies Prisma.AdsAdGroupSelect
export type GroupRecord = Prisma.AdsAdGroupGetPayload<{ select: typeof GROUP_SELECT }>

export const accountOf = (profile: ProfileRecord): AdsEntityAccount => ({
  name: profile.displayName ?? profile.profileId,
  adsAccountId: profile.adsAccountId,
  storeName: profile.sellerAccount?.displayName ?? null,
  bindingStatus: profile.bindingStatus,
})

export interface ParentCampaign {
  id: string
  name: string
  adProduct: string
  currency: string
}

/** 上级活动：按“广告档案 + 外部活动编号”找（同一编号在不同广告产品下理论上不重复，重复时取编号小的）；没有同步为 null。 */
export async function parentCampaign(prisma: PrismaService, tenantId: string, adsProfileId: string, externalCampaignId: string): Promise<ParentCampaign | null> {
  return prisma.adsCampaign.findFirst({
    where: { tenantId, adsProfileId, externalCampaignId },
    select: { id: true, name: true, adProduct: true, currency: true },
    orderBy: { id: 'asc' },
  })
}

export const campaignView = (externalCampaignId: string, campaign: ParentCampaign | null): AdsParentCampaign => ({
  id: campaign?.id ?? null,
  externalCampaignId,
  name: campaign?.name ?? null,
  productLabel: campaign ? (ADS_PRODUCT_LABEL[campaign.adProduct as AdsProductKey] ?? campaign.adProduct) : null,
})

/** 读指标表用的引用：币种取上级活动的，活动没同步时取广告档案的币种；广告产品未知时不过滤。 */
export const metricRefOf = (adsProfileId: string, campaign: ParentCampaign | null, profile: ProfileRecord): MetricRef => ({
  adsProfileId,
  adProduct: campaign?.adProduct ?? null,
  currency: campaign?.currency ?? profile.currencyCode,
})

export interface ResolvedGroup {
  group: GroupRecord
  campaign: ParentCampaign | null
  ref: MetricRef
  ctx: AdsLoadContext
  scope: ResolvedScope
  tenantId: string
}
export interface OpenedGroupTab extends ResolvedGroup {
  query: AdsCampaignTabQuery
  period: DashPeriod
  binding: string
  offset: number
}

const TARGET_SELECT_COMMON = { id: true, adsProfileId: true, adGroupId: true, matchType: true, bid: true, state: true, syncedAt: true, adsProfile: { select: PROFILE_SELECT } } as const

export interface TargetRecord {
  id: string
  adsProfileId: string
  /** 外部编号（关键词编号或投放对象编号），指标表与词级报表用它。 */
  targetId: string
  kind: string
  expression: string
  matchType: string | null
  state: string
  bid: number | null
  adGroupId: string
  /** 关键词表带活动编号；投放表没有，由广告组推出。 */
  campaignId: string | null
  syncedAt: Date
  adsProfile: ProfileRecord
}
export interface ResolvedTarget {
  target: TargetRecord
  group: { id: string; name: string; campaignId: string } | null
  campaign: ParentCampaign | null
  externalCampaignId: string
  ref: MetricRef
  ctx: AdsLoadContext
  scope: ResolvedScope
  tenantId: string
}
export interface OpenedTargetTab extends ResolvedTarget {
  query: AdsCampaignTabQuery
  period: DashPeriod
  binding: string
  offset: number
}

/** 投放对象的指标对象类型：关键词表的行在指标表里是 KEYWORD，投放表的行是 TARGET；两种都读，编号相同才算。 */
export const TARGET_METRIC_TYPES = ['TARGET', 'KEYWORD'] as const

/** 官方推荐里给这个投放对象的建议竞价（取最新一条待处理推荐）。 */
export async function suggestedBidFor(prisma: PrismaService, tenantId: string, adsProfileId: string, targetId: string): Promise<AdsSuggestedBid | null> {
  const row = await prisma.adsRecommendation.findFirst({
    where: { tenantId, adsProfileId, entityId: targetId, status: 'NEW' },
    select: { payloadJson: true, receivedAt: true },
    orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
  })
  return row ? suggestedBidOf(row.payloadJson, row.receivedAt.toISOString()) : null
}

export const kindLabelOf = (kind: string): string => ADS_TARGET_KIND_LABEL[kind as AdsTargetKind] ?? kind

@Injectable()
export class AdsGroupAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async resolveGroup(req: RequestWithContext, id: string, query: Record<string, string>): Promise<ResolvedGroup> {
    // 权限与数据范围先于一切：没有权限先拿 403，范围外的对象与不存在一样 404
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, query)
    if (!CAMPAIGN_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '广告组不存在')
    const group = await this.prisma.adsAdGroup.findFirst({ where: { id, tenantId: context.tenantId, ...adsRelationWhere(scope) }, select: GROUP_SELECT })
    if (!group) throw appError('RESOURCE_NOT_FOUND', '广告组不存在')
    const campaign = await parentCampaign(this.prisma, context.tenantId, group.adsProfileId, group.campaignId)
    return { group, campaign, ref: metricRefOf(group.adsProfileId, campaign, group.adsProfile), ctx: { tenantId: context.tenantId, scope }, scope, tenantId: context.tenantId }
  }

  async openGroupTab(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<OpenedGroupTab> {
    const resolved = await this.resolveGroup(req, id, rawQuery)
    const query = AdsCampaignTabQuerySchema.parse(rawQuery)
    const { period } = await rangeOf(this.prisma, resolved.tenantId, ScopeSearchSchema.parse(rawQuery))
    const binding = bindingOf(resolved.tenantId, { ...rawQuery, id })
    return { ...resolved, query, period, binding, offset: decodeOffset(query.cursor, binding) }
  }

  async resolveTarget(req: RequestWithContext, id: string, query: Record<string, string>): Promise<ResolvedTarget> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, query)
    if (!CAMPAIGN_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '投放对象不存在')
    const tenantId = context.tenantId
    const where = { id, tenantId, ...adsRelationWhere(scope) }
    const keyword = await this.prisma.adsKeyword.findFirst({ where, select: { ...TARGET_SELECT_COMMON, keywordId: true, text: true, campaignId: true } })
    const found: TargetRecord | null = keyword
      ? { ...keyword, targetId: keyword.keywordId, kind: 'KEYWORD', expression: keyword.text, bid: num(keyword.bid), campaignId: keyword.campaignId }
      : await this.prisma.adsTarget
          .findFirst({ where, select: { ...TARGET_SELECT_COMMON, targetId: true, kind: true, expression: true } })
          .then(row => (row ? { ...row, bid: num(row.bid), campaignId: null } : null))
    if (!found) throw appError('RESOURCE_NOT_FOUND', '投放对象不存在')
    const group = await this.prisma.adsAdGroup.findFirst({
      where: { tenantId, adsProfileId: found.adsProfileId, adGroupId: found.adGroupId },
      select: { id: true, name: true, campaignId: true },
      orderBy: { id: 'asc' },
    })
    const externalCampaignId = found.campaignId ?? group?.campaignId ?? ''
    const campaign = externalCampaignId ? await parentCampaign(this.prisma, tenantId, found.adsProfileId, externalCampaignId) : null
    return { target: found, group, campaign, externalCampaignId, ref: metricRefOf(found.adsProfileId, campaign, found.adsProfile), ctx: { tenantId, scope }, scope, tenantId }
  }

  async openTargetTab(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<OpenedTargetTab> {
    const resolved = await this.resolveTarget(req, id, rawQuery)
    const query = AdsCampaignTabQuerySchema.parse(rawQuery)
    const { period } = await rangeOf(this.prisma, resolved.tenantId, ScopeSearchSchema.parse(rawQuery))
    const binding = bindingOf(resolved.tenantId, { ...rawQuery, id })
    return { ...resolved, query, period, binding, offset: decodeOffset(query.cursor, binding) }
  }
}
