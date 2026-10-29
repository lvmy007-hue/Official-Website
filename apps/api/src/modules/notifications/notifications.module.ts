import { Module, OnModuleInit } from '@nestjs/common'
import { AlertService } from '../../platform/observability'
import { AuthModule } from '../auth'
import { AlertNotificationSink } from './alert-sink'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'
import { NotifyService } from './notify.service'
import { SubscriptionCenterService } from './subscription-center.service'
import { SubscriptionsService } from './subscriptions.service'

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotifyService, NotificationsService, SubscriptionsService, SubscriptionCenterService],
  exports: [NotifyService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly alerts: AlertService,
    private readonly notify: NotifyService,
  ) {}

  // 站内告警的落地：带企业编号的告警写入有预警管理权限的成员的消息中心
  onModuleInit() {
    this.alerts.registerSink(new AlertNotificationSink(this.notify))
  }
}
