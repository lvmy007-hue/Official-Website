import { Module } from '@nestjs/common'
import { ApprovalRegistryModule } from '../approval-registry'
import { AuthModule } from '../auth'
import { MetricVersionsDiffService } from './metric-versions-diff.service'
import { MetricVersionsReadService } from './metric-versions-read.service'
import { MetricVersionsWriteService } from './metric-versions-write.service'
import { BusinessRulesController, MetricVersionsController, ProfitFormulaController } from './metric-versions.controller'

// 口径版本（P6-31）：利润公式与业务口径的提交、审批、读取与差异报告。其他模块读取生效版本用 platform/metric-config。
// P6-27：提交与审批同步登记到审批收件箱；收件箱模块通过导出的写服务代为审批。
@Module({
  imports: [AuthModule, ApprovalRegistryModule],
  controllers: [ProfitFormulaController, BusinessRulesController, MetricVersionsController],
  providers: [MetricVersionsReadService, MetricVersionsWriteService, MetricVersionsDiffService],
  exports: [MetricVersionsWriteService],
})
export class MetricVersionsModule {}
