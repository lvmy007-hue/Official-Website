import { Injectable } from '@nestjs/common'
import { sourceByCode, type ReportQueryRow, type ReportSourceSpec, type SourceColumn } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { AdsMetricsService } from '../ads'
import { ProductPerformanceService } from '../analytics'
import { InventoryHealthService } from '../inventory'
import { ProfitGroupsService } from '../profit'
import { ReturnsListService } from '../returns'

// 五个数据源都调用已经上线的查询服务，这里只做列映射与游标形状统一。不写 SQL。

export interface AdapterPage {
  rows: ReportQueryRow[]
  restrictions: string[]
  hiddenKeys: string[]
  truncated: boolean
  nextCursor: string | null
  hasMore: boolean
  total: number | null
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber: () => number }).toNumber === 'function') {
    const next = (value as { toNumber: () => number }).toNumber()
    return Number.isFinite(next) ? next : null
  }
  return null
}

const pageNumber = (cursor?: string) => {
  const match = cursor ? /^p:(\d+)$/.exec(cursor) : null
  return match ? Number(match[1]) : 1
}

const fill = (columns: readonly SourceColumn[], picked: Record<string, number | null>): Record<string, number | null> => {
  const values: Record<string, number | null> = {}
  for (const column of columns) {
    const value = picked[column.key] ?? null
    values[column.key] = value
    if (column.metricId) values[column.metricId] = value
  }
  return values
}

@Injectable()
export class ReportAdapters {
  constructor(
    private readonly performance: ProductPerformanceService,
    private readonly profit: ProfitGroupsService,
    private readonly ads: AdsMetricsService,
    private readonly inventory: InventoryHealthService,
    private readonly returns: ReturnsListService,
  ) {}

  async load(
    source: ReportSourceSpec,
    req: RequestWithContext,
    query: Record<string, string>,
    input: { dimension: string; pageSize: number; cursor?: string; q?: string; from?: string; to?: string },
  ): Promise<AdapterPage> {
    const scoped = { ...query, ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}) }
    if (source.code === 'product-performance') return this.performancePage(req, scoped, input)
    if (source.code === 'order-profit') return this.profitPage(source, req, scoped, input)
    if (source.code === 'ads') return this.adsPage(source, req, scoped, input)
    if (source.code === 'inventory') return this.inventoryPage(source, req, scoped, input)
    return this.returnsPage(source, req, scoped, input)
  }

  private async performancePage(req: RequestWithContext, query: Record<string, string>, input: { dimension: string; pageSize: number; cursor?: string; q?: string }): Promise<AdapterPage> {
    const source = sourceByCode('product-performance')!
    const page = pageNumber(input.cursor)
    const response = await this.performance.query(req, query, {
      dimension: input.dimension,
      page,
      pageSize: input.pageSize,
      q: input.q,
      metrics: source.columns.map(column => column.key),
    })
    const rows = response.items.map(item => {
      const picked: Record<string, number | null> = {}
      for (const column of source.columns) picked[column.key] = asNumber(item.metrics[column.key as keyof typeof item.metrics]?.value)
      return { id: item.id, label: item.title || item.asin || item.sku || item.id, values: fill(source.columns, picked) }
    })
    const hasMore = page * input.pageSize < response.total
    const hiddenKeys = response.restrictions.flatMap(item => item.metrics)
    return {
      rows,
      restrictions: response.restrictions.map(item => item.reason),
      hiddenKeys,
      truncated: response.truncated,
      nextCursor: hasMore ? `p:${page + 1}` : null,
      hasMore,
      total: response.total,
    }
  }

  private async profitPage(
    source: ReportSourceSpec,
    req: RequestWithContext,
    query: Record<string, string>,
    input: { dimension: string; pageSize: number; cursor?: string; q?: string },
  ): Promise<AdapterPage> {
    const response = await this.profit.asins(req, {
      ...query,
      by: input.dimension,
      pageSize: String(input.pageSize),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.q ? { q: input.q } : {}),
    })
    const rows = response.items.map(item => {
      const picked = { revenue: asNumber(item.revenue), units: asNumber(item.units), profit: asNumber(item.profit), margin: asNumber(item.margin), adsAllocated: asNumber(item.adsAllocated) }
      return { id: item.key, label: item.title || item.asin || item.sku || item.key, values: fill(source.columns, picked) }
    })
    return { rows, restrictions: [], hiddenKeys: [], truncated: response.truncated, nextCursor: response.pageInfo.nextCursor, hasMore: response.pageInfo.hasMore, total: response.pageInfo.approxTotal }
  }

  private async adsPage(source: ReportSourceSpec, req: RequestWithContext, query: Record<string, string>, input: { pageSize: number; cursor?: string }): Promise<AdapterPage> {
    const response = await this.ads.query(req, {
      ...query,
      dataset: 'CAMPAIGN',
      dims: 'campaign',
      metrics: 'spend,sales,orders,acos',
      pageSize: String(input.pageSize),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    })
    const rows = response.items.map(item => {
      const picked = { spend: asNumber(item.values.spend), sales: asNumber(item.values.sales), orders: asNumber(item.values.orders), acos: asNumber(item.values.acos) }
      return { id: item.key, label: item.dims.campaign || item.key, values: fill(source.columns, picked) }
    })
    return {
      rows,
      restrictions: response.note ? [response.note] : [],
      hiddenKeys: [],
      truncated: response.truncated,
      nextCursor: response.pageInfo.nextCursor,
      hasMore: response.pageInfo.hasMore,
      total: response.pageInfo.approxTotal,
    }
  }

  private async inventoryPage(source: ReportSourceSpec, req: RequestWithContext, query: Record<string, string>, input: { pageSize: number; cursor?: string; q?: string }): Promise<AdapterPage> {
    const page = pageNumber(input.cursor)
    const response = await this.inventory.list(req, { ...query, page: String(page), pageSize: String(input.pageSize), ...(input.q ? { q: input.q } : {}) })
    const rows = response.items.map(item => {
      const picked = { sellable: asNumber(item.quantity.sellable), inbound: asNumber(item.quantity.inboundTotal), daysOfCover: asNumber(item.assessment.daysOfCover) }
      return { id: item.id, label: item.sku || item.asin, values: fill(source.columns, picked) }
    })
    const hasMore = page * input.pageSize < response.total
    return {
      rows,
      restrictions: response.policyNote ? [response.policyNote] : [],
      hiddenKeys: [],
      truncated: response.truncated,
      nextCursor: hasMore ? `p:${page + 1}` : null,
      hasMore,
      total: response.total,
    }
  }

  private async returnsPage(source: ReportSourceSpec, req: RequestWithContext, query: Record<string, string>, input: { pageSize: number; cursor?: string; q?: string }): Promise<AdapterPage> {
    const response = await this.returns.list(req, { ...query, pageSize: String(input.pageSize), ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.q ? { q: input.q } : {}) })
    const rows = response.items.map(item => {
      const picked = { quantity: asNumber(item.quantity), refundAmount: asNumber(item.refund.amount) }
      return { id: item.id, label: item.amazonOrderId || item.sku || item.id, values: fill(source.columns, picked) }
    })
    return { rows, restrictions: [], hiddenKeys: [], truncated: false, nextCursor: response.pageInfo.nextCursor, hasMore: response.pageInfo.hasMore, total: response.pageInfo.approxTotal }
  }
}
