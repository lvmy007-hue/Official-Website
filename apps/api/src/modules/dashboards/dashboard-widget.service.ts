import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  DASHBOARD_WIDGET_MAX,
  DASHBOARD_WRITE,
  WidgetBodySchema,
  appendWidget,
  dropWidget,
  emptyLayout,
  isWidgetType,
  parseLayout,
  rangeTooLong,
  sourceByCode,
  type WidgetBody,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { AppError, appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { ReportQueryService } from '../custom-reports'
import { visibleDashboard, widgetViewFor } from './dashboard-access'

// 仪表盘组件（P6-33）。读取时按查看人的数据源权限取数；没有权限返回“无权查看”，不把整个仪表盘打成错误。

const viewOf = (row: { id: string; type: string; query: unknown; options: unknown; version: number }) => ({
  id: row.id,
  type: row.type,
  query: row.query,
  options: row.options,
  version: row.version,
})

@Injectable()
export class DashboardWidgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly queries: ReportQueryService,
  ) {}

  async list(req: RequestWithContext, dashboardId: string) {
    const context = await this.context.resolve(req)
    const dashboard = await this.prisma.dashboard.findFirst({ where: visibleDashboard(context.tenantId, context.userId, dashboardId) })
    if (!dashboard) throw appError('RESOURCE_NOT_FOUND', '仪表盘不存在')
    const rows = await this.prisma.dashboardWidget.findMany({ where: { tenantId: context.tenantId, dashboardId }, orderBy: { createdAt: 'asc' } })
    return { items: rows.map(row => widgetViewFor(row, context.permissions)) }
  }

  async create(req: RequestWithContext, dashboardId: string, raw: unknown) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const body = WidgetBodySchema.parse(raw)
    const bound = this.bind(body)
    const dashboard = await this.owned(context.tenantId, context.userId, dashboardId)
    const count = await this.prisma.dashboardWidget.count({ where: { tenantId: context.tenantId, dashboardId } })
    if (count >= DASHBOARD_WIDGET_MAX) throw appError('QUOTA_EXCEEDED', `每个仪表盘最多 ${DASHBOARD_WIDGET_MAX} 个组件`)
    const layout = parseLayout(dashboard.layout) ?? emptyLayout()
    const widget = await this.prisma.$transaction(async tx => {
      const created = await tx.dashboardWidget.create({
        data: {
          tenantId: context.tenantId,
          dashboardId,
          type: body.type,
          query: bound.query as Prisma.InputJsonValue,
          options: bound.options as Prisma.InputJsonValue,
          version: 1,
        },
      })
      await tx.dashboard.update({
        where: { id: dashboardId },
        data: { layout: appendWidget(layout, created.id, body.type) as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
      })
      return created
    })
    if (req.params) req.params.widgetId = widget.id
    const fresh = await this.prisma.dashboard.findFirst({ where: { id: dashboardId, tenantId: context.tenantId }, select: { version: true } })
    return { ...viewOf(widget), dashboardVersion: fresh?.version ?? dashboard.version + 1 }
  }

  async update(req: RequestWithContext, dashboardId: string, widgetId: string, raw: unknown) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const body = WidgetBodySchema.parse(raw)
    if (!body.version) throw appError('VALIDATION_FAILED', '更新必须带上当前看到的版本号 version', { fieldErrors: { version: ['必须是不小于 1 的整数'] } })
    const bound = this.bind(body)
    await this.owned(context.tenantId, context.userId, dashboardId)
    const current = await this.prisma.dashboardWidget.findFirst({ where: { id: widgetId, tenantId: context.tenantId, dashboardId } })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '组件不存在')
    const row = await updateWithVersion(
      this.prisma.dashboardWidget,
      { id: widgetId, tenantId: context.tenantId },
      body.version,
      { type: body.type, query: bound.query as Prisma.InputJsonValue, options: bound.options as Prisma.InputJsonValue },
      { label: '组件' },
    )
    return viewOf(row)
  }

  async remove(req: RequestWithContext, dashboardId: string, widgetId: string) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const dashboard = await this.owned(context.tenantId, context.userId, dashboardId)
    const layout = dropWidget(parseLayout(dashboard.layout) ?? emptyLayout(), widgetId)
    await this.prisma.$transaction(async tx => {
      const result = await tx.dashboardWidget.deleteMany({ where: { id: widgetId, tenantId: context.tenantId, dashboardId } })
      if (result.count === 0) throw appError('RESOURCE_NOT_FOUND', '组件不存在')
      await tx.dashboard.update({ where: { id: dashboardId }, data: { layout: layout as unknown as Prisma.InputJsonValue, version: { increment: 1 } } })
    })
    return { id: widgetId }
  }

  async read(req: RequestWithContext, dashboardId: string, widgetId: string, rawQuery: Record<string, string>) {
    const context = await this.context.resolve(req)
    const dashboard = await this.prisma.dashboard.findFirst({ where: visibleDashboard(context.tenantId, context.userId, dashboardId) })
    if (!dashboard) throw appError('RESOURCE_NOT_FOUND', '仪表盘不存在')
    const widget = await this.prisma.dashboardWidget.findFirst({ where: { id: widgetId, tenantId: context.tenantId, dashboardId } })
    if (!widget || !isWidgetType(widget.type)) throw appError('RESOURCE_NOT_FOUND', '组件不存在')
    if (widget.type === 'TEXT') {
      const text = widget.options && typeof widget.options === 'object' && 'text' in widget.options ? String((widget.options as { text?: unknown }).text ?? '') : ''
      return { state: 'TEXT' as const, widgetId, text }
    }
    const stored = this.storedQuery(widget.query)
    const source = stored.source ? sourceByCode(stored.source) : undefined
    if (!source || !stored.dimension || !stored.metrics?.length || !hasPermission(context.permissions, source.permission)) {
      return { state: 'RESTRICTED' as const, widgetId, message: '无权查看' }
    }
    const raw = { ...rawQuery }
    if (!raw.from && stored.from) raw.from = stored.from
    if (!raw.to && stored.to) raw.to = stored.to
    try {
      const result = await this.queries.execute(req, source, context.tenantId, context.permissions, raw, {
        dimension: stored.dimension,
        metrics: stored.metrics,
        pageSize: 50,
        from: raw.from,
        to: raw.to,
        q: stored.q,
      })
      // 所选列全部被字段门挡掉时，对查看人就是“无权查看”，不能显示成空表或 0。
      if (result.columns.length === 0) return { state: 'RESTRICTED' as const, widgetId, message: '无权查看' }
      if (widget.type !== 'TABLE' && result.rows.length === 0) return { state: 'EMPTY' as const, widgetId, message: '尚无记录', result }
      return { state: 'OK' as const, widgetId, result }
    } catch (error) {
      if (error instanceof AppError && error.getStatus() === 403) return { state: 'RESTRICTED' as const, widgetId, message: '无权查看' }
      throw error
    }
  }

  private bind(body: WidgetBody): { query: Record<string, unknown>; options: Record<string, unknown> } {
    if (body.type === 'TEXT') {
      const text = body.options?.text?.trim() ?? ''
      if (!text) throw appError('VALIDATION_FAILED', '文本组件要填写内容', { fieldErrors: { text: ['请填写内容'] } })
      return { query: {}, options: { text } }
    }
    const query = body.query
    if (!query) throw appError('VALIDATION_FAILED', '组件要绑定一个数据源查询', { fieldErrors: { query: ['请选择数据源'] } })
    const source = sourceByCode(query.source)
    if (!source) throw appError('VALIDATION_FAILED', '没有这个数据源', { fieldErrors: { source: ['没有这个数据源'] } })
    if (!source.dimensions.some(item => item.code === query.dimension)) {
      throw appError('VALIDATION_FAILED', '维度不适用于这个数据源', { fieldErrors: { dimension: ['维度不适用于这个数据源'] } })
    }
    if (rangeTooLong(query.from, query.to)) throw appError('VALIDATION_FAILED', '日期范围最长 366 天', { fieldErrors: { to: ['日期范围最长 366 天'] } })
    const known = new Set(source.columns.map(column => column.key))
    const bad = query.metrics.filter(key => !known.has(key) && !/^C-[A-Z0-9]{2,20}$/.test(key))
    if (bad.length) throw appError('VALIDATION_FAILED', '有指标不在这个数据源里', { fieldErrors: { metrics: bad } })
    if (body.options?.metric && !query.metrics.includes(body.options.metric)) {
      throw appError('VALIDATION_FAILED', '图表指标必须是查询里的一列', { fieldErrors: { metric: ['图表指标必须是查询里的一列'] } })
    }
    return { query, options: body.options?.metric ? { metric: body.options.metric } : {} }
  }

  private storedQuery(value: unknown): { source?: string; dimension?: string; metrics?: string[]; from?: string; to?: string; q?: string } {
    if (!value || typeof value !== 'object') return {}
    const row = value as Record<string, unknown>
    return {
      source: typeof row.source === 'string' ? row.source : undefined,
      dimension: typeof row.dimension === 'string' ? row.dimension : undefined,
      metrics: Array.isArray(row.metrics) ? row.metrics.filter((item): item is string => typeof item === 'string') : undefined,
      from: typeof row.from === 'string' ? row.from : undefined,
      to: typeof row.to === 'string' ? row.to : undefined,
      q: typeof row.q === 'string' ? row.q : undefined,
    }
  }

  private async owned(tenantId: string, userId: string, id: string) {
    const row = await this.prisma.dashboard.findFirst({ where: { id, tenantId } })
    if (!row || (row.ownerId !== userId && !row.shared)) throw appError('RESOURCE_NOT_FOUND', '仪表盘不存在')
    if (row.ownerId !== userId) throw appError('TENANT_ACCESS_DENIED', '只有创建人可以修改仪表盘')
    return row
  }
}
