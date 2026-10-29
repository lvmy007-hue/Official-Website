import { Module } from '@nestjs/common'
import { AdsModule } from '../ads'
import { AnalyticsModule } from '../analytics'
import { AuthModule } from '../auth'
import { InventoryModule } from '../inventory'
import { ProfitModule } from '../profit'
import { ReturnsModule } from '../returns'
import { CustomMetricService } from './custom-metric.service'
import { CustomReportScheduleService } from './custom-report-schedule.service'
import { CustomReportService } from './custom-report.service'
import { CustomReportsController } from './custom-reports.controller'
import { ReportAdapters } from './report-adapters'
import { ReportQueryService } from './report-query.service'

@Module({
  imports: [AuthModule, AnalyticsModule, ProfitModule, AdsModule, InventoryModule, ReturnsModule],
  controllers: [CustomReportsController],
  providers: [CustomMetricService, CustomReportService, ReportQueryService, ReportAdapters, CustomReportScheduleService],
  exports: [ReportQueryService],
})
export class CustomReportsModule {}
