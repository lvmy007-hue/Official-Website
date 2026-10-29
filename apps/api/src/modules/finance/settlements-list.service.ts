import { Injectable } from '@nestjs/common'
import { SETTLEMENT_FRESHNESS_KEYS, SETTLEMENT_READ, SettlementListQuerySchema, type SettlementListResponse } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { openExceptionCounts, SETTLEMENT_SELECT, settlementRow } from './settlements-common'

const NOT_FILTERS = ['pageSize', 'sort', 'cursor', 'storeIds', 'legalEntityIds', 'marketplaceId', 'compare', 'compareFrom', 'compareTo', 'displayCurrency']
const filtered = (query: object) => Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)

const NO_DATA_NOTE = '尚无结算单：店铺授权后，财务交易（每 6 小时同步）与结算报告（每天检索一次，结算周期结束后亚马逊才会生成）同步到后显示'

// 结算列表（07 章 7.7）：每张结算单一行，按打款日（没有则周期结束日）从新到旧，游标分页，可按核对状态筛选；只看成员数据范围内的店铺。
// 顶部各状态的张数不受状态筛选影响，只受数据范围影响。金额是结算币种，不跨币种相加。
@Injectable()
export class SettlementsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<SettlementListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, SETTLEMENT_READ, rawQuery)
    const query = SettlementListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const base: Prisma.FbaSettlementWhereInput = { tenantId, ...storeWhere(scope) }
    const binding = bindingOf(tenantId, query)
    const [rows, groups, freshness] = await Promise.all([
      this.prisma.fbaSettlement.findMany({
        where: { AND: [base, query.status ? { reconciliationStatus: query.status } : {}, this.cursor.after(query.cursor, query.sort, binding) as Prisma.FbaSettlementWhereInput] },
        orderBy: this.cursor.orderBy(query.sort),
        take: query.pageSize + 1,
        select: SETTLEMENT_SELECT,
      }),
      this.prisma.fbaSettlement.groupBy({ by: ['reconciliationStatus'], where: base, _count: { _all: true } }),
      sourceFreshness(this.prisma, tenantId, scope, SETTLEMENT_FRESHNESS_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: query.sort, binding })
    const counts = await openExceptionCounts(this.prisma, tenantId, page.items)
    const items = page.items.map(row => settlementRow(row, row.reconciliation ? (counts.get(row.reconciliation.id) ?? 0) : 0))
    const by = (status: string) => groups.find(group => group.reconciliationStatus === status)?._count._all ?? 0
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : filtered(query) ? '没有符合条件的结算单；可以放宽筛选条件' : NO_DATA_NOTE,
      items,
      pageInfo: page.pageInfo,
      summary: { total: groups.reduce((sum, group) => sum + group._count._all, 0), matched: by('MATCHED'), discrepancy: by('DISCREPANCY'), pending: by('PENDING') },
      freshness,
    }
  }
}
