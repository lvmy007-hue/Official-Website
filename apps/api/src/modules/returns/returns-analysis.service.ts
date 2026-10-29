import { Injectable } from '@nestjs/common'
import {
  RETURN_DEFAULT_DAYS,
  RETURNS_PERMISSION,
  ScopeQuerySchema,
  UNSPECIFIED_REASON,
  chooseBucket,
  normalizeReason,
  returnRate,
  returnReasonLabel,
  trendOf,
  type ReturnAnalysisResponse,
  type ReturnAsinRow,
  type ReturnReasonRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { addDays, asDate, dateText, localDate, todayIn, validZone, zonedDayStart } from '../overview'
import { RETURN_FRESHNESS_KEYS } from './returns-list.service'

const ROW_CAP = 20_000
const TOP_ASINS = 20
const TREND_ASINS = 5
const TOP_REASONS = 15
const GROUP_REASON_CAP = 500

const BASIS =
  '退货率 = 退货件数（按退货日期） ÷ 销售件数（经营日汇总，按下单日），两者落在同一个时间桶里；退货总是晚于销售，新上架或销量变化大的商品，短期退货率会偏离真实水平。' +
  '销售件数没有汇总时显示“尚无记录”，不显示 0%。'

const reasonLabelOf = (reason: string) => (reason === UNSPECIFIED_REASON ? '未提供原因' : (returnReasonLabel(reason) ?? reason))

// 退货分析（07 章 7.2 分析视图）：按 ASIN 与原因的退货件数与退货率，整体与前几名 ASIN 的趋势。
// 排行用数据库分组汇总（精确）；趋势用退货明细按企业时区落日再分桶，明细最多读 20000 行，超出时标记 truncated。
@Injectable()
export class ReturnsAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async analysis(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnAnalysisResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, RETURNS_PERMISSION, rawQuery)
    const query = ScopeQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const defaulted = !(query.from && query.to)
    const to = query.to ?? todayIn(zone)
    const from = query.from ?? addDays(to, 1 - RETURN_DEFAULT_DAYS)
    const bucket = chooseBucket(from, to)
    const store = storeWhere(scope)
    const where: Prisma.FbaReturnCaseWhereInput = { tenantId, ...store, returnDate: { gte: zonedDayStart(from, zone), lt: zonedDayStart(addDays(to, 1), zone) } }
    const soldWhere: Prisma.AsinDailySummaryWhereInput = { tenantId, ...store, summaryDate: { gte: asDate(from), lte: asDate(to) } }

    const [total, asinGroups, reasonGroups, detail, soldDaily, freshness] = await Promise.all([
      this.prisma.fbaReturnCase.aggregate({ where, _sum: { quantity: true } }),
      this.prisma.fbaReturnCase.groupBy({ by: ['asin'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: TOP_ASINS }),
      this.prisma.fbaReturnCase.groupBy({ by: ['reason'], where, _sum: { quantity: true }, orderBy: { _sum: { quantity: 'desc' } }, take: GROUP_REASON_CAP }),
      this.prisma.fbaReturnCase.findMany({ where, select: { returnDate: true, asin: true, quantity: true }, orderBy: { returnDate: 'desc' }, take: ROW_CAP }),
      this.prisma.asinDailySummary.groupBy({ by: ['summaryDate'], where: soldWhere, _sum: { units: true } }),
      sourceFreshness(this.prisma, tenantId, scope, RETURN_FRESHNESS_KEYS),
    ])
    const returnedUnits = total._sum.quantity ?? 0
    const soldByDay = soldDaily.length > 0 ? new Map(soldDaily.map(row => [dateText(row.summaryDate), row._sum.units ?? 0])) : null
    const soldTotal = soldByDay ? [...soldByDay.values()].reduce((sum, units) => sum + units, 0) : null
    const topAsins = asinGroups.map(row => row.asin)
    const trendAsins = topAsins.slice(0, TREND_ASINS)

    const [soldByAsin, soldTrendRows, asinReasons, products] =
      topAsins.length === 0
        ? [[], [], [], []]
        : await Promise.all([
            this.prisma.asinDailySummary.groupBy({ by: ['asin'], where: { ...soldWhere, asin: { in: topAsins } }, _sum: { units: true } }),
            this.prisma.asinDailySummary.findMany({ where: { ...soldWhere, asin: { in: trendAsins } }, select: { asin: true, summaryDate: true, units: true }, take: ROW_CAP }),
            this.prisma.fbaReturnCase.groupBy({
              by: ['asin', 'reason'],
              where: { ...where, asin: { in: topAsins } },
              _sum: { quantity: true },
              orderBy: { _sum: { quantity: 'desc' } },
              take: ROW_CAP,
            }),
            this.prisma.fbaProduct.findMany({ where: { tenantId, ...store, asin: { in: topAsins } }, select: { id: true, asin: true, title: true }, orderBy: { updatedAt: 'desc' }, take: 500 }),
          ])

    const returnedByDay = new Map<string, number>()
    const returnedByAsinDay = new Map<string, Map<string, number>>()
    for (const row of detail) {
      const day = localDate(row.returnDate, zone)
      returnedByDay.set(day, (returnedByDay.get(day) ?? 0) + row.quantity)
      if (trendAsins.includes(row.asin)) {
        const days = returnedByAsinDay.get(row.asin) ?? new Map<string, number>()
        days.set(day, (days.get(day) ?? 0) + row.quantity)
        returnedByAsinDay.set(row.asin, days)
      }
    }
    const soldAsinDay = new Map<string, Map<string, number>>()
    for (const row of soldTrendRows) {
      const days = soldAsinDay.get(row.asin) ?? new Map<string, number>()
      days.set(dateText(row.summaryDate), (days.get(dateText(row.summaryDate)) ?? 0) + row.units)
      soldAsinDay.set(row.asin, days)
    }
    const productOf = new Map<string, { id: string; title: string }>()
    for (const product of products) if (!productOf.has(product.asin)) productOf.set(product.asin, product)
    const soldOf = new Map(soldByAsin.map(row => [row.asin, row._sum.units ?? 0]))

    const byAsin = asinGroups.map((group): ReturnAsinRow => {
      const units = group._sum.quantity ?? 0
      const top = asinReasons
        .filter(row => row.asin === group.asin)
        .map(row => ({ code: normalizeReason(row.reason), units: row._sum.quantity ?? 0 }))
        .reduce<Map<string, number>>((acc, row) => acc.set(row.code, (acc.get(row.code) ?? 0) + row.units), new Map())
      const best = [...top.entries()].sort((a, b) => b[1] - a[1])[0]
      const sold = soldOf.get(group.asin) ?? null
      return {
        asin: group.asin,
        returnedUnits: units,
        soldUnits: sold,
        rate: returnRate(units, sold),
        topReason: best ? { code: best[0], label: reasonLabelOf(best[0]), units: best[1] } : null,
        productId: productOf.get(group.asin)?.id ?? null,
        title: productOf.get(group.asin)?.title ?? null,
      }
    })

    // 原因：空原因与“未提供”合并成一行；取前 15 个
    const merged = new Map<string, number>()
    for (const group of reasonGroups) merged.set(normalizeReason(group.reason), (merged.get(normalizeReason(group.reason)) ?? 0) + (group._sum.quantity ?? 0))
    const byReason = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_REASONS)
      .map(([reason, units]): ReturnReasonRow => ({ reason, label: reasonLabelOf(reason), units, share: returnedUnits > 0 ? Math.round((units / returnedUnits) * 10_000) / 10_000 : 0 }))

    const base = {
      range: { from, to, defaulted },
      bucket,
      totals: { returnedUnits, soldUnits: soldTotal, rate: returnRate(returnedUnits, soldTotal) },
      reviewCross: { state: 'NOT_CONNECTED' as const, note: '与评论主题交叉分析要用评价与反馈数据（Customer Feedback API），该模块在阶段 4（P4-13）上线后接入。' },
      basis: BASIS,
      freshness,
    }
    if (returnedUnits === 0 && detail.length === 0) {
      return {
        ...base,
        state: 'NO_DATA',
        note: '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）',
        trend: [],
        asinTrends: [],
        byAsin: [],
        byReason: [],
        truncated: false,
      }
    }
    return {
      ...base,
      state: 'OK',
      note: null,
      trend: trendOf({ from, to, bucket, returnedByDay, soldByDay }),
      asinTrends: trendAsins.map(asin => ({
        asin,
        points: trendOf({ from, to, bucket, returnedByDay: returnedByAsinDay.get(asin) ?? new Map(), soldByDay: soldAsinDay.get(asin) ?? null }),
      })),
      byAsin,
      byReason,
      truncated: detail.length >= ROW_CAP,
    }
  }
}
