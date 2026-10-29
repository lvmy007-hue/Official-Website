import { Injectable } from '@nestjs/common'
import { FEE_CATEGORIES, FEE_CATEGORY_LABEL, FEE_EVENTS_READ, FeeEventListQuerySchema, type FeeCategorySummary, type FeeEventSummaryResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { FEE_FRESHNESS_KEYS, feeWhere, resolveRange } from './fee-events-common'

const round2 = (value: number) => Math.round(value * 100) / 100

// 费用事件页的页签统计：每一类的笔数、按币种分别合计的金额、标记“有差异”的笔数。
// 按当前的时间范围与交易状态、对账状态、关键词筛选统计，但不受“费用类型”筛选影响（页签本身就是类型）。没有记录的类别笔数是 0、合计为空，页面写“尚无记录”。
@Injectable()
export class FeeEventsSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async summary(req: RequestWithContext, rawQuery: Record<string, string>): Promise<FeeEventSummaryResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, FEE_EVENTS_READ, rawQuery)
    const query = FeeEventListQuerySchema.parse(rawQuery)
    const { range, gte, lt } = await resolveRange(this.prisma, context.tenantId, query)
    const where = feeWhere(context.tenantId, scope, query, gte, lt, { withCategory: false })
    const [grouped, flagged, freshness] = await Promise.all([
      this.prisma.fbaFeeEvent.groupBy({ by: ['feeCategory', 'currency'], where, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.fbaFeeEvent.groupBy({ by: ['feeCategory'], where: { AND: [where, { reconciliationStatus: 'DISCREPANCY' }] }, _count: { _all: true } }),
      sourceFreshness(this.prisma, context.tenantId, scope, FEE_FRESHNESS_KEYS),
    ])
    const categories = FEE_CATEGORIES.map((category): FeeCategorySummary => {
      const mine = grouped.filter(row => row.feeCategory === category)
      return {
        category,
        label: FEE_CATEGORY_LABEL[category],
        count: mine.reduce((total, row) => total + row._count._all, 0),
        totals: mine.map(row => ({ currency: row.currency, amount: round2(Number((row._sum.amount ?? 0).toString())) })).sort((a, b) => a.currency.localeCompare(b.currency)),
        discrepancyCount: flagged.find(row => row.feeCategory === category)?._count._all ?? 0,
      }
    })
    return { range, categories, freshness }
  }
}
