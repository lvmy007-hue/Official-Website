import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ConnectionsModule } from '../connections'
import { ReportsController } from './reports.controller'
import { ReportsDetailService } from './reports-detail.service'
import { ReportsListService } from './reports-list.service'
import { ReportsService } from './reports.service'

@Module({
  imports: [AuthModule, ConnectionsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsListService, ReportsDetailService],
  exports: [ReportsService],
})
export class ReportsModule {}
