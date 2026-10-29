import { Injectable } from '@nestjs/common'
import { PROMOTIONS_READ, PROMOTIONS_WRITE_NOTE, PROMOTION_METHOD_NOTE, benefitTextOf, effectWindow, type PromotionDetailResponse } from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AsinAdsCoverageService } from '../ads'
import { ContextService, storeWhere } from '../auth'
import { localDate, todayIn, validZone } from '../overview'
import { ID_PATTERN, NO_FEE, PROMOTION_SELECT, iso, promotionRow, promotionSources } from './promotions-common'
import { costSection } from './promotions-cost'
import type { DetailContext, DetailRow } from './promotions-context'
import { effectSection } from './promotions-effect'
import { platformFees } from './promotions-fees'
import { profitSection } from './promotions-profit'
import { reportedTotals } from './promotions-reported'
import { adsSection, issuesSection, itemsSection, ITEM_SELECT } from './promotions-sections'

/** 商品清单读取上限（行数）：估算效果、费用、广告都按这些 ASIN 取数；超过时标注“没读全”。 */
const ASIN_READ_LIMIT = 2000

// 促销详情（04 章 4.8）：六个页签（效果 / 商品 / 成本 / 利润 / 问题 / 广告）一次返回，每个页签自己带状态与说明。
// 只读：亚马逊促销接口没有创建、修改、取消，所以响应里明确标 write.supported=false。
// :id 可以是系统编号，也可以是亚马逊促销编号（多个店铺碰巧同号时取最近更新的那个，且只会在成员的数据范围内找）。
// 各页签的数据按权限分别放行：成本里的折扣需要 orders.read、平台费用需要 finance.read、利润需要 field.profit、广告需要 ads.read、商品链接需要 products.read；缺哪个就在哪个页签写“无权限”。
@Injectable()
export class PromotionsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly coverage: AsinAdsCoverageService,
  ) {}

  async detail(req: RequestWithContext, id: string, now = new Date()): Promise<PromotionDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PROMOTIONS_READ, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '促销不存在')
    const tenantId = context.tenantId
    const row: DetailRow | null = await this.prisma.promotion.findFirst({
      where: { tenantId, ...storeWhere(scope), OR: [{ id }, { promotionId: id }] },
      orderBy: { amazonUpdatedAt: 'desc' },
      select: { ...PROMOTION_SELECT, feeJson: true, issuesJson: true },
    })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '促销不存在')
    const [tenant, records, sources] = await Promise.all([
      this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }),
      this.prisma.promotionItem.findMany({ where: { tenantId, promotionRowId: row.id }, orderBy: [{ asin: 'asc' }, { sku: 'asc' }], take: ASIN_READ_LIMIT + 1, select: ITEM_SELECT }),
      promotionSources(this.prisma, tenantId, scope, now),
    ])
    const zone = validZone(tenant?.timezone)
    const today = todayIn(zone, now)
    const asins = [
      ...new Set(
        records
          .slice(0, ASIN_READ_LIMIT)
          .map(item => item.asin)
          .filter(Boolean),
      ),
    ]
    const ctx: DetailContext = {
      tenantId,
      scope,
      permissions: context.permissions,
      row,
      zone,
      today,
      now,
      asins,
      asinsPartial: row.itemsTruncated || records.length > ASIN_READ_LIMIT,
      reportConnected: sources.reportConnected,
      window: effectWindow({ startDate: localDate(row.startAt, zone), endDate: row.endAt ? localDate(row.endAt, zone) : null }, today),
    }
    const canOrders = hasPermission(context.permissions, 'orders.read')
    const canFinance = hasPermission(context.permissions, 'finance.read')
    const [{ section: effect, plan }, cost, items, ads, reported, fees] = await Promise.all([
      effectSection(this.prisma, ctx),
      costSection(this.prisma, ctx, canOrders, canFinance),
      itemsSection(this.prisma, ctx, records, hasPermission(context.permissions, 'products.read')),
      adsSection(this.coverage, ctx, hasPermission(context.permissions, 'ads.read')),
      reportedTotals(this.prisma, tenantId, [row], sources.reportConnected),
      platformFees(this.prisma, tenantId, [row], canFinance, now),
    ])
    const profit = await profitSection(this.prisma, ctx, { canProfit: hasPermission(context.permissions, 'profit.read') && canSeeField(context.permissions, 'profit'), effect, plan, cost })
    return {
      promotion: {
        ...promotionRow(row, reported.get(row.id) ?? effect.reported, fees.get(row.id) ?? NO_FEE),
        mappingId: row.mappingId,
        benefitTextFull: benefitTextOf(row.benefitJson),
        createdAt: iso(row.amazonCreatedAt),
        updatedAt: row.amazonUpdatedAt.toISOString(),
        marketplaceId: row.marketplaceId,
      },
      effect,
      items,
      cost,
      profit,
      issues: issuesSection(ctx, records),
      ads,
      write: { supported: false, note: PROMOTIONS_WRITE_NOTE },
      methodNote: PROMOTION_METHOD_NOTE,
      sync: sources.sync,
      freshness: sources.freshness,
    }
  }
}
