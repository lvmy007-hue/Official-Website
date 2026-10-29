import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { WorkActionsService } from './work-actions.service'
import { WorkQueryService } from './work-query.service'

@UseGuards(AuthGuard)
@Controller('work-items')
export class WorkController {
  constructor(
    private readonly query: WorkQueryService,
    private readonly actions: WorkActionsService,
  ) {}

  // 列表与详情：登录成员看与自己相关的；scope=all 需要 workitem.read（服务内校验）
  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.query.list(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.query.detail(req, id), req)
  }

  @Write({ action: 'WORK_ITEM_CREATED', resourceType: 'WorkItem', permission: 'workitem.assign' })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.actions.create(req, body), req))
  }

  @Write({ action: 'WORK_ITEM_BATCH', resourceType: 'WorkItem', permission: 'workitem.handle' })
  @Patch()
  async batch(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.actions.batch(req, body), req)
  }

  @Write({ action: 'WORK_ITEM_ASSIGNED', resourceType: 'WorkItem', permission: 'workitem.assign' })
  @HttpCode(200)
  @Post(':id/assign')
  async assign(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.assign(req, id, body), req)
  }

  @Write({ action: 'WORK_ITEM_ACKED', resourceType: 'WorkItem', permission: 'workitem.handle' })
  @HttpCode(200)
  @Post(':id/ack')
  async ack(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.ack(req, id, body), req)
  }

  @Write({ action: 'WORK_ITEM_IGNORED', resourceType: 'WorkItem', permission: 'workitem.handle' })
  @HttpCode(200)
  @Post(':id/ignore')
  async ignore(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.ignore(req, id, body), req)
  }

  @Write({ action: 'WORK_ITEM_CLOSED', resourceType: 'WorkItem', permission: 'workitem.handle' })
  @HttpCode(200)
  @Post(':id/close')
  async close(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.close(req, id, body), req)
  }

  @Write({ action: 'WORK_ITEM_DEFERRED', resourceType: 'WorkItem', permission: 'workitem.handle' })
  @HttpCode(200)
  @Post(':id/defer')
  async defer(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.actions.defer(req, id, body), req)
  }
}
