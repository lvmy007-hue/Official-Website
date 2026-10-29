import { Injectable } from '@nestjs/common'
import {
  BRIDGE_DEFS,
  PROFIT_FLAGS,
  PROFIT_FLAG_KEYS,
  PROFIT_METRIC_VERSION,
  ProfitQuerySchema,
  describeBusinessRule,
  describeFormula,
  evaluateFormula,
  netSalesOf,
  type ProfitFlagCount,
  type ProfitOverviewResponse,
  type ProfitTrendPoint,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { stripSensitiveFields } from '../../platform/field-filter'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { bridgeViewOf, coverageOf, marginOf } from './profit-aggregate'
import { NO_DATA_NOTE, ProfitAccessService } from './profit-access.service'
import { ProfitDictionaryService } from './profit-dictionary.service'
import { loadTotals, loadTotalsByDate } from './profit-load'

const NOTES = [
  '金额币种为美元：利润日表目前只算美元，非美元的订单行与广告花费没有计入（带“非美元数据未计入”标记）。',
  '广告花费先按广告商品报表归属到 ASIN，剩余按销售额或销量分摊到当天有销售的 SKU，分不出去的留在店铺级行；尚未接入，不是 0）。“尚未接入”，不是 0）。',
  '净利润只要有一行因缺少成本算不出就整体不给，不拿部分数字冒充；商品成本版本生效后（P2b-14）利润会逐步补全。',
]

// 利润总览（07 章 7.9 第 1 个页签）：净利润与利润率、利润桥、利润趋势、数据质量标记汇总。
@Injectable()
export class ProfitOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProfitAccessService,
    private readonly dictionary: ProfitDictionaryService,
  ) {}

  async overview(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ProfitOverviewResponse> {
    const access = await this.access.resolve(req, rawQuery, 'profit', now)
    const { recognition } = ProfitQuerySchema.parse({ recognition: rawQuery.recognition })
    const where = this.access.where(access, recognition)
    const [totals, byDate, flagRows, latest, freshness] = await Promise.all([
      loadTotals(this.prisma, where),
      loadTotalsByDate(this.prisma, where),
      Promise.all(PROFIT_FLAG_KEYS.map(flag => this.prisma.profitDaily.count({ where: { ...where, flags: { has: flag } } }))),
      this.prisma.profitDaily.aggregate({ where, _max: { refreshedAt: true } }),
      this.access.freshness(access, now),
    ])
    const empty = totals.rows === 0
    const flags: ProfitFlagCount[] = PROFIT_FLAG_KEYS.flatMap((flag, index) => {
      const rows = flagRows[index] ?? 0
      return rows > 0 ? [{ flag, label: PROFIT_FLAGS[flag].label, severity: PROFIT_FLAGS[flag].severity, note: PROFIT_FLAGS[flag].note, rows }] : []
    }).sort((a, b) => (a.severity === b.severity ? b.rows - a.rows : a.severity === 'WARN' ? -1 : 1))
    const trend: ProfitTrendPoint[] = byDate.map(point => ({ date: point.date, revenue: point.totals.revenue, profit: point.totals.profit, coveredProfit: point.totals.coveredProfit }))
    const bridge = bridgeViewOf(totals, access.canCost)
    const dictionary = await this.dictionary.view({ tenantId: access.tenantId, where, bridge, canCost: access.canCost })
    // 口径版本（P6-31）：毛利润、毛利率与净销售额按企业当前生效的版本算；净利润与利润率不受影响
    const metrics = await loadActiveMetrics(this.prisma, access.tenantId)
    const evaluated = evaluateFormula(metrics.formula.config, bridge.items, totals.rows)
    const response: ProfitOverviewResponse = {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? NO_DATA_NOTE : null,
      ...this.access.common(access, recognition, freshness),
      summary: {
        revenue: empty ? null : totals.revenue,
        units: totals.units,
        netProfit: totals.profit,
        margin: marginOf(totals.profit, totals.revenue),
        coveredProfit: totals.coveredProfit,
        incompleteRows: totals.incompleteRows,
        rows: totals.rows,
        costCoverage: coverageOf(totals.costedUnits, totals.units),
      },
      bridge,
      trend,
      flags,
      refreshedAt: latest._max.refreshedAt?.toISOString() ?? null,
      metricVersion: PROFIT_METRIC_VERSION,
      notes: NOTES,
      dictionary,
      metricVersions: metrics.versions,
      formula: {
        versionNo: metrics.formula.ref.versionNo,
        source: metrics.formula.ref.source,
        texts: describeFormula(metrics.formula.config),
        grossProfit: evaluated.grossProfit,
        grossMargin: evaluated.grossMargin,
        missingLabels: evaluated.missing.map(key => BRIDGE_DEFS[key].label),
        note: evaluated.note,
      },
      netSales: {
        versionNo: metrics.rules.ref.versionNo,
        source: metrics.rules.ref.source,
        text: describeBusinessRule('netSales', metrics.rules.config.netSales),
        value: netSalesOf(metrics.rules.config.netSales, { revenue: empty ? null : totals.revenue, refunds: totals.refunds, promotion: totals.promotion }),
      },
    }
    // 成本覆盖率属成本字段：没有 field.cost 时键不存在
    return stripSensitiveFields(response, access.permissions, { cost: ['summary.costCoverage'] })
  }
}
