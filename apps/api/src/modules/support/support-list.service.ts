import { Injectable } from '@nestjs/common'
import { SUPPORT_READ, SupportCaseListQuerySchema, supportListState, type SupportCaseListResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'
import { addDays, validZone, zonedDayStart } from '../overview'
import { CASE_SELECT, caseRow, reimbursementLinks, supportSync } from './support-common'

const NOT_FILTERS = ['pageSize', 'sort', 'cursor', 'storeIds', 'legalEntityIds', 'marketplaceId', 'compare', 'compareFrom', 'compareTo', 'displayCurrency']
const filtered = (query: object) => Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)

// 支持案件列表（07 章 7.4）：只读同步下来的亚马逊支持案件，游标分页，按成员的数据范围过滤店铺。
// 可按状态、关键词（主题包含，或案件编号开头）、创建日期范围筛选；默认按最近更新时间新到旧，不设默认日期范围（案件总量小）。
@Injectable()
export class SupportListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<SupportCaseListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, SUPPORT_READ, rawQuery)
    const query = SupportCaseListQuerySchema.parse(rawQuery)
    const sort = { field: query.sort.field, dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)
    const and: Prisma.SupportCaseWhereInput[] = [{ tenantId: context.tenantId, ...storeWhere(scope) }]
    if (query.status) and.push({ status: query.status })
    if (query.q) and.push({ OR: [{ subject: { contains: query.q, mode: 'insensitive' } }, { caseId: { startsWith: query.q } }] })
    if (query.from && query.to) {
      const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
      const zone = validZone(tenant?.timezone)
      and.push({ amazonCreatedAt: { gte: zonedDayStart(query.from, zone), lt: zonedDayStart(addDays(query.to, 1), zone) } })
    }
    const [rows, sync] = await Promise.all([
      this.prisma.supportCase.findMany({
        where: { AND: [...and, this.cursor.after(query.cursor, sort, binding) as Prisma.SupportCaseWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: CASE_SELECT,
      }),
      supportSync(this.prisma, context.tenantId, scope),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    // 没有“赔付”读取权限的人，列表里不带赔付案件的关联
    const links = hasPermission(context.permissions, 'reimbursements.read')
      ? await reimbursementLinks(
          this.prisma,
          context.tenantId,
          scope,
          page.items.map(row => row.caseId),
        )
      : new Map()
    const items = page.items.map(row => caseRow(row, links.get(row.caseId) ?? null))
    const hasAny = items.length > 0 || Boolean(query.cursor)
    const state = supportListState(sync.sync, hasAny)
    return {
      state: state.state,
      note: hasAny || !filtered(query) ? state.note : '没有符合条件的支持案件；可以放宽筛选条件',
      items,
      pageInfo: page.pageInfo,
      sync: sync.sync,
      freshness: sync.freshness,
    }
  }
}
