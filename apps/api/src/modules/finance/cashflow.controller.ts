import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common'
import { CASHFLOW_CONFIRM } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CashflowFunnelService } from './cashflow-funnel.service'
import { CashflowService } from './cashflow.service'
import { DisbursementsService } from './disbursements.service'

// 回款与现金流（P2b-08，07 章 7.8；freeze/api.md /finance/cashflow、/finance/disbursements/confirm）。
// 读：余额、递延与释放、打款预测、按周现金流预测、到账核对，一次返回；写：到账手工登记（一张结算单一条，改正带版本号，写审计）。
@UseGuards(AuthGuard)
@Controller('finance')
export class CashflowController {
  constructor(
    private readonly cashflow: CashflowService,
    private readonly disbursements: DisbursementsService,
    private readonly funnel: CashflowFunnelService,
  ) {}

  // 回款增强（P6-20）：回款率、未退还预留金、入账到应收的漏斗。
  @Get('cashflow/funnel')
  async readFunnel(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.funnel.funnel(req, query), req)
  }

  @Get('cashflow')
  async read(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.cashflow.cashflow(req, query), req)
  }

  @Write({ action: 'DISBURSEMENT_CONFIRMED', resourceType: 'Disbursement', permission: CASHFLOW_CONFIRM })
  @Post('disbursements/confirm')
  async confirm(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.disbursements.confirm(req, body), req)
  }
}
