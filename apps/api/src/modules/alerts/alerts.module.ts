import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { NotificationsModule } from '../notifications'
import { SettingsModule } from '../settings'
import { AlertRulePreviewService } from './alert-rule-preview.service'
import { AlertRulesQueryService } from './alert-rules-query.service'
import { AlertRulesWriteService } from './alert-rules-write.service'
import { AlertsActionsService } from './alerts-actions.service'
import { AlertsController } from './alerts.controller'
import { AlertsEntityService } from './alerts-entity.service'
import { AlertsDetailService } from './alerts-detail.service'
import { AlertsListService } from './alerts-list.service'
import { AlertsReadService } from './alerts-read.service'
import { AlertTemplatesService } from './alert-templates.service'

@Module({
  imports: [AuthModule, NotificationsModule, SettingsModule],
  controllers: [AlertsController],
  providers: [
    AlertsListService,
    AlertsDetailService,
    AlertsActionsService,
    AlertRulesQueryService,
    AlertRulesWriteService,
    AlertRulePreviewService,
    AlertsReadService,
    AlertTemplatesService,
    AlertsEntityService,
  ],
  exports: [AlertsEntityService],
})
export class AlertsModule {}
