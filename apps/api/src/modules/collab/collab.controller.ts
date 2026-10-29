import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CommentsService } from './comments.service'
import { TimelineService } from './timeline.service'
import { ViewsService } from './views.service'
import { WatchesService } from './watches.service'

// 协作接口（P1-28-7/9/10）：保存视图、评论、关注、运营日志（事件时间线在 P6-06 并入 modules/events）。
// 读接口随对象读权限（服务内校验）；写接口需要 collab.write，视图属于所有成员的基础能力（view.manage）。
@UseGuards(AuthGuard)
@Controller()
export class CollabController {
  constructor(
    private readonly views: ViewsService,
    private readonly comments: CommentsService,
    private readonly watches: WatchesService,
    private readonly timeline: TimelineService,
  ) {}

  @Get('views')
  async listViews(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.views.list(req, query), req)
  }

  @Write({ action: 'SAVED_VIEW_CREATED', resourceType: 'SavedView', permission: 'view.manage' })
  @Post('views')
  async createView(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.views.create(req, body), req))
  }

  @Write({ action: 'SAVED_VIEW_UPDATED', resourceType: 'SavedView', permission: 'view.manage' })
  @Patch('views/:id')
  async updateView(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.views.update(req, id, body), req)
  }

  @Write({ action: 'SAVED_VIEW_DELETED', resourceType: 'SavedView', permission: 'view.manage' })
  @Delete('views/:id')
  async removeView(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.views.remove(req, id), req)
  }

  @Get('comments')
  async listComments(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.comments.list(req, query), req)
  }

  @Write({ action: 'COMMENT_CREATED', resourceType: 'Comment', permission: 'collab.write' })
  @Post('comments')
  async createComment(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.comments.create(req, body), req))
  }

  @Write({ action: 'WATCH_ADDED', resourceType: 'Watch', permission: 'collab.write' })
  @HttpCode(200)
  @Post('watches')
  async addWatch(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.watches.add(req, body), req)
  }

  @Write({ action: 'WATCH_REMOVED', resourceType: 'Watch', permission: 'collab.write' })
  @Delete('watches/:id')
  async removeWatch(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.watches.remove(req, id), req)
  }

  @Get('operation-logs')
  async logs(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.timeline.logs(req, query), req)
  }

  @Write({ action: 'OPERATION_LOG_CREATED', resourceType: 'OperationLog', permission: 'collab.write' })
  @Post('operation-logs')
  async createLog(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(201).json(ok(await this.timeline.createLog(req, body), req))
  }
}
