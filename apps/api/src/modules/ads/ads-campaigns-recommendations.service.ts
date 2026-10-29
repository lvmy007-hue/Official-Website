import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  ADS_CAMPAIGN_ENTITY_TYPE,
  ADS_CAMPAIGN_EVENT_KIND,
  ADS_CAMPAIGN_WRITE,
  ADS_RECOMMENDATION_DISMISS_ACTION,
  ADS_WRITE_PENDING,
  AdsRecommendationDismissBodySchema,
  flattenFields,
  payloadNumber,
  payloadSummary,
  type AdsCampaignChangeRow,
  type AdsCampaignChangesResponse,
  type AdsCampaignForecastResponse,
  type AdsCampaignRecommendationsResponse,
  type AdsRecommendationRow,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { adsRelationWhere, ContextService } from '../auth'
import { AdsCampaignAccessService, CAMPAIGN_ID_PATTERN, NOT_CONNECTED_AMAZON_CHANGES, num } from './ads-campaigns-common'
import { anyRowInScope } from './ads-campaigns-load'

export const ADS_RECOMMENDATION_EVENT_KIND = 'ads.recommendation.dismiss'
const FORECAST_BASIS = '预测由亚马逊按“假设日预算”计算，不是承诺；字段取自预测原文，区间字段名随亚马逊版本变化，尚未对真实账户核对解析，所以只展示数值字段的路径与值'
const CHANGE_LIMIT = 200
const KIND_LABEL: Record<string, string> = { [ADS_CAMPAIGN_EVENT_KIND]: '标签与负责人', [ADS_RECOMMENDATION_EVENT_KIND]: '忽略官方推荐' }
const RECOMMENDATION_STATUSES = ['NEW', 'ADOPTED', 'IGNORED', 'EXPIRED'] as const

const tagsText = (value: unknown) => (Array.isArray(value) && value.length ? value.join('、') : '（无）')
const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

