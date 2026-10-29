import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { DashboardFolderService } from './dashboard-folder.service'
import { DashboardWidgetService } from './dashboard-widget.service'
import { DashboardService } from './dashboard.service'

// 自定义仪表盘（P6-33）。folders 与 tree 必须写在 :id 之前。
@UseGuards(AuthGuard)
@Controller('dashboards')
export class DashboardsController {
  constructor(
    private readonly folders: DashboardFolderService,
    private readonly dashboards: DashboardService,
    private readonly widgets: DashboardWidgetService,
  ) {}

  @Get('tree')
  async tree(@Req() req: RequestWithContext) {
    return ok(await this.dashboards.tree(req), req)
  }

  @Write({ action: 'DASHBOARD_FOLDER_CREATED', resourceType: 'DashboardFolder', permission: 'dashboard.write' })
  @HttpCode(201)
  @Post('folders')
  async createFolder(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.folders.create(req, body), req)
  }

  @Write({ action: 'DASHBOARD_FOLDER_UPDATED', resourceType: 'DashboardFolder', permission: 'dashboard.write' })
  @Put('folders/:folderId')
  async updateFolder(@Req() req: RequestWithContext, @Param('folderId') folderId: string, @Body() body: unknown) {
    return ok(await this.folders.update(req, folderId, body), req)
  }

  @Write({ action: 'DASHBOARD_FOLDER_DELETED', resourceType: 'DashboardFolder', permission: 'dashboard.write' })
  @Delete('folders/:folderId')
  async removeFolder(@Req() req: RequestWithContext, @Param('folderId') folderId: string) {
    return ok(await this.folders.remove(req, folderId), req)
  }

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.dashboards.list(req, query), req)
  }

  @Write({ action: 'DASHBOARD_CREATED', resourceType: 'Dashboard', permission: 'dashboard.write' })
  @HttpCode(201)
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.dashboards.create(req, body), req)
  }

  @Get(':id/widgets')
  async widgetsOf(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.widgets.list(req, id), req)
  }

  @Write({ action: 'DASHBOARD_WIDGET_CREATED', resourceType: 'DashboardWidget', permission: 'dashboard.write' })
  @HttpCode(201)
  @Post(':id/widgets')
  async createWidget(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.widgets.create(req, id, body), req)
  }

  @Get(':id/widgets/:widgetId')
  async readWidget(@Req() req: RequestWithContext, @Param('id') id: string, @Param('widgetId') widgetId: string, @Query() query: Record<string, string>) {
    return ok(await this.widgets.read(req, id, widgetId, query), req)
  }

  @Write({ action: 'DASHBOARD_WIDGET_UPDATED', resourceType: 'DashboardWidget', permission: 'dashboard.write' })
  @Put(':id/widgets/:widgetId')
  async updateWidget(@Req() req: RequestWithContext, @Param('id') id: string, @Param('widgetId') widgetId: string, @Body() body: unknown) {
    return ok(await this.widgets.update(req, id, widgetId, body), req)
  }

  @Write({ action: 'DASHBOARD_WIDGET_DELETED', resourceType: 'DashboardWidget', permission: 'dashboard.write' })
  @Delete(':id/widgets/:widgetId')
  async removeWidget(@Req() req: RequestWithContext, @Param('id') id: string, @Param('widgetId') widgetId: string) {
    return ok(await this.widgets.remove(req, id, widgetId), req)
  }

  @Get(':id')
  async get(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.dashboards.get(req, id), req)
  }

  @Write({ action: 'DASHBOARD_UPDATED', resourceType: 'Dashboard', permission: 'dashboard.write' })
  @Put(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.dashboards.update(req, id, body), req)
  }

  @Write({ action: 'DASHBOARD_DELETED', resourceType: 'Dashboard', permission: 'dashboard.write' })
  @Delete(':id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.dashboards.remove(req, id), req)
  }
}
