import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ExportsModule } from '../exports'
import { ProcurementModule } from '../procurement'
import { SettingsModule } from '../settings'
import { SupportModule } from '../support'
import { ReimbursementsCaseService } from './reimbursements-case.service'
import { ReimbursementsDetailService } from './reimbursements-detail.service'
import { ReimbursementsEvidenceService } from './reimbursements-evidence.service'
import { ReimbursementsListService } from './reimbursements-list.service'
import { ReimbursementsStatsService } from './reimbursements-stats.service'
import { ReimbursementsController } from './reimbursements.controller'

// 赔付中心（P2b-03）：证据附件复用采购模块的签名直传，证据包走导出中心，时限读企业设置，关联的支持案件读支持案件模块。
@Module({
  imports: [AuthModule, ExportsModule, ProcurementModule, SettingsModule, SupportModule],
  controllers: [ReimbursementsController],
  providers: [ReimbursementsListService, ReimbursementsDetailService, ReimbursementsCaseService, ReimbursementsEvidenceService, ReimbursementsStatsService],
})
export class ReimbursementsModule {}
