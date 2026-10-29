import { Injectable } from '@nestjs/common'
import { MovementQuerySchema, ScopeSearchSchema, STOCK_REPORT_LIMIT, INVENTORY_REPORT_PERMISSION, type CostPoint, type MvResponse } from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { LEDGER_KEYS, sourceFreshness } from './inventory-freshness'
import { previousMonths } from './inventory-health.service'
import { InventoryPolicyService } from './inventory-policy.service'
import { foldLedgerSummary } from './ledger-math'
import { aggregateMovement, indexCosts, sortMovement, totalsOf, withValues } from './movement-math'

// 进销存报表（P6-25，16 章第 4 节）：按 SKU 和月份显示期初、各类变动、期末的数量与货值，以及周转天数、存销比。
// 数据来自库存台账汇总（与 /inventory/ledger 同一份，能追到台账）；期初 + 变动 = 期末，不平衡的行只标红、不改数据。
// 货值 = 数量 × 期末日生效的成本版本的单件总成本（需要成本字段权限；没有成本版本、币种不是美元时不估算，写原因）。
// 周转天数与存销比用发货件数（台账里的“客户发货”，取绝对值）：与库存周转率（M-237，按成本、近 90 天、年化）口径不同，两者并存。

const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (date: Date) => date.toISOString().slice(0, 10)
const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

@Injectable()
export class MovementReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly policies: InventoryPolicyService,
  ) {}

  async report(req: RequestWithContext, rawQuery: Record<string, string>): Promise<MvResponse> {
    // 先做权限检查再解析参数
    const { context, scope } = await this.context.authorizeScoped(req, INVENTORY_REPORT_PERMISSION, rawQuery)
    const input = MovementQuerySchema.parse(rawQuery)
    const range = ScopeSearchSchema.parse(rawQuery)
    const today = await this.policies.todayOf(context.tenantId)
    const from = range.from ?? previousMonths(today, 2)[0]!
    const to = range.to ?? today
    const search: Prisma.InventoryLedgerSummaryWhereInput = input.q
      ? { OR: [{ fnsku: { contains: input.q, mode: 'insensitive' } }, { sku: { contains: input.q, mode: 'insensitive' } }, { asin: { contains: input.q, mode: 'insensitive' } }] }
      : {}
    const [records, freshness] = await Promise.all([
      this.prisma.inventoryLedgerSummary.findMany({
        where: { tenantId: context.tenantId, ...storeWhere(scope), date: { gte: asDate(from), lte: asDate(to) }, ...search },
        orderBy: [{ date: 'desc' }, { id: 'asc' }],
        take: STOCK_REPORT_LIMIT + 1,
      }),
      sourceFreshness(this.prisma, context.tenantId, scope, LEDGER_KEYS),
    ])
    const truncated = records.length > STOCK_REPORT_LIMIT
    const bases = aggregateMovement(foldLedgerSummary(records.slice(0, STOCK_REPORT_LIMIT)), to)
    const costRestricted = !canSeeField(context.permissions, 'cost')
    const costs = costRestricted ? null : indexCosts(await this.costPoints(context.tenantId, [...new Set(bases.map(base => base.sku))], to))
    const all = bases.map(base => withValues(base, costs))
    const kept = input.unbalanced ? all.filter(row => !row.balanced) : all
    const sorted = sortMovement(kept, input.sort.field as 'month', input.sort.dir)
    const start = (input.page - 1) * input.pageSize
    return {
      state: all.length ? 'OK' : 'NO_DATA',
      note: all.length
        ? truncated
          ? '所选范围内的台账记录过多，只读取了最近的一部分，较早月份可能不完整；请缩小时间范围或店铺'
          : null
        : '尚无库存台账记录；台账汇总报告同步后这里会按 SKU 与月份汇总期初、变动与期末',
      items: sorted.slice(start, start + input.pageSize),
      total: sorted.length,
      page: input.page,
      pageSize: input.pageSize,
      from,
      to,
      totals: totalsOf(kept),
      unbalancedCount: all.filter(row => !row.balanced).length,
      costRestricted,
      truncated,
      freshness,
    }
  }

  /** 这些 SKU 在范围结束日之前生效的成本版本（只取生效中的）。 */
  private async costPoints(tenantId: string, skus: readonly string[], asOf: string): Promise<CostPoint[]> {
    if (skus.length === 0) return []
    const rows = await this.prisma.costVersion.findMany({
      where: { tenantId, status: 'ACTIVE', sku: { in: [...skus] }, effectiveFrom: { lte: asDate(asOf) } },
      select: { sku: true, versionNo: true, effectiveFrom: true, currency: true, unitProductCost: true, unitFirstMileCost: true, unitDutyCost: true, unitOtherCost: true },
      orderBy: [{ sku: 'asc' }, { versionNo: 'asc' }],
      take: STOCK_REPORT_LIMIT,
    })
    return rows.map(row => ({
      sku: row.sku,
      versionNo: row.versionNo,
      effectiveFrom: dateText(row.effectiveFrom),
      currency: row.currency,
      unitProductCost: num(row.unitProductCost),
      unitFirstMileCost: num(row.unitFirstMileCost),
      unitDutyCost: num(row.unitDutyCost),
      unitOtherCost: num(row.unitOtherCost),
    }))
  }
}
