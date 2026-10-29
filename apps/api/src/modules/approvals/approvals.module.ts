import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { FinancePolicyModule } from '../finance-policy'
import { MetricVersionsModule } from '../metric-versions'
import { PeriodsModule } from '../periods'
import { ApprovalsController } from './approvals.controller'
import { ApprovalsDecisionService } from './approvals-decision.service'
import { ApprovalsReadService } from './approvals-read.service'

// 审批收件箱（P6-27）：列表与处理。登记与回写在 approval-registry 模块（被三个原模块引用），这里再引用原模块的审批服务，两个方向分开才不会循环依赖。
@Module({
  imports: [AuthModule, FinancePolicyModule, MetricVersionsModule, PeriodsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsReadService, ApprovalsDecisionService],
})
export class ApprovalsModule {}
