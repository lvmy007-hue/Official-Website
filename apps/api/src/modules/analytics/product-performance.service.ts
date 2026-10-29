import { Injectable } from '@nestjs/common'
import {
  PP_FAST_KEYS,
  PP_METRICS,
  ProductPerformanceQuerySchema,
  ProductPerformanceSummarySchema,
  type PpMeta,
  type PpMetricKey,
  type PpQueryResponse,
  type PpRow,
  type PpSummaryResponse,
  type ProductPerformanceQuery,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { BusinessReportsAccessService, type BrAccess } from './business-reports-access.service'
import { allowedBy, allowedKeys, capsOf, restrictionsOf, type Caps } from './product-performance-dim'
import { assemble, type Filters } from './product-performance-rows'
import { cellsOf, sortRows, summarize, type CalcRow } from './product-performance-math'

// 商品表现宽表（P6-22，16 章第 2.1 节）：同一套指标按所选维度（ASIN、父 ASIN、SKU、店铺、负责人、品牌、品类）聚合，每个指标有本期、上期、涨跌。
// 查询、汇总共用同一份“行”：汇总行是对符合筛选的全部行的合计，不是当前页之和；排序字段走白名单，没有权限的列整列不返回；
// 迷你趋势与慢指标在 product-performance-slow.service.ts（异步列）。权限先于参数校验。

const GAP_NOTE = '该 ASIN 在店铺下有多个 SKU，销售、流量、广告按 ASIN 统计，不拆分到 SKU'

/** 请求的指标 ∩ 有权限的快指标；没给就是全部有权限的。 */
function wantedKeys(caps: Caps, requested: readonly string[] | undefined): PpMetricKey[] {
  const allowed = new Set(allowedKeys(caps))
  const wanted = requested ? new Set(requested) : null
  return PP_FAST_KEYS.filter(key => allowed.has(key) && (!wanted || wanted.has(key)))
}

const GLOBAL_GAPS = Object.fromEntries((Object.keys(PP_METRICS) as PpMetricKey[]).flatMap(key => ('gap' in PP_METRICS[key] ? [[key, PP_METRICS[key].gap]] : []))) as PpMeta['gaps']

@Injectable()
export class ProductPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
  ) {}

  async query(req: RequestWithContext, rawQuery: Record<string, string>, rawBody: unknown, now = new Date()): Promise<PpQueryResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const input = ProductPerformanceQuerySchema.parse(rawBody ?? {})
    const caps = capsOf(access.permissions)
    this.assertSortable(input, caps)
    const built = await this.rows(access, input, caps)
    const keys = wantedKeys(caps, input.metrics)
    const sorted = sortRows(built.rows, input.sort.field, input.sort.direction)
    const start = (input.page - 1) * input.pageSize
    const items = sorted.slice(start, start + input.pageSize).map(row => this.itemOf(row, built, keys))
    const header = await this.access.header(
      access,
      { range: { ...access.periods.period, defaulted: access.periods.defaulted }, hasData: built.hasData, truncated: built.truncated, latestDate: null },
      now,
    )
    return { ...header, ...this.meta(access, input, caps, built.truncated), items, total: sorted.length, page: input.page, pageSize: input.pageSize }
  }

  async summary(req: RequestWithContext, rawQuery: Record<string, string>, rawBody: unknown, now = new Date()): Promise<PpSummaryResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const input = ProductPerformanceSummarySchema.parse(rawBody ?? {})
    const caps = capsOf(access.permissions)
    const built = await this.rows(access, input, caps)
    const values = summarize(built.rows, caps.profit, caps.cost)
    const totals: PpSummaryResponse['totals'] = {}
    for (const key of wantedKeys(caps, input.metrics)) totals[key] = values[key] ?? null
    return { ...this.meta(access, input, caps, built.truncated), totals, rowCount: built.rows.length, currency: 'USD' }
  }

  private assertSortable(input: ProductPerformanceQuery, caps: Caps) {
    const field = input.sort.field
    if (field !== 'title' && !allowedBy(caps, PP_METRICS[field as PpMetricKey].require)) throw appError('TENANT_ACCESS_DENIED', '没有权限按这一列排序', { status: 403 })
  }

  private rows(access: BrAccess, input: Filters, caps: Caps) {
    return assemble(this.prisma, access, input, caps)
  }

  private meta(access: BrAccess, input: { dimension: PpMeta['dimension'] }, caps: Caps, truncated: boolean): PpMeta {
    const compare = access.periods.compare
    return {
      dimension: input.dimension,
      allowed: allowedKeys(caps),
      restrictions: restrictionsOf(caps),
      gaps: GLOBAL_GAPS,
      compare: compare ? { mode: compare.mode, from: compare.from, to: compare.to, days: compare.days } : null,
      truncated,
    }
  }

  private itemOf(row: CalcRow, built: Awaited<ReturnType<ProductPerformanceService['rows']>>, keys: readonly PpMetricKey[]): PpRow {
    const info = built.infos.get(row.id)!
    return {
      id: row.id,
      dimension: info.dimension,
      title: info.title,
      subtitle: info.subtitle,
      imageUrl: info.imageUrl,
      asin: info.asin,
      sku: info.sku,
      storeName: info.storeName,
      hasChildren: info.hasChildren,
      childCount: info.childCount,
      metrics: cellsOf(row.values, row.before, keys),
      gaps: info.multiSku ? Object.fromEntries(keys.filter(key => PP_METRICS[key].group !== 'profit' && key !== 'netSales').map(key => [key, GAP_NOTE])) : {},
    }
  }
}
