import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { APPROVAL_DECISION_ACTION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ApprovalsDecisionService } from './approvals-decision.service'
import { ApprovalsReadService } from './approvals-read.service'

// 审批收件箱（P6-27，16 章第 1 节；freeze/api.md /approvals*）：查看只需要登录；处理时沿用各单据原模块的审批权限与再次验证身份。
@UseGuards(AuthGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly reads: ApprovalsReadService,
    private readonly decisions: ApprovalsDecisionService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.list(req, query), req)
  }

  // 权限与再次验证身份由被转发的原服务判断（按单据类型不同），审计由原服务在事务内写入；这里不声明固定权限
  @Write({ action: APPROVAL_DECISION_ACTION, resourceType: 'ApprovalRequest' })
  @HttpCode(200)
  @Post(':id/decision')
  async decide(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.decisions.decide(req, id, body), req)
  }
}
