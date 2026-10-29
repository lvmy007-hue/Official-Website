import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ReturnsAccessService } from './returns-access.service'
import { ReturnsAnalysisService } from './returns-analysis.service'
import { ReturnsAnalysisContextService } from './returns-analysis-context'
import { ReturnsAnalysisController } from './returns-analysis.controller'
import { ReturnsAwaitingService } from './returns-awaiting.service'
import { ReturnsCohortService } from './returns-cohort.service'
import { ReturnsCrossMonthService } from './returns-cross-month.service'
import { ReturnsCycleService } from './returns-cycle.service'
import { ReturnsDetailService } from './returns-detail.service'
import { ReturnsListService } from './returns-list.service'
import { ReturnsMatrixService } from './returns-matrix.service'
import { ReturnsPiiSource } from './returns-pii-source'
import { ReturnsPageController } from './returns-page.controller'
import { ReturnsReasonMapService } from './returns-reason-map.service'
import { ReturnsSummaryService } from './returns-summary.service'

// 控制器顺序有意义：ReturnsAnalysisController 的静态路径（reason-map、analysis/*）要排在 ReturnsPageController 的 :id 之前
@Module({
  imports: [AuthModule],
  controllers: [ReturnsAnalysisController, ReturnsPageController],
  providers: [
    ReturnsAccessService,
    ReturnsListService,
    ReturnsDetailService,
    ReturnsAwaitingService,
    ReturnsAnalysisService,
    ReturnsAnalysisContextService,
    ReturnsReasonMapService,
    ReturnsSummaryService,
    ReturnsCycleService,
    ReturnsCrossMonthService,
    ReturnsCohortService,
    ReturnsMatrixService,
    ReturnsPiiSource,
  ],
  exports: [ReturnsPiiSource, ReturnsListService],
})
export class ReturnsModule {}
