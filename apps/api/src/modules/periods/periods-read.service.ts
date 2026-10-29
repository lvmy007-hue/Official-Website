import { Injectable } from '@nestjs/common'
import { PERIOD_CLOSE, PERIOD_READ, PERIOD_STATUSES, PeriodListQuerySchema, type PeriodDetailResponse, type PeriodListResponse, type PeriodStatus } from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { actionsFor, bounds, checklistOf, checklistView, loadPeriod, namesOf, PERIOD_SELECT, periodDetailOf, periodRowOf, statusOf, tenantZone } from './periods-common'
import { diffFor, previewFor, snapshotSummaries } from './periods-view'

const SNAPSHOT_LIMIT = 10

// 期间列表与关账详情（07 章 7.12）。列表按期间起始日排序、页码分页，只看成员数据范围内的店铺；详情带检查清单、预览、快照与差异报告。
@Injectable()
export class PeriodsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<PeriodListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_READ, rawQuery)
    const query = PeriodListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const base: Prisma.AccountingPeriodWhereInput = { tenantId, ...storeWhere(scope) }
    const where: Prisma.AccountingPeriodWhereInput = {
      ...base,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { sellerAccount: { displayName: { contains: query.q, mode: 'insensitive' } } } : {}),
    }
    const canCreate = hasPermission(context.permissions, PERIOD_CLOSE)
    const [rows, total, groups, stores] = await Promise.all([
      this.prisma.accountingPeriod.findMany({
        where,
        select: PERIOD_SELECT,
        orderBy: [{ periodStart: query.sort.dir }, { sellerAccountId: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.accountingPeriod.count({ where }),
      this.prisma.accountingPeriod.groupBy({ by: ['status'], where: base, _count: { _all: true }, orderBy: { status: 'asc' }, take: 10 }),
      canCreate
        ? this.prisma.sellerAccount.findMany({
            where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
            select: { id: true, displayName: true },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
            take: 200,
          })
        : Promise.resolve([]),
    ])
    const names = await namesOf(this.prisma, tenantId, rows)
    const summary = Object.fromEntries(PERIOD_STATUSES.map(status => [status, groups.find(group => group.status === status)?._count._all ?? 0])) as Record<PeriodStatus, number>
    return {
      items: rows.map(row => periodRowOf(row, names)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      summary,
      stores: stores.map(store => ({ id: store.id, name: store.displayName })),
      canCreate,
    }
  }

  async detail(req: RequestWithContext, id: string): Promise<PeriodDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_READ, {})
    const tenantId = context.tenantId
    const row = await loadPeriod(this.prisma, tenantId, scope, id)
    const snapshots = await this.prisma.periodSnapshot.findMany({
      where: { tenantId, periodId: id },
      select: { revision: true, profitSnapshotJson: true, fxSnapshotJson: true, costVersionSnapshotJson: true, diffJson: true, lockedBy: true, lockedAt: true },
      orderBy: { revision: 'desc' },
      take: SNAPSHOT_LIMIT,
    })
    const access = { canProfit: canSeeField(context.permissions, 'profit'), canCost: canSeeField(context.permissions, 'cost') }
    const { start, end } = bounds(row)
    const target = { tenantId, sellerAccountId: row.sellerAccountId, start, end, zone: await tenantZone(this.prisma, tenantId) }
    const status = statusOf(row.status)
    const checklist = checklistOf(row.checklistJson)
    const [preview, diff, names] = await Promise.all([
      previewFor(this.prisma, target, status, snapshots[0], access),
      diffFor(this.prisma, target, status, snapshots, access.canProfit),
      namesOf(this.prisma, tenantId, [row], [...snapshots.map(item => item.lockedBy), ...(checklist?.items.flatMap(item => (item.acknowledgement ? [item.acknowledgement.by] : [])) ?? [])]),
    ])
    return {
      period: periodDetailOf(row, names),
      checklist: checklistView(checklist, names),
      preview,
      snapshots: snapshotSummaries(snapshots, names, access.canProfit),
      diff,
      actions: actionsFor(row, context.userId, context.permissions),
    }
  }
}
