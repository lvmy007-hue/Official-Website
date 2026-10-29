import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  ADS_PRODUCT_LABEL,
  ADS_READ,
  AdsCampaignTabQuerySchema,
  ScopeSearchSchema,
  campaignAnomaly,
  campaignBudgetUtilization,
  ratiosOf,
  adsShareOf,
  type AdsCampaignIdentity,
  type AdsCampaignRow,
  type AdsCampaignTabQuery,
  type AdsProductKey,
  type AdsTotals,
  type DashPeriod,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { decodeOffset } from './ads-page'
import { adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { dateText, resolvePeriods, todayIn, validZone, type ScopeDates } from '../overview'
import type { AdsLoadContext } from './ads-overview-load'

// 广告活动页的公共部分（P3-07）：活动记录的读取字段、行与身份区的组装、范围与时区、“按编号找活动并校验数据范围”。

export const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const CAMPAIGN_SELECT = {
  id: true,
  adsProfileId: true,
  externalCampaignId: true,
  adProduct: true,
  name: true,
  state: true,
  budget: true,
  currency: true,
  startDate: true,
  endDate: true,
  syncedAt: true,
  adsAccountId: true,
  portfolioId: true,
  targetingType: true,
  bidStrategy: true,
  servingStatus: true,
  budgetType: true,
  tags: true,
  ownerId: true,
  version: true,
  adsProfile: {
    select: {
      displayName: true,
      profileId: true,
      adsAccountId: true,
      bindingStatus: true,
      sellerAccountId: true,
      sellerAccount: { select: { displayName: true } },
    },
  },
} satisfies Prisma.AdsCampaignSelect
export type CampaignRecord = Prisma.AdsCampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>

type Dec = { toString(): string } | null | undefined
export const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

export const NOT_CONNECTED_PLACEMENT_ADJUSTMENT = '广告位竞价调整没有同步器写入，没有字段可读；随“广告写入接入”（P3-17）提供'
export const NOT_CONNECTED_AMAZON_CHANGES = '亚马逊侧的预算、竞价、状态变更历史没有同步器（需要广告变更历史接口），这里只记录本系统内的改动'

const productLabelOf = (adProduct: string) => ADS_PRODUCT_LABEL[adProduct as AdsProductKey] ?? adProduct
const targetingOf = (value: string | null): 'AUTO' | 'MANUAL' | null => {
  const upper = value?.toUpperCase()
  return upper === 'AUTO' || upper === 'MANUAL' ? upper : null
}
const day = (value: Date | null) => (value ? dateText(value) : null)

export interface RowParts {
  record: CampaignRecord
  /** 范围内合计；没有汇总行或不是美元活动为 null。 */
  totals: AdsTotals | null
  storeSales: number | null
  from: string
  to: string
  portfolioName: string | null
  ownerName: string | null
}

export function rowOf(parts: RowParts): AdsCampaignRow {
  const { record, totals } = parts
  const budget = num(record.budget)
  return {
    id: record.id,
    adsProfileId: record.adsProfileId,
    externalCampaignId: record.externalCampaignId,
    adProduct: record.adProduct,
    productLabel: productLabelOf(record.adProduct),
    name: record.name,
    targetingType: targetingOf(record.targetingType),
    state: record.state,
    servingStatus: record.servingStatus,
    portfolioId: record.portfolioId,
    portfolioName: parts.portfolioName,
    budget,
    budgetType: record.budgetType,
    currency: record.currency,
    bidStrategy: record.bidStrategy,
    startDate: day(record.startDate),
    endDate: day(record.endDate),
    totals,
    ratios: ratiosOf(totals),
    adsShare: adsShareOf(totals?.spend ?? null, parts.storeSales),
    budgetUtilization: campaignBudgetUtilization(
      { state: record.state, budget, budgetType: record.budgetType, startDate: day(record.startDate), endDate: day(record.endDate) },
      totals?.spend ?? null,
      parts.from,
      parts.to,
    ),
    anomaly: totals ? campaignAnomaly({ spend: totals.spend, sales: totals.sales, clicks: totals.clicks, orders: totals.orders }) : null,
    tags: record.tags ?? [],
    ownerId: record.ownerId,
    ownerName: parts.ownerName,
    storeName: record.adsProfile.sellerAccount?.displayName ?? null,
    accountName: record.adsProfile.displayName ?? record.adsProfile.profileId,
    syncedAt: record.syncedAt.toISOString(),
    version: record.version,
  }
}

export function identityOf(record: CampaignRecord, parts: { portfolioName: string | null; ownerName: string | null }): AdsCampaignIdentity {
  return {
    id: record.id,
    adsProfileId: record.adsProfileId,
    externalCampaignId: record.externalCampaignId,
    adProduct: record.adProduct,
    productLabel: productLabelOf(record.adProduct),
    name: record.name,
    targetingType: targetingOf(record.targetingType),
    state: record.state,
    servingStatus: record.servingStatus,
    budget: num(record.budget),
    budgetType: record.budgetType,
    currency: record.currency,
    bidStrategy: record.bidStrategy,
    placementAdjustments: { state: 'NOT_CONNECTED', note: NOT_CONNECTED_PLACEMENT_ADJUSTMENT },
    portfolio: record.portfolioId ? { id: record.portfolioId, name: parts.portfolioName } : null,
    account: {
      name: record.adsProfile.displayName ?? record.adsProfile.profileId,
      adsAccountId: record.adsProfile.adsAccountId,
      storeName: record.adsProfile.sellerAccount?.displayName ?? null,
      bindingStatus: record.adsProfile.bindingStatus,
    },
    startDate: day(record.startDate),
    endDate: day(record.endDate),
    syncedAt: record.syncedAt.toISOString(),
    tags: record.tags ?? [],
    owner: record.ownerId ? { id: record.ownerId, name: parts.ownerName ?? record.ownerId } : null,
    version: record.version,
  }
}

/** 广告组合名称：按“广告档案 | 组合编号”查。 */
export async function portfolioNames(prisma: PrismaService, tenantId: string, records: ReadonlyArray<{ adsProfileId: string; portfolioId: string | null }>): Promise<Map<string, string>> {
  const wanted = records.filter((record): record is { adsProfileId: string; portfolioId: string } => Boolean(record.portfolioId))
  if (wanted.length === 0) return new Map()
  const found = await prisma.adsPortfolio.findMany({
    where: { tenantId, adsProfileId: { in: [...new Set(wanted.map(item => item.adsProfileId))] }, portfolioId: { in: [...new Set(wanted.map(item => item.portfolioId))] } },
    select: { adsProfileId: true, portfolioId: true, name: true },
    orderBy: [{ id: 'asc' }],
    take: 5000,
  })
  return new Map(found.map(item => [portfolioKey(item.adsProfileId, item.portfolioId), item.name]))
}
export const portfolioKey = (adsProfileId: string, portfolioId: string) => `${adsProfileId}|${portfolioId}`

/** 在职成员（可被指定为负责人）；按显示名排序，最多 200 个。 */
export async function activeMembers(prisma: PrismaService, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await prisma.membership.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: { userId: true, user: { select: { displayName: true, email: true } } },
    orderBy: [{ userId: 'asc' }],
    take: 200,
  })
  return rows.map(row => ({ id: row.userId, name: row.user.displayName || row.user.email })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 企业时区、今天与所选范围（没选范围默认近 30 天，并默认对比上一期）。 */
export async function rangeOf(prisma: PrismaService, tenantId: string, dates: ScopeDates, now: Date = new Date()) {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const zone = validZone(tenant?.timezone)
  const today = todayIn(zone, now)
  return { zone, today, ...resolvePeriods(dates, today) }
}

export interface ResolvedCampaign {
  campaign: CampaignRecord
  ctx: AdsLoadContext
  scope: ResolvedScope
  tenantId: string
  userId: string
  permissions: readonly string[]
}

export interface OpenedTab extends ResolvedCampaign {
  query: AdsCampaignTabQuery
  period: DashPeriod
  /** 游标绑定值：租户 + 活动 + 全部查询条件。 */
  binding: string
  offset: number
}

// 按编号找活动：权限与数据范围先于一切（范围外的活动与不存在一样返回 404，不泄露存在性）。
@Injectable()
export class AdsCampaignAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 列表型页签的公共前置：找活动、校验分页与筛选参数、解析时间范围、绑定游标。 */
  async openTab(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<OpenedTab> {
    const resolved = await this.resolve(req, id, rawQuery)
    const query = AdsCampaignTabQuerySchema.parse(rawQuery)
    const { period } = await rangeOf(this.prisma, resolved.tenantId, ScopeSearchSchema.parse(rawQuery))
    const binding = bindingOf(resolved.tenantId, { ...rawQuery, id })
    return { ...resolved, query, period, binding, offset: decodeOffset(query.cursor, binding) }
  }

  async resolve(req: RequestWithContext, id: string, query: Record<string, string>): Promise<ResolvedCampaign> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, query)
    if (!CAMPAIGN_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '广告活动不存在')
    const campaign = await this.prisma.adsCampaign.findFirst({ where: { id, tenantId: context.tenantId, ...adsRelationWhere(scope) }, select: CAMPAIGN_SELECT })
    if (!campaign) throw appError('RESOURCE_NOT_FOUND', '广告活动不存在')
    return { campaign, ctx: { tenantId: context.tenantId, scope }, scope, tenantId: context.tenantId, userId: context.userId, permissions: context.permissions }
  }
}
