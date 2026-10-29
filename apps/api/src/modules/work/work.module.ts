import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { NotificationsModule } from '../notifications'
import { SettingsModule } from '../settings'
import { WorkActionsService } from './work-actions.service'
import { WorkController } from './work.controller'
import { WorkQueryService } from './work-query.service'

@Module({
  imports: [AuthModule, NotificationsModule, SettingsModule],
  controllers: [WorkController],
  providers: [WorkQueryService, WorkActionsService],
  exports: [WorkQueryService],
})
export class WorkModule {}
