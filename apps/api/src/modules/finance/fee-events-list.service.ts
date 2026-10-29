import { Injectable } from '@nestjs/common'
import { FEE_EVENTS_READ, FeeEventListQuerySchema, type FeeEventListResponse } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { EVENT_SELECT, FEE_FRESHNESS_KEYS, eventRow, feeWhere, loadShipmentIds, resolveRange, shipmentKeyOf } from './fee-events-common'

const NOT_FILTERS = ['pageSize', 'sort', 'cursor', 'from', 'to', 'storeIds', 'legalEntityIds', 'marketplaceId', 'compare', 'compareFrom', 'compareTo', 'displayCurrency']
const filtered = (query: object) => Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)

// 费用事件列表（07 章 7.5）：游标分页，按页签（9 类费用分类）、交易状态、对账状态、关键词筛选；默认最近 30 天；只看当前成员数据范围内的店铺。
// 金额带符号（扣费为负），不跨币种相加；报告类的费用事件没有交易状态，交易状态筛选只命中来自财务接口的明细。
@Injectable()
export class FeeEventsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<FeeEventListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, FEE_EVENTS_READ, rawQuery)
    const query = FeeEventListQuerySchema.parse(rawQuery)
    const sort = { field: 'postedAt', dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)
    const { range, gte, lt } = await resolveRange(this.prisma, context.tenantId, query)
    const where = feeWhere(context.tenantId, scope, query, gte, lt)
    const [rows, freshness] = await Promise.all([
      this.prisma.fbaFeeEvent.findMany({
        where: { AND: [where, this.cursor.after(query.cursor, sort, binding) as Prisma.FbaFeeEventWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: EVENT_SELECT,
      }),
      sourceFreshness(this.prisma, context.tenantId, scope, FEE_FRESHNESS_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const shipments = await loadShipmentIds(this.prisma, context.tenantId, page.items)
    const items = page.items.map(row => eventRow(row, shipments.get(shipmentKeyOf(row)) ?? null))
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : emptyNote(filtered(query)),
      items,
      pageInfo: page.pageInfo,
      range,
      freshness,
    }
  }
}

const emptyNote = (isFiltered: boolean) =>
  isFiltered
    ? '没有符合条件的费用事件；可以放宽筛选条件或扩大日期范围'
    : '所选日期范围内尚无费用事件记录；店铺授权并完成财务交易同步后显示（财务交易每 6 小时同步一次，仓储费与入仓不合规费来自各自的报告）'
