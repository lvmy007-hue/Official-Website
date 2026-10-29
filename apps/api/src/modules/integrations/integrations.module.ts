import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { NotificationsModule } from '../notifications'
import { IntegrationsController } from './integrations.controller'
import { IntegrationsService } from './integrations.service'
import { SwitchActionsService } from './switch-actions.service'
import { SwitchOutcomeService } from './switch-outcome.service'

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, SwitchActionsService, SwitchOutcomeService],
  exports: [SwitchOutcomeService],
})
export class IntegrationsModule {}
