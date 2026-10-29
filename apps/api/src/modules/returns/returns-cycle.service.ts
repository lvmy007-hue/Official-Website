import { Injectable } from '@nestjs/common'
import {
  RETURN_ANALYSIS_BASIS,
  RETURN_ANALYSIS_ROW_CAP,
  RETURN_DISPOSITION_LABEL,
  RETURN_SLICE_ROWS,
  cycleBucketIndex,
  cycleBucketsOf,
  cycleStats,
  parseBounds,
  resolveReason,
  returnDaysBetween,
  returnDispositionView,
  shareOf,
  type ReasonOverride,
  type ReturnCycleBucketRow,
  type ReturnCycleDimension,
  type ReturnCycleResponse,
  type ReturnCycleSliceRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { localDate } from '../overview'
import { ReturnsAnalysisContextService } from './returns-analysis-context'
import { ReturnsReasonMapService } from './returns-reason-map.service'

const OTHER_KEY = '__OTHER__'

interface CycleRow {
  asin: string
  reason: string | null
  disposition: string | null
  units: number
  days: number | null
}

function sliceKey(row: CycleRow, dimension: ReturnCycleDimension): { key: string; label: string } {
  if (dimension === 'asin') return { key: row.asin, label: row.asin }
  if (dimension === 'reason') {
    const view = resolveReason(row.reason)
    return { key: view.code, label: view.code }
  }
  const group = returnDispositionView(null, row.disposition).group
  return { key: group, label: RETURN_DISPOSITION_LABEL[group] }
}

// 退货周期（P6-13，M-702 的前提）：退货日期 − 下单日期（或发货日期）的整天数，按可配置的天数段分布，按件数加权取中位数；可按 ASIN、原因、处置结果切片。
// 缺起点日期、起点晚于退货日期的记录不参与，单独计数（页面写“无法计算周期 N 条”），既不当 0 天也不丢掉。
@Injectable()
export class ReturnsCycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ReturnsAnalysisContextService,
    private readonly reasons: ReturnsReasonMapService,
  ) {}

  async cycle(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnCycleResponse> {
    const a = await this.ctx.open(req, rawQuery, 'cycle')
    const { zone, params } = a
    const { bounds } = parseBounds(params.bounds)
    const orderBy = { [a.dateField]: 'desc' } as Prisma.FbaReturnCaseOrderByWithRelationInput
    const [records, extraUnknown, freshness, overrides] = await Promise.all([
      this.prisma.fbaReturnCase.findMany({
        where: a.where,
        select: { asin: true, reason: true, disposition: true, quantity: true, returnDate: true, orderPurchasedAt: true, orderShippedAt: true },
        orderBy,
        take: RETURN_ANALYSIS_ROW_CAP,
      }),
      // 按下单时间统计时，缺下单时间的退货本来就不在范围内，要单独数出来；按退货时间统计时它们在明细里，由下面逐条判断
      a.timeBasis === 'order' ? this.ctx.unknown(a.unknownWhere) : Promise.resolve({ units: 0, rows: 0 }),
      this.ctx.freshness(a.tenantId, a.scope),
      params.dimension === 'reason' ? this.reasons.index(a.tenantId) : Promise.resolve(new Map<string, ReasonOverride>()),
    ])

    const rows = records.map((record): CycleRow => {
      const anchor = params.anchor === 'ship' ? record.orderShippedAt : record.orderPurchasedAt
      return {
        asin: record.asin,
        reason: record.reason,
        disposition: record.disposition,
        units: record.quantity,
        days: anchor ? returnDaysBetween(localDate(anchor, zone), localDate(record.returnDate, zone)) : null,
      }
    })
    const stats = cycleStats(rows, bounds)
    const skipped = rows.filter(row => row.days === null || cycleBucketIndex(row.days, bounds) < 0)
    const defs = cycleBucketsOf(bounds)
    const buckets = defs.map((def, index): ReturnCycleBucketRow => ({ ...def, units: stats.buckets[index] ?? 0, share: stats.units > 0 ? shareOf(stats.buckets[index] ?? 0, stats.units) : null }))

    const slices: ReturnCycleSliceRow[] = []
    if (params.dimension !== 'none') {
      const groups = new Map<string, { label: string; rows: CycleRow[] }>()
      for (const row of rows) {
        const { key, label } = sliceKey(row, params.dimension)
        const group = groups.get(key) ?? { label, rows: [] }
        group.rows.push(row)
        groups.set(key, group)
      }
      const units = (list: CycleRow[]) => list.reduce((sum, row) => (row.days !== null && cycleBucketIndex(row.days, bounds) >= 0 ? sum + row.units : sum), 0)
      const ordered = [...groups.entries()]
        .map(([key, group]) => ({ key, ...group, total: units(group.rows) }))
        .filter(group => group.total > 0)
        .sort((x, y) => y.total - x.total || x.key.localeCompare(y.key))
      const toSlice = (key: string, label: string, list: CycleRow[]): ReturnCycleSliceRow => {
        const own = cycleStats(list, bounds)
        return { key, label, units: own.units, median: own.median, buckets: own.buckets }
      }
      for (const group of ordered.slice(0, RETURN_SLICE_ROWS)) slices.push(toSlice(group.key, params.dimension === 'reason' ? resolveReason(group.key, overrides).label : group.label, group.rows))
      const rest = ordered.slice(RETURN_SLICE_ROWS)
      if (rest.length > 0)
        slices.push(
          toSlice(
            OTHER_KEY,
            '其他',
            rest.flatMap(group => group.rows),
          ),
        )
    }

    const empty = rows.length === 0 && extraUnknown.rows === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）' : null,
      range: { from: a.from, to: a.to, defaulted: a.defaulted },
      timeBasis: a.timeBasis,
      unknownOrderUnits: stats.unknownUnits + extraUnknown.units,
      unknownOrderRows: skipped.length + extraUnknown.rows,
      basis: RETURN_ANALYSIS_BASIS.cycle,
      freshness,
      anchor: params.anchor,
      bounds,
      buckets,
      totals: { units: stats.units, median: stats.median },
      dimension: params.dimension,
      slices,
      truncated: records.length >= RETURN_ANALYSIS_ROW_CAP,
    }
  }
}
