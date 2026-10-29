import { Injectable } from '@nestjs/common'
import { PROMOTIONS_READ, PROMOTION_LIST_BASIS, PromotionListQuerySchema, promotionListState, type PromotionListResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'
import { addDays, validZone, zonedDayStart } from '../overview'
import { NO_FEE, NO_REPORT, PROMOTION_SELECT, promotionRow, promotionSources } from './promotions-common'
import { platformFees } from './promotions-fees'
import { reportedTotals } from './promotions-reported'

const NOT_FILTERS = ['pageSize', 'sort', 'cursor', 'storeIds', 'legalEntityIds', 'marketplaceId', 'compare', 'compareFrom', 'compareTo', 'displayCurrency']
const filtered = (query: object) => Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)

// 促销列表（04 章 4.8）：只读同步下来的亚马逊促销，游标分页，按成员的数据范围过滤店铺。
// 可按状态、类型、关键词（标题包含，或促销编号开头）、活动开始日期范围筛选；默认按开始时间新到旧，不设默认日期范围（促销总量小）。
// 每行带绩效报告汇总与平台费用：没有读取权限（finance.read）的人看到“无权限”，没有记录的写“尚无记录”，都不是 0。
@Injectable()
export class PromotionsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<PromotionListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PROMOTIONS_READ, rawQuery)
    const query = PromotionListQuerySchema.parse(rawQuery)
    const sort = { field: query.sort.field, dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)
    const and: Prisma.PromotionWhereInput[] = [{ tenantId: context.tenantId, ...storeWhere(scope) }]
    if (query.status) and.push({ status: query.status })
    if (query.type) and.push({ promotionType: query.type })
    if (query.q) and.push({ OR: [{ title: { contains: query.q, mode: 'insensitive' } }, { promotionId: { startsWith: query.q } }] })
    if (query.from && query.to) {
      const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
      const zone = validZone(tenant?.timezone)
      and.push({ startAt: { gte: zonedDayStart(query.from, zone), lt: zonedDayStart(addDays(query.to, 1), zone) } })
    }
    const [rows, sources] = await Promise.all([
      this.prisma.promotion.findMany({
        where: { AND: [...and, this.cursor.after(query.cursor, sort, binding) as Prisma.PromotionWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: PROMOTION_SELECT,
      }),
      promotionSources(this.prisma, context.tenantId, scope),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const [reported, fees] = await Promise.all([
      reportedTotals(this.prisma, context.tenantId, page.items, sources.reportConnected),
      platformFees(this.prisma, context.tenantId, page.items, hasPermission(context.permissions, 'finance.read')),
    ])
    const items = page.items.map(row => promotionRow(row, reported.get(row.id) ?? NO_REPORT, fees.get(row.id) ?? NO_FEE))
    const hasAny = items.length > 0 || Boolean(query.cursor)
    const state = promotionListState(sources.sync, hasAny)
    return {
      state: state.state,
      note: hasAny || !filtered(query) ? state.note : '没有符合条件的促销；可以放宽筛选条件',
      items,
      pageInfo: page.pageInfo,
      sync: sources.sync,
      freshness: sources.freshness,
      basis: PROMOTION_LIST_BASIS,
    }
  }
}
