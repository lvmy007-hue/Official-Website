import { Injectable } from '@nestjs/common'
import {
  ASIN_NO_ADS_NOTE,
  ASIN_NO_REVIEWS_NOTE,
  PARENT_CHANGE_KIND_LABEL,
  ParentChangesQuerySchema,
  ScopeSearchSchema,
  type CoverageState,
  type ParentAdsResponse,
  type ParentAdsRow,
  type ParentChange,
  type ParentChangesResponse,
  type ParentInventoryResponse,
  type ParentInventoryRow,
  type ParentReviewsResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { AsinAdsCoverageService } from '../ads'
import { storeWhere } from '../auth'
import { InventoryLoaderService, InventoryPolicyService } from '../inventory'
import { dateText, nullableSum } from '../overview'
import { preferredMap } from './asin-analytics-selection.service'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { loadFamilyDaily } from './business-reports-load'
import { decodeOffset, pageOf } from './business-reports-page'
import { figuresOf } from './business-reports-math'
import { ParentContextService, type ParentContext } from './parent-context.service'
import { stockOf } from './parent-stock'

// 父体详情的库存与补货、广告覆盖、评论主题、变体结构变更历史四个页签（P4-03）。
// 库存页签要 inventory.read，补货建议要 replenishment.read（没有就只显示库存部分）；广告页签要 ads.read；评论主题与变更历史只要 analytics.read。

const CHANGE_LIMIT = 500
const NO_POLICY = '还没有生效的补货策略，风险与可售天数无法计算；先在补货策略里配置'
const NO_STOCK = '这些子体还没有库存记录（库存同步后显示）'
const NO_BATCH = '还没有生成过补货建议（在补货页重新计算后显示）'
const NEED_REPLENISHMENT = '需要“补货”读取权限才能查看补货建议'
const NO_REPORT = '这些店铺的被推广商品日报表还没有同步，所以不知道每个子体有没有被广告覆盖；同步后显示（这里不会把没数据当成“无广告”）'
const ACTOR_LABEL: Record<string, string> = { SYSTEM: '系统', AMAZON: '亚马逊', USER: '成员' }
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits
const ratio = (top: number | null, bottom: number | null, digits: number) => (top === null || bottom === null || bottom <= 0 ? null : round(top / bottom, digits))
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : null)

