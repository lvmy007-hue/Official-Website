import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { GridViewsService } from './grid-views.service'

// 表格视图接口（P6-03）：个人视图是基础权限 view.manage；共享给团队、设置团队默认另需 grid.view.share（在服务里按范围判断）。
@UseGuards(AuthGuard)
@Controller('grid-views')
export class GridViewsController {
  constructor(private readonly views: GridViewsService) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.views.list(req, query), req)
  }

  @Write({ action: 'GRID_VIEW_CREATED', resourceType: 'GridView', permission: 'view.manage' })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.views.create(req, body), req))
  }

  @Write({ action: 'GRID_VIEW_UPDATED', resourceType: 'GridView', permission: 'view.manage' })
  @Put(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.views.update(req, id, body), req)
  }

  @Write({ action: 'GRID_VIEW_DELETED', resourceType: 'GridView', permission: 'view.manage' })
  @Delete(':id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.views.remove(req, id), req)
  }

  @Write({ action: 'GRID_VIEW_DEFAULT_SET', resourceType: 'GridView', permission: 'view.manage' })
  @HttpCode(200)
  @Post(':id/default')
  async setDefault(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.views.setDefault(req, id), req)
  }
}
