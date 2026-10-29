import { Module } from '@nestjs/common'
import { ApprovalRegistryModule } from '../approval-registry'
import { AuthModule } from '../auth'
import { FinancePolicyController } from './finance-policy.controller'
import { FinancePolicyReadService } from './finance-policy-read.service'
import { FinancePolicyWriteService } from './finance-policy-write.service'

// 财务口径设置（P2b-15，09 章 9.12）：口径版本、提交与审批。P6-27：提交与审批同步登记到审批收件箱；收件箱模块通过导出的写服务代为审批。
@Module({
  imports: [AuthModule, ApprovalRegistryModule],
  controllers: [FinancePolicyController],
  providers: [FinancePolicyReadService, FinancePolicyWriteService],
  exports: [FinancePolicyWriteService],
})
export class FinancePolicyModule {}
