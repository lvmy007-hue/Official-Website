import { Injectable } from '@nestjs/common'
import { CASE_TAB_STATUSES, CaseListQuerySchema, OpportunityListQuerySchema, REIMBURSEMENTS_READ, type CaseListResponse, type OpportunityListResponse } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { CASE_SELECT, OPPORTUNITY_SELECT, REIMBURSEMENT_FRESHNESS_KEYS, caseRow, opportunityRow, ownerNamesOf } from './reimbursements-common'

const NOT_FILTERS = ['pageSize', 'sort', 'cursor', 'storeIds', 'legalEntityIds', 'marketplaceId', 'from', 'to', 'compare', 'compareFrom', 'compareTo', 'displayCurrency']
const filtered = (query: object) => Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)

// 赔付机会与案件的列表（07 章 7.3）：游标分页，按成员的数据范围过滤店铺。
// 机会按识别时间新到旧；案件按创建时间新到旧。页签（待提交 / 处理中 / 已到账 / 已拒绝 / 全部案件）是案件状态分组。
@Injectable()
export class ReimbursementsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async opportunities(req: RequestWithContext, rawQuery: Record<string, string>): Promise<OpportunityListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_READ, rawQuery)
    const query = OpportunityListQuerySchema.parse(rawQuery)
    const sort = { field: 'detectedAt', dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)
    const base: Prisma.ReimbursementOpportunityWhereInput = {
      tenantId: context.tenantId,
      ...storeWhere(scope),
      ...(query.rule ? { ruleCode: query.rule } : {}),
      ...(query.status ? { status: query.status } : {}),
    }
    const [rows, freshness] = await Promise.all([
      this.prisma.reimbursementOpportunity.findMany({
        where: { AND: [base, this.cursor.after(query.cursor, sort, binding) as Prisma.ReimbursementOpportunityWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: OPPORTUNITY_SELECT,
      }),
      sourceFreshness(this.prisma, context.tenantId, scope, REIMBURSEMENT_FRESHNESS_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const items = page.items.map(opportunityRow)
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny
        ? null
        : filtered(query)
          ? '没有符合条件的赔付机会；可以放宽筛选条件'
          : '尚无赔付机会：系统每 3 小时按识别规则扫描一次，店铺授权并完成库存台账、退货、移除订单与入仓数据的同步后才会出现',
      items,
      pageInfo: page.pageInfo,
      freshness,
    }
  }

  async cases(req: RequestWithContext, rawQuery: Record<string, string>): Promise<CaseListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_READ, rawQuery)
    const query = CaseListQuerySchema.parse(rawQuery)
    const sort = { field: 'createdAt', dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)
    const tabStatuses = query.tab ? CASE_TAB_STATUSES[query.tab] : null
    const base: Prisma.ReimbursementCaseWhereInput = {
      tenantId: context.tenantId,
      ...storeWhere(scope),
      ...(query.rule ? { ruleCode: query.rule } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.status ? { status: query.status } : tabStatuses ? { status: { in: [...tabStatuses] } } : {}),
    }
    const [rows, freshness] = await Promise.all([
      this.prisma.reimbursementCase.findMany({
        where: { AND: [base, this.cursor.after(query.cursor, sort, binding) as Prisma.ReimbursementCaseWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: CASE_SELECT,
      }),
      sourceFreshness(this.prisma, context.tenantId, scope, REIMBURSEMENT_FRESHNESS_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const names = await ownerNamesOf(this.prisma, context.tenantId, page.items)
    const items = page.items.map(row => caseRow(row, names))
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : filtered(query) ? '没有符合条件的案件；可以放宽筛选条件' : '还没有赔付案件：在“赔付机会”里选一条机会生成案件，提交到亚马逊后回来填写案件编号',
      items,
      pageInfo: page.pageInfo,
      freshness,
    }
  }
}
