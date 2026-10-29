import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { CustomReportsModule } from '../custom-reports'
import { DashboardFolderService } from './dashboard-folder.service'
import { DashboardWidgetService } from './dashboard-widget.service'
import { DashboardService } from './dashboard.service'
import { DashboardsController } from './dashboards.controller'

@Module({
  imports: [AuthModule, CustomReportsModule],
  controllers: [DashboardsController],
  providers: [DashboardFolderService, DashboardService, DashboardWidgetService],
})
export class DashboardsModule {}
