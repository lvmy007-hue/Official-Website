import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { NotificationsModule } from '../notifications'
import { SupportModule } from '../support'
import { AccountHealthOverviewService } from './account-health-overview.service'
import { AccountHealthController } from './account-health.controller'
import { PolicyIssuesDetailService } from './policy-issues-detail.service'
import { PolicyIssuesListService } from './policy-issues-list.service'
import { PolicyIssuesWriteService } from './policy-issues-write.service'

// 账户健康（P5-02）：总览与政策合规问题。数据来自 P5-02 的卖家表现报告导入（AccountHealthSnapshot、PolicyIssue）；
// 预警（账户状态变化、指标未达标）由后台预警评估器读同一批快照生成。
@Module({
  imports: [AuthModule, NotificationsModule, SupportModule],
  controllers: [AccountHealthController],
  providers: [AccountHealthOverviewService, PolicyIssuesListService, PolicyIssuesDetailService, PolicyIssuesWriteService],
})
export class AccountHealthModule {}
