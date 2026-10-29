import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { DASHBOARD_MAX, DASHBOARD_SHARE, DASHBOARD_WRITE, DashboardBodySchema, DashboardListQuerySchema, emptyLayout, parseLayout, type DashboardLayout } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { assertUniqueName, isUniqueViolation, visibleDashboard, widgetViewFor } from './dashboard-access'

// 自定义仪表盘（P6-33）：自己的和共享的都能看。改布局、名称和刷新间隔只有所有者可以。

type DashRow = {
  id: string
  folderId: string | null
  ownerId: string
  name: string
  shared: boolean
  layout: unknown
  refreshMinutes: number | null
  version: number
  updatedAt: Date
}

const cardOf = (row: DashRow, userId: string, permissions: readonly string[]) => ({
  id: row.id,
  folderId: row.ownerId === userId ? row.folderId : null,
  ownerId: row.ownerId,
  name: row.name,
  shared: row.shared,
  refreshMinutes: row.refreshMinutes,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
  canWrite: row.ownerId === userId && hasPermission(permissions, DASHBOARD_WRITE),
})

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async tree(req: RequestWithContext) {
    const context = await this.context.resolve(req)
    const [folders, rows] = await Promise.all([
      this.prisma.dashboardFolder.findMany({ where: { tenantId: context.tenantId, ownerId: context.userId }, orderBy: { name: 'asc' } }),
      this.prisma.dashboard.findMany({ where: visibleDashboard(context.tenantId, context.userId), orderBy: { name: 'asc' } }),
    ])
    const cards = rows.map(row => cardOf(row, context.userId, context.permissions))
    return {
      folders: folders.map(row => ({ id: row.id, parentId: row.parentId, name: row.name, version: row.version })),
      dashboards: cards.filter(row => row.ownerId === context.userId),
      shared: cards.filter(row => row.ownerId !== context.userId),
    }
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>) {
    const context = await this.context.resolve(req)
    const query = DashboardListQuerySchema.parse(rawQuery)
    const where = {
      ...visibleDashboard(context.tenantId, context.userId),
      ...(query.folderId ? { ownerId: context.userId, folderId: query.folderId } : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
    }
    const [total, rows] = await Promise.all([
      this.prisma.dashboard.count({ where }),
      this.prisma.dashboard.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ])
    return { items: rows.map(row => cardOf(row, context.userId, context.permissions)), total, page: query.page, pageSize: query.pageSize }
  }

  async get(req: RequestWithContext, id: string) {
    const context = await this.context.resolve(req)
    const row = await this.prisma.dashboard.findFirst({ where: visibleDashboard(context.tenantId, context.userId, id) })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '仪表盘不存在')
    const widgets = await this.prisma.dashboardWidget.findMany({ where: { tenantId: context.tenantId, dashboardId: id }, orderBy: { createdAt: 'asc' } })
    return {
      ...cardOf(row, context.userId, context.permissions),
      layout: parseLayout(row.layout) ?? emptyLayout(),
      widgets: widgets.map(widget => widgetViewFor(widget, context.permissions)),
    }
  }

  async create(req: RequestWithContext, raw: unknown) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    if (raw && typeof raw === 'object' && (raw as { shared?: unknown }).shared === true) await this.context.authorize(req, DASHBOARD_SHARE)
    const body = DashboardBodySchema.parse(raw)
    await this.assertFolder(context.tenantId, context.userId, body.folderId ?? null)
    const count = await this.prisma.dashboard.count({ where: { tenantId: context.tenantId, ownerId: context.userId } })
    if (count >= DASHBOARD_MAX) throw appError('QUOTA_EXCEEDED', `每个成员最多 ${DASHBOARD_MAX} 个仪表盘`)
    await assertUniqueName(this.prisma, 'dashboard', { tenantId: context.tenantId, ownerId: context.userId, name: body.name, folderId: body.folderId ?? null }, '仪表盘')
    const layout = this.layoutOrEmpty(body.layout, new Set())
    try {
      const row = await this.prisma.dashboard.create({
        data: {
          tenantId: context.tenantId,
          ownerId: context.userId,
          folderId: body.folderId ?? null,
          name: body.name,
          shared: body.shared === true,
          refreshMinutes: body.refreshMinutes ?? null,
          layout: layout as unknown as Prisma.InputJsonValue,
          version: 1,
        },
      })
      if (req.params) req.params.id = row.id
      return cardOf(row, context.userId, context.permissions)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '同一位置已经有同名仪表盘')
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, raw: unknown) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    if (raw && typeof raw === 'object' && (raw as { shared?: unknown }).shared === true) await this.context.authorize(req, DASHBOARD_SHARE)
    const body = DashboardBodySchema.parse(raw)
    if (!body.version) throw appError('VALIDATION_FAILED', '更新必须带上当前看到的版本号 version', { fieldErrors: { version: ['必须是不小于 1 的整数'] } })
    const current = await this.prisma.dashboard.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!current || (current.ownerId !== context.userId && !current.shared)) throw appError('RESOURCE_NOT_FOUND', '仪表盘不存在')
    if (current.ownerId !== context.userId) throw appError('TENANT_ACCESS_DENIED', '只有创建人可以修改仪表盘')
    if (body.shared === true && !current.shared) await this.context.authorize(req, DASHBOARD_SHARE)
    const folderId = body.folderId === undefined ? current.folderId : body.folderId
    await this.assertFolder(context.tenantId, context.userId, folderId)
    await assertUniqueName(this.prisma, 'dashboard', { tenantId: context.tenantId, ownerId: context.userId, name: body.name, folderId, selfId: id }, '仪表盘')
    const widgets = await this.prisma.dashboardWidget.findMany({ where: { tenantId: context.tenantId, dashboardId: id }, select: { id: true } })
    const layout = body.layout ? this.layoutOrEmpty(body.layout, new Set(widgets.map(widget => widget.id))) : (parseLayout(current.layout) ?? emptyLayout())
    try {
      const row = await updateWithVersion(
        this.prisma.dashboard,
        { id, tenantId: context.tenantId },
        body.version,
        {
          name: body.name,
          folderId,
          shared: body.shared === undefined ? current.shared : body.shared,
          refreshMinutes: body.refreshMinutes === undefined ? current.refreshMinutes : body.refreshMinutes,
          layout: layout as unknown as Prisma.InputJsonValue,
        },
        { label: '仪表盘' },
      )
      return cardOf(row, context.userId, context.permissions)
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '同一位置已经有同名仪表盘')
      throw error
    }
  }

  async remove(req: RequestWithContext, id: string) {
    const context = await this.context.authorize(req, DASHBOARD_WRITE)
    const result = await this.prisma.dashboard.deleteMany({ where: { id, tenantId: context.tenantId, ownerId: context.userId } })
    if (result.count === 0) throw appError('RESOURCE_NOT_FOUND', '仪表盘不存在')
    return { id }
  }

  private async assertFolder(tenantId: string, ownerId: string, folderId: string | null) {
    if (!folderId) return
    const folder = await this.prisma.dashboardFolder.findFirst({ where: { id: folderId, tenantId, ownerId } })
    if (!folder) throw appError('VALIDATION_FAILED', '文件夹不存在', { fieldErrors: { folderId: ['文件夹不存在'] } })
  }

  private layoutOrEmpty(value: unknown, widgetIds: Set<string>): DashboardLayout {
    const layout = parseLayout(value) ?? emptyLayout()
    if (value && !parseLayout(value)) throw appError('VALIDATION_FAILED', '布局不合法', { fieldErrors: { layout: ['组件位置超出网格或有重复'] } })
    if (layout.items.some(item => !widgetIds.has(item.widgetId)) || layout.items.length !== widgetIds.size) {
      throw appError('VALIDATION_FAILED', '布局必须正好包含当前的全部组件', { fieldErrors: { layout: ['组件与布局不一致'] } })
    }
    return layout
  }
}
