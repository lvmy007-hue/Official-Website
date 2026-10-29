import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ConnectionsModule } from '../connections'
import { ReportsModule } from '../reports'
import { ParityService } from './parity.service'
import { SyncDetailService } from './sync-detail.service'
import { SyncListService } from './sync-list.service'
import { SyncMonitorService } from './sync-monitor.service'
import { SyncController } from './sync.controller'
import { SyncService } from './sync.service'

@Module({
  imports: [AuthModule, ConnectionsModule, ReportsModule],
  controllers: [SyncController],
  providers: [SyncService, ParityService, SyncListService, SyncDetailService, SyncMonitorService],
  exports: [SyncService],
})
export class SyncModule {}
