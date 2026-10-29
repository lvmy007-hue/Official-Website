import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { SettingsModule } from '../settings'
import { CashflowController } from './cashflow.controller'
import { CashflowFunnelService } from './cashflow-funnel.service'
import { CashflowService } from './cashflow.service'
import { DisbursementsService } from './disbursements.service'
import { FeeAuditController } from './fee-audit.controller'
import { FeeAuditConvertService } from './fee-audit-convert.service'
import { FeeAuditListService } from './fee-audit-list.service'
import { FeeEventsController } from './fee-events.controller'
import { FeeEventsDetailService } from './fee-events-detail.service'
import { FeeEventsListService } from './fee-events-list.service'
import { FeeEventsSummaryService } from './fee-events-summary.service'
import { FeeEventsWriteService } from './fee-events-write.service'
import { SalesTaxController } from './sales-tax.controller'
import { SalesTaxService } from './sales-tax.service'
import { SettlementsController } from './settlements.controller'
import { SettlementsDetailService } from './settlements-detail.service'
import { SettlementsLinesService } from './settlements-lines.service'
import { SettlementsListService } from './settlements-list.service'

// 财务：费用事件在 /finance/events*，费用核查在 /finance/fee-audit*，结算在 /settlements*，
// 回款与现金流在 /finance/cashflow 与 /finance/disbursements/confirm。旧的 /fba/fees 与 /fba/settlements 已删除。
// 销售税（P2b-12）在 /finance/sales-tax。
@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [FeeEventsController, FeeAuditController, SettlementsController, CashflowController, SalesTaxController],
  providers: [
    SalesTaxService,
    CashflowService,
    CashflowFunnelService,
    DisbursementsService,
    FeeEventsListService,
    FeeEventsSummaryService,
    FeeEventsDetailService,
    FeeEventsWriteService,
    FeeAuditListService,
    FeeAuditConvertService,
    SettlementsListService,
    SettlementsDetailService,
    SettlementsLinesService,
  ],
})
export class FinanceModule {}
