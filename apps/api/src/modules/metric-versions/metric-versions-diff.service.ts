import { Injectable } from '@nestjs/common'
import {
  METRIC_VERSION_READ,
  METRIC_KIND_LABEL,
  MetricDiffBodySchema,
  PROFIT_FORMULA_READ,
  describeFormulaChanges,
  describeRuleChanges,
  evaluateFormula,
  netSalesOf,
  readBusinessRules,
  readFormulaConfig,
  type BusinessRulesConfig,
  type MetricDiffReport,
  type MetricDiffRow,
  type MetricKind,
  type ProfitFormulaConfig,
} from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import { AppError, appError, RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { dateText } from '../overview'
import { bridgeViewOf, loadTotalsByDate, mergeTotals, profitWhere, type Totals } from '../profit'
import { cleanConfig, VERSION_SELECT } from './metric-versions-common'

const BASIS = 'ORDERED'
const NOTE =
  '差异报告只读：用同一段利润日表，分别按“当前生效版本”和“指定版本”的口径计算，逐月对比；不改写任何关账快照。已关账月份标注“已关账”，它们的快照仍记录关账时的口径版本。收入确认口径取下单口径，范围为你有权限的全部店铺。'
const sum = (values: ReadonlyArray<number | null>): number | null =>
  values.every(value => value === null) ? null : Math.round(values.reduce<number>((total, value) => total + (value ?? 0), 0) * 1_000_000) / 1_000_000
const delta = (proposed: number | null, baseline: number | null): number | null => (proposed === null || baseline === null ? null : Math.round((proposed - baseline) * 1_000_000) / 1_000_000)

// 口径版本差异报告（P6-31）：按新旧口径对同一区间逐月出数，只读、不落库。
@Injectable()
export class MetricVersionsDiffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async diff(req: RequestWithContext, id: string, rawBody: unknown): Promise<MetricDiffReport> {
    const { context, scope } = await this.context.authorizeScoped(req, PROFIT_FORMULA_READ, {})
    if (!hasPermission(context.permissions, METRIC_VERSION_READ)) throw new AppError(403, 'TENANT_ACCESS_DENIED', '口径版本差异报告需要 settings.read 权限')
    if (!canSeeField(context.permissions, 'profit')) throw new AppError(403, 'TENANT_ACCESS_DENIED', '口径版本差异报告需要利润字段权限（field.profit）')
    const body = MetricDiffBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const row = await this.prisma.metricVersion.findFirst({ where: { id, tenantId }, select: VERSION_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '口径版本不存在')
    if (row.kind !== 'PROFIT_FORMULA' && row.kind !== 'BUSINESS_RULES') throw appError('VALIDATION_FAILED', '只有利润公式和业务口径能出差异报告；利润项目字典与费用分摊规则在各自页面里预览')
    const kind = row.kind as MetricKind
    const active = await loadActiveMetrics(this.prisma, tenantId)

    const totalsByMonth = await this.monthlyTotals(tenantId, scope, body.from, body.to)
    const canCost = canSeeField(context.permissions, 'cost')
    const closed = await this.closedMonths(tenantId, body.from, body.to)
    const months = [...totalsByMonth.keys()].sort()

    const common = {
      versionId: row.id,
      kind,
      from: body.from,
      to: body.to,
      targetVersionNo: row.versionNo,
      baselineVersionNo: kind === 'PROFIT_FORMULA' ? active.formula.ref.versionNo : active.rules.ref.versionNo,
    }
    if (kind === 'PROFIT_FORMULA') {
      const target = readFormulaConfig(cleanConfig(row.config))
      if (!target) throw appError('DATA_CONDITION_FAILED', '这个版本的配置读取不出来，不能出差异报告')
      return this.formulaReport({ ...common, baseline: active.formula.config, target, months, totalsByMonth, closed, canCost })
    }
    const target = readBusinessRules(cleanConfig(row.config))
    if (!target) throw appError('DATA_CONDITION_FAILED', '这个版本的配置读取不出来，不能出差异报告')
    return this.rulesReport({ ...common, baseline: active.rules.config, target, months, totalsByMonth, closed })
  }

  private formulaReport(input: {
    versionId: string
    kind: MetricKind
    from: string
    to: string
    targetVersionNo: number
    baselineVersionNo: number
    baseline: ProfitFormulaConfig
    target: ProfitFormulaConfig
    months: string[]
    totalsByMonth: Map<string, Totals>
    closed: Set<string>
    canCost: boolean
  }): MetricDiffReport {
    const rows: MetricDiffRow[] = input.months.map(month => {
      const totals = input.totalsByMonth.get(month) as Totals
      const items = bridgeViewOf(totals, input.canCost).items
      const before = evaluateFormula(input.baseline, items, totals.rows)
      const after = evaluateFormula(input.target, items, totals.rows)
      return {
        month,
        closed: input.closed.has(month),
        baseline: before.grossProfit,
        proposed: after.grossProfit,
        delta: delta(after.grossProfit, before.grossProfit),
        baselineMargin: before.grossMargin,
        proposedMargin: after.grossMargin,
        note: after.note ?? before.note,
      }
    })
    return this.finish(input, 'GROSS_PROFIT', '毛利润', describeFormulaChanges(input.baseline, input.target), rows)
  }

  private rulesReport(input: {
    versionId: string
    kind: MetricKind
    from: string
    to: string
    targetVersionNo: number
    baselineVersionNo: number
    baseline: BusinessRulesConfig
    target: BusinessRulesConfig
    months: string[]
    totalsByMonth: Map<string, Totals>
    closed: Set<string>
  }): MetricDiffReport {
    const changes = describeRuleChanges(input.baseline, input.target)
    if (JSON.stringify(input.baseline.netSales) === JSON.stringify(input.target.netSales)) {
      const note = changes.length === 0 ? '这个版本与当前生效版本的口径相同' : '这些口径变化不改变金额：周起始日、可用库存与“今日”的取法影响的是分桶方式和库存数量，请在对应页面查看'
      return { ...this.finish(input, 'CONFIG_ONLY', '配置差异', changes, []), note }
    }
    const rows: MetricDiffRow[] = input.months.map(month => {
      const totals = input.totalsByMonth.get(month) as Totals
      const amounts = { revenue: totals.rows === 0 ? null : totals.revenue, refunds: totals.refunds, promotion: totals.promotion }
      const before = netSalesOf(input.baseline.netSales, amounts)
      const after = netSalesOf(input.target.netSales, amounts)
      return { month, closed: input.closed.has(month), baseline: before, proposed: after, delta: delta(after, before), note: null }
    })
    return this.finish(input, 'NET_SALES', '净销售额', changes, rows)
  }

  private finish(
    input: { versionId: string; kind: MetricKind; from: string; to: string; targetVersionNo: number; baselineVersionNo: number },
    metric: MetricDiffReport['metric'],
    metricLabel: string,
    configChanges: string[],
    rows: MetricDiffRow[],
  ): MetricDiffReport {
    const totalBaseline = sum(rows.map(item => item.baseline))
    const totalProposed = sum(rows.map(item => item.proposed))
    return {
      versionId: input.versionId,
      kind: input.kind,
      baselineVersionNo: input.baselineVersionNo,
      targetVersionNo: input.targetVersionNo,
      from: input.from,
      to: input.to,
      metric,
      metricLabel: `${METRIC_KIND_LABEL[input.kind]}：${metricLabel}`,
      configChanges,
      rows,
      totalBaseline,
      totalProposed,
      totalDelta: delta(totalProposed, totalBaseline),
      closedMonthsUntouched: rows.filter(item => item.closed).length,
      note: rows.length === 0 ? '所选区间内没有利润日表数据。' + NOTE : NOTE,
    }
  }

  private async monthlyTotals(tenantId: string, scope: Parameters<typeof profitWhere>[1], from: string, to: string): Promise<Map<string, Totals>> {
    const byDate = await loadTotalsByDate(this.prisma, profitWhere(tenantId, scope, BASIS, from, to))
    const months = new Map<string, Totals>()
    for (const point of byDate) {
      const month = point.date.slice(0, 7)
      const current = months.get(month)
      months.set(month, current ? mergeTotals(current, point.totals) : point.totals)
    }
    return months
  }

  /** 区间内有关账中或已关账期间覆盖的月份（任一店铺）。 */
  private async closedMonths(tenantId: string, from: string, to: string): Promise<Set<string>> {
    const rows = await this.prisma.accountingPeriod.findMany({
      where: { tenantId, status: 'CLOSED', periodStart: { lte: new Date(`${to}T00:00:00Z`) }, periodEnd: { gte: new Date(`${from}T00:00:00Z`) } },
      select: { periodStart: true },
      take: 1000,
    })
    return new Set(rows.map(row => dateText(row.periodStart).slice(0, 7)))
  }
}
