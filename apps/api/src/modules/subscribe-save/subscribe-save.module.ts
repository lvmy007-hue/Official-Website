import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { SubscribeSaveAccessService } from './subscribe-save-access.service'
import { SubscribeSaveListsService } from './subscribe-save-lists.service'
import { SubscribeSaveOverviewService } from './subscribe-save-overview.service'
import { SubscribeSaveController } from './subscribe-save.controller'

// 订阅省（P4-06）：只读。数据来自 P2a-07 的同步器（SubscribeSaveMetric、SubscribeSaveOffer），补货模块读同一批表做需求预测。
@Module({
  imports: [AuthModule],
  controllers: [SubscribeSaveController],
  providers: [SubscribeSaveAccessService, SubscribeSaveOverviewService, SubscribeSaveListsService],
})
export class SubscribeSaveModule {}
