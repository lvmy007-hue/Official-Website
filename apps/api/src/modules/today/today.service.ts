import { Injectable } from '@nestjs/common'
import {
  TODAY_ADS_NOTE,
  TODAY_ESTIMATE_NOTE,
  TODAY_METRIC_VERSION,
  TODAY_NOT_CONNECTED_NOTE,
  TodayEventsQuerySchema,
  type TodayAnomaly,
  type TodayEventsResponse,
  type TodayHourlyResponse,
  type TodayRealtimeState,
  type TodaySummaryResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { localDate } from '../overview'
import { TodayContextService, type TodayRequest } from './today-context'
import { bandOf, detectAnomalies, hourKey, predictStockout, sumUntil, type HourPoint } from './today-math'

const HISTORY_DAYS = 35
const EVENT_SORT = { field: 'occurredAt', dir: 'desc' } as const
const num = (value: unknown) => (value == null ? 0 : Number(value))

@Injectable()
export class TodayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly base: TodayContextService,
    private readonly cursor: CursorService,
  ) {}

  private stateOf(request: TodayRequest, hasHourly: boolean): TodayRealtimeState {
    if (!request.pushConnected) return 'NOT_CONNECTED'
    return hasHourly ? 'LIVE' : 'NO_DATA'
  }

  private storeFilter(request: TodayRequest) {
    return request.storeIds.length === 0 ? { sellerAccountId: '__none__' } : { sellerAccountId: { in: request.storeIds } }
  }

  private async dailyFallback(request: TodayRequest): Promise<TodaySummaryResponse['dailyFallback']> {
    if (request.storeIds.length === 0) return null
    // 最近有汇总的一天（通常是昨天）；没有则 null
    const row = await this.prisma.storeDailySummary.findFirst({
      where: { tenantId: request.context.tenantId, ...this.storeFilter(request), summaryDate: { lte: new Date(`${request.businessDate}T00:00:00Z`) } },
      orderBy: { summaryDate: 'desc' },
      select: { summaryDate: true, units: true, salesAmount: true, orders: true, refreshedAt: true },
    })
    if (!row) return null
    // 同一天可能有多店铺：再聚一次
    const day = row.summaryDate
    const rows = await this.prisma.storeDailySummary.findMany({
      where: { tenantId: request.context.tenantId, ...this.storeFilter(request), summaryDate: day },
      select: { units: true, salesAmount: true, orders: true, refreshedAt: true },
      take: 500,
    })
    const refreshed = rows.reduce<Date | null>((max, item) => (!max || item.refreshedAt > max ? item.refreshedAt : max), null)
    return {
      units: rows.reduce((sum, item) => sum + item.units, 0),
      salesAmount: rows.reduce((sum, item) => sum + num(item.salesAmount), 0),
      orders: rows.reduce((sum, item) => sum + item.orders, 0),
      summaryDate: localDate(day, 'UTC'),
      refreshedAt: refreshed?.toISOString() ?? null,
    }
  }

  private async loadSalesPoints(request: TodayRequest, from: Date, to: Date): Promise<HourPoint[]> {
    if (request.storeIds.length === 0) return []
    const rows = await this.prisma.hourlySalesEvent.findMany({
      where: { tenantId: request.context.tenantId, ...this.storeFilter(request), hourStart: { gte: from, lt: to } },
      select: { hourStart: true, units: true, salesAmount: true },
      take: 20_000,
    })
    const byHour = new Map<string, HourPoint>()
    for (const row of rows) {
      const key = row.hourStart.toISOString()
      const prev = byHour.get(key) ?? { hourStart: row.hourStart, units: 0, salesAmount: 0, pageViews: null }
      prev.units += row.units
      prev.salesAmount += num(row.salesAmount)
      byHour.set(key, prev)
    }
    return [...byHour.values()].sort((a, b) => a.hourStart.getTime() - b.hourStart.getTime())
  }

  private async loadTrafficByHour(request: TodayRequest, from: Date, to: Date): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    if (request.storeIds.length === 0) return map
    const rows = await this.prisma.hourlyTrafficEvent.findMany({
      where: { tenantId: request.context.tenantId, ...this.storeFilter(request), hourStart: { gte: from, lt: to } },
      select: { hourStart: true, pageViews: true },
      take: 20_000,
    })
    for (const row of rows) {
      const key = row.hourStart.toISOString()
      map.set(key, (map.get(key) ?? 0) + row.pageViews)
    }
    return map
  }

  async summary(req: RequestWithContext, query: Record<string, string>): Promise<TodaySummaryResponse> {
    const request = await this.base.prepare(req, query)
    const historyFrom = new Date(request.dayStart.getTime() - HISTORY_DAYS * 86_400_000)
    const [todaySales, historySales, invRows, fallback] = await Promise.all([
      this.loadSalesPoints(request, request.dayStart, request.dayEndExclusive),
      this.loadSalesPoints(request, historyFrom, request.dayStart),
      request.storeIds.length
        ? this.prisma.hourlyInventoryEvent.findMany({
            where: { tenantId: request.context.tenantId, ...this.storeFilter(request), hourStart: { gte: request.dayStart, lt: request.dayEndExclusive } },
            select: { asin: true, availableQty: true, hourStart: true },
            orderBy: { hourStart: 'desc' },
            take: 20_000,
          })
        : Promise.resolve([]),
      this.dailyFallback(request),
    ])
    const hasHourly = todaySales.length > 0 || invRows.length > 0
    const realtimeState = this.stateOf(request, hasHourly)
    const asOfHour = new Date(request.now)
    asOfHour.setUTCMinutes(0, 0, 0)
    const until = new Date(asOfHour.getTime() + 3_600_000)
    const liveTotals = sumUntil(todaySales, until)
    const yday = sumUntil(await this.loadSalesPoints(request, new Date(request.dayStart.getTime() - 86_400_000), request.dayStart), new Date(until.getTime() - 86_400_000))
    const weekAgoStart = new Date(request.dayStart.getTime() - 7 * 86_400_000)
    const weekAgo = sumUntil(await this.loadSalesPoints(request, weekAgoStart, new Date(weekAgoStart.getTime() + 86_400_000)), new Date(until.getTime() - 7 * 86_400_000))

    const latestInv = new Map<string, number>()
    for (const row of invRows) if (!latestInv.has(row.asin)) latestInv.set(row.asin, row.availableQty)
    const outOfStock = [...latestInv.entries()].filter(([, qty]) => qty <= 0).map(([asin, availableQty]) => ({ asin, availableQty }))
    const hourlyAvg = new Map<number, number>()
    for (let hour = 0; hour < 24; hour += 1) {
      const samples = historySales.filter(p => p.hourStart.getUTCHours() === hour)
      if (samples.length) hourlyAvg.set(hour, samples.reduce((s, p) => s + p.units, 0) / samples.length)
    }
    const predictedStockout = [...latestInv.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([asin, availableQty]) => {
        const at = predictStockout({ availableQty, now: request.now, dayEndExclusive: request.dayEndExclusive, hourlyAvgUnits: hourlyAvg })
        return at ? { asin, availableQty, predictedAtHour: at.toISOString(), note: '按过去同星期几同小时销量外推，模型估算' } : null
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
      .slice(0, 50)

    const useFallback = realtimeState !== 'LIVE'
    return {
      realtimeState,
      note: realtimeState === 'NOT_CONNECTED' ? TODAY_NOT_CONNECTED_NOTE : realtimeState === 'NO_DATA' ? '推送已配置，今日尚无小时事件' : '推送估算',
      estimateNote: TODAY_ESTIMATE_NOTE,
      businessDate: request.businessDate,
      asOf: realtimeState === 'LIVE' ? request.now.toISOString() : (fallback?.refreshedAt ?? null),
      currency: 'USD',
      metricVersion: TODAY_METRIC_VERSION,
      totals: useFallback
        ? { units: fallback?.units ?? null, salesAmount: fallback?.salesAmount ?? null, orders: fallback?.orders ?? null }
        : { units: liveTotals.units, salesAmount: liveTotals.salesAmount, orders: null },
      compare: useFallback
        ? { yesterdaySameHour: null, lastWeekSameHour: null }
        : {
            yesterdaySameHour: { units: yday.units, salesAmount: yday.salesAmount, label: '昨日同时段' },
            lastWeekSameHour: { units: weekAgo.units, salesAmount: weekAgo.salesAmount, label: '上周同日同时段' },
          },
      inventory: {
        state: realtimeState === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : latestInv.size ? 'OK' : 'NO_DATA',
        note: realtimeState === 'NOT_CONNECTED' ? TODAY_NOT_CONNECTED_NOTE : latestInv.size ? null : '今日尚无小时库存事件',
        outOfStock: realtimeState === 'LIVE' ? outOfStock : [],
        predictedStockout: realtimeState === 'LIVE' ? predictedStockout : [],
      },
      ads: { state: 'NOT_CONNECTED', note: TODAY_ADS_NOTE, workPackage: 'P3-06' },
      dailyFallback: useFallback ? fallback : null,
    }
  }

  async hourly(req: RequestWithContext, query: Record<string, string>): Promise<TodayHourlyResponse> {
    const request = await this.base.prepare(req, query)
    const historyFrom = new Date(request.dayStart.getTime() - HISTORY_DAYS * 86_400_000)
    const [todaySales, historySales, trafficToday, trafficHistory, salesByAsin] = await Promise.all([
      this.loadSalesPoints(request, request.dayStart, request.dayEndExclusive),
      this.loadSalesPoints(request, historyFrom, request.dayStart),
      this.loadTrafficByHour(request, request.dayStart, request.dayEndExclusive),
      this.loadTrafficByHour(request, historyFrom, request.dayStart),
      request.storeIds.length
        ? this.prisma.hourlySalesEvent.findMany({
            where: { tenantId: request.context.tenantId, ...this.storeFilter(request), hourStart: { gte: historyFrom, lt: request.dayEndExclusive } },
            select: { asin: true, hourStart: true, units: true, salesAmount: true },
            take: 20_000,
          })
        : Promise.resolve([]),
    ])
    const trafficByAsin = request.storeIds.length
      ? await this.prisma.hourlyTrafficEvent.findMany({
          where: { tenantId: request.context.tenantId, ...this.storeFilter(request), hourStart: { gte: historyFrom, lt: request.dayEndExclusive } },
          select: { asin: true, hourStart: true, pageViews: true },
          take: 20_000,
        })
      : []

    const hasHourly = todaySales.length > 0 || trafficToday.size > 0
    const realtimeState = this.stateOf(request, hasHourly)
    const hours: TodayHourlyResponse['hours'] = []
    for (let t = request.dayStart.getTime(); t < request.dayEndExclusive.getTime(); t += 3_600_000) {
      const hourStart = new Date(t)
      const key = hourStart.toISOString()
      const sales = todaySales.find(p => p.hourStart.getTime() === t) ?? { units: 0, salesAmount: 0, hourStart, pageViews: null }
      const pageViews = trafficToday.has(key) ? trafficToday.get(key)! : null
      const histPoints: HourPoint[] = []
      for (let week = 1; week <= 4; week += 1) {
        const at = new Date(t - week * 7 * 24 * 3_600_000)
        const hit = historySales.find(p => p.hourStart.getTime() === at.getTime())
        const views = trafficHistory.get(at.toISOString()) ?? null
        if (hit || views != null) histPoints.push({ hourStart: at, units: hit?.units ?? 0, salesAmount: hit?.salesAmount ?? 0, pageViews: views })
      }
      hours.push({
        hourStart: key,
        units: realtimeState === 'LIVE' ? sales.units : 0,
        salesAmount: realtimeState === 'LIVE' ? sales.salesAmount : 0,
        pageViews: realtimeState === 'LIVE' ? pageViews : null,
        band: realtimeState === 'LIVE' ? bandOf(histPoints) : null,
      })
    }

    const anomalies: TodayAnomaly[] = []
    if (realtimeState === 'LIVE') {
      const todayKeys = new Map<string, HourPoint>()
      const historyMap = new Map<string, HourPoint[]>()
      for (const row of salesByAsin) {
        const point: HourPoint = { hourStart: row.hourStart, units: row.units, salesAmount: num(row.salesAmount), pageViews: null }
        const list = historyMap.get(row.asin) ?? []
        list.push(point)
        historyMap.set(row.asin, list)
        if (row.hourStart >= request.dayStart && row.hourStart < request.dayEndExclusive) todayKeys.set(hourKey(row.asin, row.hourStart), point)
      }
      for (const row of trafficByAsin) {
        const list = historyMap.get(row.asin) ?? []
        const existing = list.find(p => p.hourStart.getTime() === row.hourStart.getTime())
        if (existing) existing.pageViews = row.pageViews
        else list.push({ hourStart: row.hourStart, units: 0, salesAmount: 0, pageViews: row.pageViews })
        historyMap.set(row.asin, list)
        if (row.hourStart >= request.dayStart && row.hourStart < request.dayEndExclusive) {
          const key = hourKey(row.asin, row.hourStart)
          const prev = todayKeys.get(key) ?? { hourStart: row.hourStart, units: 0, salesAmount: 0, pageViews: null }
          prev.pageViews = row.pageViews
          todayKeys.set(key, prev)
        }
      }
      for (const hit of detectAnomalies(todayKeys, historyMap)) {
        anomalies.push({
          asin: hit.asin,
          hourStart: hit.hourStart.toISOString(),
          metric: hit.metric,
          value: hit.value,
          bandMin: hit.bandMin,
          title: hit.metric === 'sales' ? `${hit.asin} 小时销售低于历史同时段` : `${hit.asin} 小时流量低于历史同时段`,
          suggestedAction: '核对活动、库存与竞品价格，必要时调整广告或补货',
        })
      }
    }

    return {
      realtimeState,
      note: realtimeState === 'NOT_CONNECTED' ? TODAY_NOT_CONNECTED_NOTE : realtimeState === 'NO_DATA' ? '推送已配置，今日尚无小时事件' : '推送估算',
      estimateNote: TODAY_ESTIMATE_NOTE,
      businessDate: request.businessDate,
      asOf: realtimeState === 'LIVE' ? request.now.toISOString() : null,
      currency: 'USD',
      hours,
      anomalies,
    }
  }

  async events(req: RequestWithContext, query: Record<string, string>): Promise<TodayEventsResponse> {
    const request = await this.base.prepare(req, query)
    const parsed = TodayEventsQuerySchema.parse(query)
    // 事件流读 EntityEvent（企业时区“今天”）；推送未接入时仍返回已有事件，note 标明实时推送未接入
    const binding = bindingOf(request.context.tenantId, { path: 'today/events', stores: request.storeIds.slice().sort().join(',') })
    const rows = await this.prisma.entityEvent.findMany({
      where: {
        tenantId: request.context.tenantId,
        entityType: { not: 'WORK_ITEM' },
        occurredAt: { gte: request.dayStart, lt: request.dayEndExclusive },
        ...(request.scope.unrestricted ? {} : { OR: [{ sellerAccountId: null }, { sellerAccountId: { in: request.scope.sellerAccountIds } }] }),
        ...(this.cursor.after(parsed.cursor, EVENT_SORT, binding) as object),
      },
      orderBy: this.cursor.orderBy(EVENT_SORT),
      take: parsed.pageSize + 1,
      select: { id: true, occurredAt: true, kind: true, title: true, entityType: true, entityId: true, sellerAccountId: true },
    })
    const page = this.cursor.page(rows, { pageSize: parsed.pageSize, sort: EVENT_SORT, binding })
    return {
      realtimeState: request.pushConnected ? 'LIVE' : 'NOT_CONNECTED',
      note: request.pushConnected ? '对象事件时间线（今日）' : TODAY_NOT_CONNECTED_NOTE,
      items: page.items.map(row => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        kind: row.kind,
        title: row.title,
        entityType: row.entityType,
        entityId: row.entityId,
        sellerAccountId: row.sellerAccountId,
      })),
      pageInfo: page.pageInfo,
    }
  }
}
