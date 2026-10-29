import { Injectable } from '@nestjs/common'
import {
  ALLOCATION_RULE_BASES,
  ALLOCATION_RULE_BASIS_LABEL,
  ALLOCATION_RULE_NOTES,
  ALLOCATION_RULE_READ,
  AllocationRulesQuerySchema,
  monthText,
  type AllocationRulesResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { loadFeeItems, lockedMonths, ruleRow } from './allocation-rules-common'

/** 费用分摊规则列表（P6-19）：规则按页返回，附可选费用项（只在第一页带，减少重复）与说明。 */
@Injectable()
export class AllocationRulesReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<AllocationRulesResponse & { page: number; pageSize: number }> {
    const context = await this.context.authorize(req, ALLOCATION_RULE_READ)
    const query = AllocationRulesQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const feeItems = await loadFeeItems(this.prisma, tenantId, context.userId, now)
    const pathOf = new Map(feeItems.map(item => [item.id, item]))
    // 费用项名称也要能显示已经不在可选范围内的（例如被改成不接收明细的项目）：按需补查
    const all = await this.prisma.allocationRule.findMany({ where: { tenantId }, orderBy: [{ effectiveMonth: 'desc' }, { feeItemId: 'asc' }], take: 5000 })
    const missing = [...new Set(all.map(rule => rule.feeItemId))].filter(id => !pathOf.has(id))
    const extra = missing.length > 0 ? await this.prisma.profitItem.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, name: true } }) : []
    const names = new Map<string, { name: string; path: string }>([
      ...feeItems.map(item => [item.id, { name: item.name, path: item.path }] as const),
      ...extra.map(item => [item.id, { name: item.name, path: item.name }] as const),
    ])
    const needle = query.q?.toLowerCase()
    const filtered = needle ? all.filter(rule => (names.get(rule.feeItemId)?.path ?? '').toLowerCase().includes(needle)) : all
    const sign = query.sort.dir === 'asc' ? 1 : -1
    const sorted = [...filtered].sort((a, b) => {
      const byItem = (names.get(a.feeItemId)?.path ?? '').localeCompare(names.get(b.feeItemId)?.path ?? '')
      const byMonth = a.effectiveMonth.getTime() - b.effectiveMonth.getTime()
      return query.sort.field === 'feeItem' ? sign * byItem || -byMonth : sign * byMonth || byItem
    })
    const start = (query.page - 1) * query.pageSize
    const pageRows = sorted.slice(start, start + query.pageSize)
    const locked = await lockedMonths(
      this.prisma,
      tenantId,
      pageRows.map(rule => monthText(rule.effectiveMonth)),
    )
    return {
      rows: pageRows.map(rule => ruleRow(rule, names.get(rule.feeItemId), locked.has(monthText(rule.effectiveMonth)))),
      total: sorted.length,
      page: query.page,
      pageSize: query.pageSize,
      feeItems: query.page === 1 ? feeItems.map(({ group: _group, ...item }) => item) : [],
      bases: ALLOCATION_RULE_BASES.map(value => ({ value, label: ALLOCATION_RULE_BASIS_LABEL[value] })),
      notes: [...ALLOCATION_RULE_NOTES],
    }
  }
}
