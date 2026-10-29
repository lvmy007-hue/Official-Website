import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import { ESTIMATED_FEE_NO_WRITE_REASON, ESTIMATED_FEE_NOTES, ESTIMATED_FEE_READ, ESTIMATED_FEE_WRITE, EstimatedFeesQuerySchema, type EstimatedFeesResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { feeRow, loadCostItems } from './estimated-fees-common'

/** 预估与自定义费用列表（P6-20）：按页返回；可选费用项与店铺只在第一页带，减少重复。受限的数据范围只能看到自己店铺范围内的店铺级规则。 */
@Injectable()
export class EstimatedFeesReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<EstimatedFeesResponse & { page: number; pageSize: number }> {
    const { context, scope } = await this.context.authorizeScoped(req, ESTIMATED_FEE_READ, {})
    const query = EstimatedFeesQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const [items, stores, records] = await Promise.all([
      loadCostItems(this.prisma, tenantId, context.userId, now),
      this.prisma.sellerAccount.findMany({
        where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
        select: { id: true, displayName: true },
        orderBy: { displayName: 'asc' },
        take: 500,
      }),
      this.prisma.estimatedFee.findMany({ where: { tenantId }, orderBy: [{ from: 'desc' }, { id: 'asc' }], take: 5000 }),
    ])
    const visible = scope.unrestricted ? records : records.filter(record => record.scopeType === 'STORE' && scope.sellerAccountIds.includes(record.scopeId))
    const itemOf = new Map(items.map(item => [item.id, item]))
    // 已不在可选范围内的费用项（被改成不接收花费的项目）也要显示名称：按需补查
    const missing = [...new Set(visible.map(record => record.itemId))].filter(id => !itemOf.has(id))
    const extra = missing.length > 0 ? await this.prisma.profitItem.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, name: true } }) : []
    for (const item of extra) itemOf.set(item.id, { id: item.id, name: item.name, path: item.name })
    const storeNames = new Map(stores.map(store => [store.id, store.displayName]))
    const rowsAll = visible.map(record => feeRow(record, itemOf.get(record.itemId), storeNames))
    const needle = query.q?.toLowerCase()
    const filtered = rowsAll.filter(
      row =>
        (!query.scopeType || row.scopeType === query.scopeType) &&
        (!query.mode || row.mode === query.mode) &&
        (!query.status || row.status === query.status) &&
        (!needle || row.itemPath.toLowerCase().includes(needle) || row.scopeName.toLowerCase().includes(needle) || row.scopeId.toLowerCase().includes(needle)),
    )
    const sign = query.sort.dir === 'asc' ? 1 : -1
    const byFrom = (a: { from: string; id: string }, b: { from: string; id: string }) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.id < b.id ? -1 : 1)
    const sorted = [...filtered].sort((a, b) => {
      if (query.sort.field === 'item') return sign * a.itemPath.localeCompare(b.itemPath) || byFrom(b, a)
      if (query.sort.field === 'value') return sign * (a.value - b.value) || byFrom(b, a)
      if (query.sort.field === 'updatedAt') return sign * a.updatedAt.localeCompare(b.updatedAt) || byFrom(b, a)
      return sign * byFrom(a, b)
    })
    const start = (query.page - 1) * query.pageSize
    const canWrite = scope.unrestricted && hasPermission(context.permissions, ESTIMATED_FEE_WRITE)
    return {
      rows: sorted.slice(start, start + query.pageSize),
      total: sorted.length,
      page: query.page,
      pageSize: query.pageSize,
      summary: { active: rowsAll.filter(row => row.status === 'ACTIVE').length, inactive: rowsAll.filter(row => row.status === 'INACTIVE').length },
      items: query.page === 1 ? items : [],
      stores: query.page === 1 ? stores.map(store => ({ id: store.id, name: store.displayName })) : [],
      notes: [...ESTIMATED_FEE_NOTES],
      canWrite,
      writeBlockedReason: canWrite ? null : ESTIMATED_FEE_NO_WRITE_REASON,
    }
  }
}
