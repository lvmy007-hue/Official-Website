import { Injectable } from '@nestjs/common'
import {
  RETURN_ANALYSIS_BASIS,
  RETURN_ANALYSIS_ROW_CAP,
  RETURN_DISPOSITION_LABEL,
  UNSPECIFIED_REASON_KEY,
  chooseBucket,
  resolveReason,
  returnDispositionView,
  returnRate,
  shareOf,
  trendOf,
  type ReturnAsinRow,
  type ReturnCategoryRow,
  type ReturnDispositionGroup,
  type ReturnDispositionRow,
  type ReturnReasonSummaryRow,
  type ReturnSummaryResponse,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { asDate, dateText, localDate } from '../overview'
import { ReturnsAnalysisContextService } from './returns-analysis-context'
import { loadRanks } from './returns-ranks'
import { ReturnsReasonMapService } from './returns-reason-map.service'

const TOP_ASINS = 20
const TOP_REASONS = 15
const UNCLASSIFIED_CODES = 20
const GROUP_CAP = 500

// 退货分析概览（P6-13；退货率沿用 M-310 的名称与算法，不是新指标）：趋势、ASIN 与原因（三层：代码、中文释义、大类）排行、处置结果分布、异常榜与改善榜。
// 排行与汇总用数据库分组汇总（精确）；趋势用明细按企业时区落日再分桶，明细最多读 20000 行，超出标 truncated。
@Injectable()
export class ReturnsSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ReturnsAnalysisContextService,
    private readonly reasons: ReturnsReasonMapService,
  ) {}

  async summary(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnSummaryResponse> {
    const a = await this.ctx.open(req, rawQuery, 'basis')
    const { tenantId, zone, from, to, where, dateField } = a
    const store = storeWhere(a.scope)
    const bucket = chooseBucket(from, to)
    const soldWhere: Prisma.AsinDailySummaryWhereInput = { tenantId, ...store, summaryDate: { gte: asDate(from), lte: asDate(to) } }
    const orderBy = { [dateField]: 'desc' } as Prisma.FbaReturnCaseOrderByWithRelationInput

    const [total, asinGroups, reasonGroups, dispositionGroups, detail, soldDaily, unknown, freshness, overrides, ranks] = await Promise.all([
      this.prisma.fbaReturnCase.aggregate({ where, _sum: { quantity: true } }),
      this.prisma.fbaReturnCase.groupBy({ by: ['asin'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: TOP_ASINS }),
      this.prisma.fbaReturnCase.groupBy({ by: ['reason'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: GROUP_CAP }),
      this.prisma.fbaReturnCase.groupBy({ by: ['disposition'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: GROUP_CAP }),
      this.prisma.fbaReturnCase.findMany({ where, select: { returnDate: true, orderPurchasedAt: true, quantity: true }, orderBy, take: RETURN_ANALYSIS_ROW_CAP }),
      this.prisma.asinDailySummary.groupBy({ by: ['summaryDate'], where: soldWhere, _sum: { units: true } }),
      this.ctx.unknown(a.unknownWhere),
      this.ctx.freshness(tenantId, a.scope),
      this.reasons.index(tenantId),
      loadRanks(this.prisma, a),
    ])
    const returnedUnits = total._sum.quantity ?? 0
    const soldByDay = soldDaily.length > 0 ? new Map(soldDaily.map(row => [dateText(row.summaryDate), row._sum.units ?? 0])) : null
    const soldTotal = soldByDay ? [...soldByDay.values()].reduce((sum, units) => sum + units, 0) : null
    const common = {
      range: { from, to, defaulted: a.defaulted },
      timeBasis: a.timeBasis,
      unknownOrderUnits: unknown.units,
      unknownOrderRows: unknown.rows,
      basis: RETURN_ANALYSIS_BASIS.summary,
      freshness,
      bucket,
      totals: { returnedUnits, soldUnits: soldTotal, rate: returnRate(returnedUnits, soldTotal) },
    }
    if (returnedUnits === 0 && detail.length === 0) {
      const lack = a.timeBasis === 'order' && unknown.rows > 0 ? `；另有 ${unknown.rows} 条退货缺下单时间，无法按下单时间统计` : ''
      return {
        ...common,
        state: 'NO_DATA',
        note: `所选日期范围内尚无退货记录${lack}；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）`,
        trend: [],
        byAsin: [],
        byReason: [],
        byCategory: [],
        byDisposition: [],
        ranks,
        unclassified: { codes: [], units: 0 },
        truncated: false,
      }
    }

    // 退货按时间口径落日（企业时区），与销售件数（按下单日）进同一个时间桶
    const returnedByDay = new Map<string, number>()
    for (const row of detail) {
      const at = dateField === 'orderPurchasedAt' ? row.orderPurchasedAt : row.returnDate
      if (!at) continue
      const day = localDate(at, zone)
      returnedByDay.set(day, (returnedByDay.get(day) ?? 0) + row.quantity)
    }

    // 原因：归并键相同的合并，再逐个解析成三层
    const merged = new Map<string, number>()
    for (const group of reasonGroups) {
      const key = resolveReason(group.reason).code
      merged.set(key, (merged.get(key) ?? 0) + (group._sum.quantity ?? 0))
    }
    const resolved = [...merged.entries()].map(([code, units]) => ({ view: resolveReason(code, overrides), units })).sort((x, y) => y.units - x.units || x.view.code.localeCompare(y.view.code))
    const byReason = resolved
      .slice(0, TOP_REASONS)
      .map(({ view, units }): ReturnReasonSummaryRow => ({ code: view.code, label: view.label, category: view.category, unclassified: !view.mapped, units, share: shareOf(units, returnedUnits) }))
    const categories = new Map<string, number>()
    for (const { view, units } of resolved) categories.set(view.category, (categories.get(view.category) ?? 0) + units)
    const byCategory = [...categories.entries()].sort((x, y) => y[1] - x[1]).map(([category, units]): ReturnCategoryRow => ({ category, units, share: shareOf(units, returnedUnits) }))
    const unmapped = resolved.filter(({ view }) => !view.mapped && view.code !== UNSPECIFIED_REASON_KEY)

    const dispositions = new Map<ReturnDispositionGroup, number>()
    for (const group of dispositionGroups) {
      const key = returnDispositionView(null, group.disposition).group
      dispositions.set(key, (dispositions.get(key) ?? 0) + (group._sum.quantity ?? 0))
    }
    const byDisposition = [...dispositions.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([group, units]): ReturnDispositionRow => ({ group, label: RETURN_DISPOSITION_LABEL[group], units, share: shareOf(units, returnedUnits) }))

    const topAsins = asinGroups.map(row => row.asin)
    const [soldByAsin, asinReasons, products] =
      topAsins.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.prisma.asinDailySummary.groupBy({ by: ['asin'], where: { ...soldWhere, asin: { in: topAsins } }, _sum: { units: true } }),
            this.prisma.fbaReturnCase.groupBy({
              by: ['asin', 'reason'],
              where: { ...where, asin: { in: topAsins } },
              _sum: { quantity: true },
              orderBy: { _sum: { quantity: 'desc' } },
              take: RETURN_ANALYSIS_ROW_CAP,
            }),
            this.prisma.fbaProduct.findMany({ where: { tenantId, ...store, asin: { in: topAsins } }, select: { id: true, asin: true, title: true }, orderBy: { updatedAt: 'desc' }, take: 500 }),
          ])
    const soldOf = new Map(soldByAsin.map(row => [row.asin, row._sum.units ?? 0]))
    const productOf = new Map<string, { id: string; title: string }>()
    for (const product of products) if (!productOf.has(product.asin)) productOf.set(product.asin, product)
    const byAsin = asinGroups.map((group): ReturnAsinRow => {
      const units = group._sum.quantity ?? 0
      const perReason = new Map<string, number>()
      for (const row of asinReasons) if (row.asin === group.asin) perReason.set(resolveReason(row.reason).code, (perReason.get(resolveReason(row.reason).code) ?? 0) + (row._sum.quantity ?? 0))
      const best = [...perReason.entries()].sort((x, y) => y[1] - x[1])[0]
      const sold = soldOf.get(group.asin) ?? null
      return {
        asin: group.asin,
        returnedUnits: units,
        soldUnits: sold,
        rate: returnRate(units, sold),
        topReason: best ? { code: best[0], label: resolveReason(best[0], overrides).label, units: best[1] } : null,
        productId: productOf.get(group.asin)?.id ?? null,
        title: productOf.get(group.asin)?.title ?? null,
      }
    })

    return {
      ...common,
      state: 'OK',
      note: null,
      trend: trendOf({ from, to, bucket, returnedByDay, soldByDay }),
      byAsin,
      byReason,
      byCategory,
      byDisposition,
      ranks,
      unclassified: { codes: unmapped.slice(0, UNCLASSIFIED_CODES).map(({ view }) => view.code), units: unmapped.reduce((sum, row) => sum + row.units, 0) },
      truncated: detail.length >= RETURN_ANALYSIS_ROW_CAP,
    }
  }
}
