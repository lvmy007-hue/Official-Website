import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common'
import { FINANCE_POLICY_STEP_UP, FINANCE_POLICY_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { FinancePolicyReadService } from './finance-policy-read.service'
import { FinancePolicyWriteService } from './finance-policy-write.service'

// 财务口径设置（P2b-15，09 章 9.12；freeze/api.md /settings/finance-policy*）。提交与审批都要再次验证身份（12 章 12.9）。
@UseGuards(AuthGuard)
@Controller('settings/finance-policy')
export class FinancePolicyController {
  constructor(
    private readonly reads: FinancePolicyReadService,
    private readonly writes: FinancePolicyWriteService,
  ) {}

  @Get()
  async get(@Req() req: RequestWithContext) {
    return ok(await this.reads.get(req), req)
  }

  @Write({ action: 'FINANCE_POLICY_SUBMITTED', resourceType: 'FinancePolicyVersion', permission: FINANCE_POLICY_WRITE, stepUp: FINANCE_POLICY_STEP_UP })
  @Put()
  async submit(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.submit(req, body), req)
  }

  @Write({ action: 'FINANCE_POLICY_APPROVED', resourceType: 'FinancePolicyVersion', permission: FINANCE_POLICY_WRITE, stepUp: FINANCE_POLICY_STEP_UP })
  @Post(':version/approve')
  async approve(@Req() req: RequestWithContext, @Param('version') version: string, @Body() body: unknown) {
    return ok(await this.writes.decide(req, version, body), req)
  }
}