// 活动详情的“预测与推荐”“操作记录”页签，以及忽略官方推荐（系统内标记，不写亚马逊）。
@Injectable()
export class AdsCampaignRecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly access: AdsCampaignAccessService,
    private readonly audit: AuditWriter,
  ) {}

  async forecast(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsCampaignForecastResponse> {
    const { campaign, ctx } = await this.access.resolve(req, id, rawQuery)
    const rows = await this.prisma.adsForecastRun.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: campaign.adsProfileId, campaignId: campaign.externalCampaignId },
      select: { id: true, requestedAt: true, requestedBudget: true, currency: true, forecastJson: true },
      orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
      take: 20,
    })
    const items = rows.map(row => ({
      id: row.id,
      requestedAt: row.requestedAt.toISOString(),
      requestedBudget: num(row.requestedBudget) ?? 0,
      currency: row.currency,
      fields: flattenFields(row.forecastJson),
    }))
    const base = { items, basis: FORECAST_BASIS, request: ADS_WRITE_PENDING }
    if (items.length > 0) return { ...base, state: 'OK', note: null }
    const ever = await anyRowInScope(this.prisma, ctx, 'adsForecastRun')
    return ever
      ? { ...base, state: 'NO_DATA', note: '这个活动还没有请求过预算预测' }
      : { ...base, state: 'NOT_CONNECTED', note: '预算预测还没有同步（需要预测接口），请求预测随“广告写入接入”之前的预测同步器提供' }
  }

  async recommendations(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsCampaignRecommendationsResponse> {
    const { campaign, ctx, permissions } = await this.access.resolve(req, id, rawQuery)
    const rows = await this.prisma.adsRecommendation.findMany({
      where: { tenantId: ctx.tenantId, adsProfileId: campaign.adsProfileId, entityId: campaign.externalCampaignId, entityType: { equals: 'CAMPAIGN', mode: 'insensitive' } },
      select: { id: true, recommendationId: true, type: true, status: true, receivedAt: true, lastSeenAt: true, decidedBy: true, decidedAt: true, payloadJson: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
      take: 100,
    })
    const names = await memberNames(
      this.prisma,
      ctx.tenantId,
      rows.map(row => row.decidedBy),
    )
    const items = rows.map((row): AdsRecommendationRow => ({
      id: row.id,
      recommendationId: row.recommendationId,
      type: row.type,
      status: (RECOMMENDATION_STATUSES as readonly string[]).includes(row.status) ? (row.status as AdsRecommendationRow['status']) : 'NEW',
      receivedAt: row.receivedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      summary: payloadSummary(row.payloadJson),
      suggestedBudget: payloadNumber(row.payloadJson, ['suggestedBudget', 'recommendedBudget']),
      suggestedBid: payloadNumber(row.payloadJson, ['suggestedBid', 'recommendedBid']),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedByName: row.decidedBy ? nameOrFormer(names, row.decidedBy) : null,
    }))
    const base = { items, canDismiss: hasPermission(permissions as string[], ADS_CAMPAIGN_WRITE), write: ADS_WRITE_PENDING }
    if (items.length > 0) return { ...base, state: 'OK', note: null }
    const ever = await anyRowInScope(this.prisma, ctx, 'adsRecommendation')
    return ever ? { ...base, state: 'NO_DATA', note: '亚马逊没有给这个活动推荐' } : { ...base, state: 'NOT_CONNECTED', note: '官方推荐还没有同步（需要推荐接口）' }
  }

  /** 操作记录：本系统内对这个活动做过的改动（标签、负责人、忽略推荐）。亚马逊侧的变更没有同步器。 */
  async changes(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<AdsCampaignChangesResponse> {
    const { campaign, ctx } = await this.access.resolve(req, id, rawQuery)
    const events = await this.prisma.entityEvent.findMany({
      where: { tenantId: ctx.tenantId, entityType: ADS_CAMPAIGN_ENTITY_TYPE, entityId: campaign.id },
      select: { id: true, kind: true, title: true, occurredAt: true, actorKind: true, actorId: true, detailJson: true },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: CHANGE_LIMIT + 1,
    })
    const kept = events.slice(0, CHANGE_LIMIT)
    const owners = new Set<string>()
    for (const event of kept) {
      const detail = asRecord(event.detailJson)
      for (const side of [asRecord(detail?.before), asRecord(detail?.after)]) if (typeof side?.ownerId === 'string') owners.add(side.ownerId)
    }
    const names = await memberNames(this.prisma, ctx.tenantId, [...kept.map(event => event.actorId), ...owners])
    const side = (value: unknown): string | null => {
      const record = asRecord(value)
      if (!record || !('tags' in record)) return null
      return `标签：${tagsText(record.tags)}；负责人：${typeof record.ownerId === 'string' ? nameOrFormer(names, record.ownerId) : '（无）'}`
    }
    const items = kept.map((event): AdsCampaignChangeRow => {
      const detail = asRecord(event.detailJson)
      return {
        id: event.id,
        source: event.actorKind === 'USER' ? 'manual' : 'system',
        kindLabel: KIND_LABEL[event.kind] ?? event.kind,
        title: event.title,
        occurredAt: event.occurredAt.toISOString(),
        actor: nameOrFormer(names, event.actorId),
        before: side(detail?.before),
        after: side(detail?.after),
      }
    })
    const amazonSide = { state: 'NOT_CONNECTED' as const, note: NOT_CONNECTED_AMAZON_CHANGES }
    return items.length > 0
      ? { state: 'OK', note: null, items, truncated: events.length > CHANGE_LIMIT, amazonSide }
      : { state: 'NO_DATA', note: '本系统内还没有对这个活动做过改动', items: [], truncated: false, amazonSide }
  }

  /** 忽略一条官方推荐：只在本系统标记为“已忽略”（不通知亚马逊），必须写原因；已处理过的推荐不能再忽略。 */
  async dismiss(req: RequestWithContext, recommendationId: string, rawBody: unknown): Promise<{ id: string; status: 'IGNORED' }> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_CAMPAIGN_WRITE, {})
    if (!CAMPAIGN_ID_PATTERN.test(recommendationId)) throw appError('RESOURCE_NOT_FOUND', '推荐不存在')
    const body = AdsRecommendationDismissBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const recommendation = await this.prisma.adsRecommendation.findFirst({
      where: { id: recommendationId, tenantId, ...adsRelationWhere(scope) },
      select: { id: true, type: true, status: true, entityType: true, entityId: true, adsProfileId: true, adsProfile: { select: { sellerAccountId: true } } },
    })
    if (!recommendation) throw appError('RESOURCE_NOT_FOUND', '推荐不存在')
    if (recommendation.status !== 'NEW') throw appError('CONFLICT', '这条推荐已经处理过了，请刷新后查看', { details: { status: recommendation.status } })
    const campaign =
      recommendation.entityType.toUpperCase() === 'CAMPAIGN'
        ? await this.prisma.adsCampaign.findFirst({
            where: { tenantId, adsProfileId: recommendation.adsProfileId, externalCampaignId: recommendation.entityId },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        : null
    const now = new Date()
    await this.prisma.$transaction(async tx => {
      // 只更新仍是 NEW 的行：两个人同时点“忽略”时只有一个成功
      const result = await tx.adsRecommendation.updateMany({ where: { id: recommendation.id, tenantId, status: 'NEW' }, data: { status: 'IGNORED', decidedBy: context.userId, decidedAt: now } })
      if (result.count === 0) throw appError('CONFLICT', '这条推荐刚刚被别人处理了，请刷新后查看')
      if (campaign) {
        await tx.entityEvent.create({
          data: {
            tenantId,
            sellerAccountId: recommendation.adsProfile.sellerAccountId,
            entityType: ADS_CAMPAIGN_ENTITY_TYPE,
            entityId: campaign.id,
            kind: ADS_RECOMMENDATION_EVENT_KIND,
            occurredAt: now,
            title: `忽略官方推荐（${recommendation.type}）：${body.reason}`,
            actorKind: 'USER',
            actorId: context.userId,
            sourceRef: `dismiss:${recommendation.id}`,
          },
        })
      }
      await this.audit.record(
        req,
        { action: ADS_RECOMMENDATION_DISMISS_ACTION, resourceType: 'AdsRecommendation', resourceId: recommendation.id, before: { status: 'NEW' }, after: { status: 'IGNORED' }, reason: body.reason },
        { client: tx },
      )
    })
    return { id: recommendation.id, status: 'IGNORED' }
  }
}
