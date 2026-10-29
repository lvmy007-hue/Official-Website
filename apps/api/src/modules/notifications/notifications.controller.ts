import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { NotificationsService } from './notifications.service'
import { SubscriptionCenterService } from './subscription-center.service'
import { SubscriptionsService } from './subscriptions.service'

@UseGuards(AuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly center: SubscriptionCenterService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.notifications.list(req, query), req)
  }

  @Get('unread-count')
  async unread(@Req() req: RequestWithContext) {
    return ok(await this.notifications.unreadCount(req), req)
  }

  // 已读标记只改本人通知的阅读状态，不属于业务数据变更，不写通用审计（audit:false）；仍要求幂等键
  @Write({ action: 'NOTIFICATION_MARKED_READ', resourceType: 'Notification', audit: false })
  @HttpCode(200)
  @Post('read')
  async markRead(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.notifications.markRead(req, body), req)
  }

  @Get('subscriptions')
  async listSubscriptions(@Req() req: RequestWithContext) {
    return ok(await this.center.list(req), req)
  }

  @Write({ action: 'NOTIFICATION_SUBSCRIPTION_REQUESTED', resourceType: 'NotificationSubscription', permission: 'notifications.manage', audit: false })
  @Post('subscriptions')
  async createSubscription(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    return response.status(202).json(ok(await this.subscriptions.create(req, body), req))
  }

  @Write({ action: 'NOTIFICATION_SUBSCRIPTION_UPDATED', resourceType: 'NotificationSubscription', permission: 'notifications.manage', audit: false })
  @Patch('subscriptions/:id')
  async updateSubscription(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.subscriptions.update(req, id, body), req)
  }

  @Write({ action: 'NOTIFICATION_SUBSCRIPTION_DELETED', resourceType: 'NotificationSubscription', permission: 'notifications.manage', audit: false })
  @Delete('subscriptions/:id')
  async removeSubscription(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.subscriptions.remove(req, id), req)
  }

  @Write({ action: 'NOTIFICATION_EVENTS_REPLAYED', resourceType: 'NotificationSubscription', permission: 'notifications.manage', audit: false })
  @HttpCode(202)
  @Post('subscriptions/:id/replay')
  async replay(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.subscriptions.replay(req, id, body), req)
  }
}