@Injectable()
export class ParentExtrasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parents: ParentContextService,
    private readonly access: BusinessReportsAccessService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
    private readonly coverage: AsinAdsCoverageService,
  ) {}

  private header(ctx: ParentContext, hasData: boolean, now: Date) {
    return this.access.header(ctx.access, { range: ctx.range, hasData, truncated: ctx.membersTruncated, latestDate: null }, now)
  }

  async inventory(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentInventoryResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now, ['inventory.read'])
    const asins = ctx.members.map(member => member.asin)
    const stock = await stockOf(this.loader, this.policies, { tenantId: ctx.access.tenantId, scope: ctx.access.scope, today: ctx.access.today, asins: new Set(asins) })
    const canPlan = hasPermission(ctx.access.permissions, 'replenishment.read')
    const plans = canPlan ? await this.recommendations(ctx, asins) : null
    const rows = ctx.members.map<ParentInventoryRow>(member => {
      const held = stock.byAsin.get(member.asin)
      const plan = plans?.byAsin.get(member.asin)
      return {
        asin: member.asin,
        title: member.title,
        productId: member.productId,
        skuCount: held?.skuCount ?? 0,
        sellable: held?.sellable ?? null,
        inboundCounted: held?.inboundCounted ?? null,
        daysOfCover: held?.daysOfCover ?? null,
        stockoutDate: held?.stockoutDate ?? null,
        risk: held?.risk ?? null,
        recommendedQty: plan?.qty ?? null,
        recommendedDue: plan?.due ?? null,
        recommendedChannel: plan?.channel ?? null,
      }
    })
    const header = await this.header(ctx, stock.byAsin.size > 0, now)
    return {
      ...header,
      note: stock.byAsin.size > 0 ? null : NO_STOCK,
      truncated: header.truncated || stock.truncated,
      parentAsin: ctx.parentAsin,
      policyState: stock.hasPolicy ? 'OK' : 'NOT_CONNECTED',
      policyNote: stock.hasPolicy ? null : NO_POLICY,
      replenishmentState: !plans ? 'RESTRICTED' : plans.batch ? 'OK' : 'NO_DATA',
      replenishmentNote: !plans ? NEED_REPLENISHMENT : plans.batch ? null : NO_BATCH,
      rows,
    }
  }

  /** 最近一次补货批次里这些 ASIN 的建议：数量相加、最早的到期日；渠道取最早到期那条的。 */
  private async recommendations(ctx: ParentContext, asins: string[]) {
    const { tenantId, scope } = ctx.access
    const batch = await this.prisma.replenishmentBatch.findFirst({ where: { tenantId }, orderBy: { computedAt: 'desc' }, select: { id: true } })
    const byAsin = new Map<string, { qty: number; due: string; channel: string }>()
    if (!batch) return { batch: false, byAsin }
    const found = await this.prisma.replenishmentRecommendation.findMany({
      where: { tenantId, batchId: batch.id, ...storeWhere(scope), asin: { in: asins } },
      select: { asin: true, recommendedQty: true, dueDate: true, channel: true },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 6000,
    })
    for (const rec of found) {
      const held = byAsin.get(rec.asin)
      byAsin.set(rec.asin, { qty: (held?.qty ?? 0) + rec.recommendedQty, due: held?.due ?? dateText(rec.dueDate), channel: held?.channel ?? rec.channel })
    }
    return { batch: true, byAsin }
  }

  async ads(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentAdsResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now, ['ads.read'])
    const asins = ctx.members.map(member => member.asin)
    const [covered, loaded] = await Promise.all([
      this.coverage.coverage({ tenantId: ctx.access.tenantId, scope: ctx.access.scope, storeIds: [...new Set(ctx.family.products.map(product => product.sellerAccountId))], asins, ...ctx.range }),
      loadFamilyDaily(this.prisma, ctx.access.tenantId, ctx.access.scope, asins, ctx.range.from, ctx.range.to),
    ])
    const header = await this.header(ctx, loaded.rows.length > 0, now)
    const base = { ...header, truncated: header.truncated || covered.truncated || loaded.truncated, parentAsin: ctx.parentAsin }
    if (!covered.bound || !covered.everSynced) {
      return { ...base, adsState: 'NOT_CONNECTED', adsNote: covered.bound ? NO_REPORT : ASIN_NO_ADS_NOTE, coveredCount: 0, gapCount: 0, totalSpend: null, totalAdsSales: null, rows: [] }
    }
    const sales = preferredMap(loaded.rows)
    const rows = ctx.members.map<ParentAdsRow>(member => {
      const ad = covered.byAsin.get(member.asin)
      const totalSales = figuresOf(sales.get(member.asin) ?? []).orderedSales
      const coverage: CoverageState = ad?.spend !== null && ad?.spend !== undefined && ad.spend > 0 ? 'COVERED' : (ad?.totalAds ?? 0) > 0 ? 'NO_SPEND' : 'NO_ADS'
      return {
        asin: member.asin,
        title: member.title,
        coverage,
        spend: ad?.spend ?? null,
        adsSales: ad?.sales ?? null,
        orders: ad?.orders ?? null,
        acos: ratio(ad?.spend ?? null, ad?.sales ?? null, 6),
        totalSales,
        adsShare: ratio(ad?.sales ?? null, totalSales, 6),
        enabledAds: ad ? ad.enabledAds : null,
        totalAds: ad ? ad.totalAds : null,
        gap: coverage === 'NO_ADS' && totalSales !== null && totalSales > 0,
      }
    })
    rows.sort((a, b) => (a.totalSales === b.totalSales ? (a.asin < b.asin ? -1 : 1) : a.totalSales === null ? 1 : b.totalSales === null ? -1 : b.totalSales - a.totalSales))
    return {
      ...base,
      adsState: 'OK',
      adsNote: '广告销售按广告归因窗口计，与订购口径的销售额时点不同，占比只是估算',
      coveredCount: rows.filter(row => row.coverage === 'COVERED').length,
      gapCount: rows.filter(row => row.gap).length,
      totalSpend: nullableSum(rows.map(row => row.spend)),
      totalAdsSales: nullableSum(rows.map(row => row.adsSales)),
      rows,
    }
  }

  async reviews(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentReviewsResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now)
    const header = await this.header(ctx, false, now)
    return { ...header, note: ASIN_NO_REVIEWS_NOTE, parentAsin: ctx.parentAsin, reviewsState: 'NOT_CONNECTED', reviewsNote: ASIN_NO_REVIEWS_NOTE, positive: [], negative: [] }
  }

  async changes(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentChangesResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now)
    const query = ParentChangesQuerySchema.parse({ cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const { tenantId, scope } = ctx.access
    const binding = bindingOf(tenantId, { ...ScopeSearchSchema.parse(rawQuery), parentAsin: ctx.parentAsin, cursor: undefined, pageSize: query.pageSize })
    const offset = decodeOffset(query.cursor, binding)
    const productIds = ctx.family.products.map(product => product.id)
    const found = await this.prisma.entityEvent.findMany({
      where: {
        tenantId,
        ...storeWhere(scope),
        OR: [
          { entityType: 'PARENT_ASIN', entityId: ctx.parentAsin, kind: { in: ['variation.child_added', 'variation.child_removed'] } },
          { entityType: 'ASIN', entityId: { in: productIds }, kind: 'variation.attribute_change' },
        ],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: CHANGE_LIMIT + 1,
    })
    const events = found.slice(0, CHANGE_LIMIT)
    const names = await memberNames(
      this.prisma,
      tenantId,
      events.map(row => row.actorId),
    )
    const items = events.map<ParentChange>(row => {
      const detail = row.detailJson && typeof row.detailJson === 'object' && !Array.isArray(row.detailJson) ? (row.detailJson as Record<string, unknown>) : {}
      return {
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        kind: row.kind,
        kindLabel: PARENT_CHANGE_KIND_LABEL[row.kind] ?? '其他变更',
        title: row.title,
        childAsin: text(detail.childAsin),
        before: text(detail.before),
        after: text(detail.after),
        actor: row.actorKind === 'USER' ? nameOrFormer(names, row.actorId) : (ACTOR_LABEL[row.actorKind] ?? '系统'),
      }
    })
    const { page, pageInfo } = pageOf(items, offset, query.pageSize, binding)
    const note = events.length === 0 ? '还没有记录到这个父体的变体结构变化：目录同步每天比较一次，从第二次同步起才会发现新增、移除子体与属性变化' : null
    return { parentAsin: ctx.parentAsin, items: page, pageInfo, truncated: found.length > CHANGE_LIMIT, note }
  }
}
