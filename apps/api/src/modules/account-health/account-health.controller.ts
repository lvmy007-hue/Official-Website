import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common'
import { ACCOUNT_HEALTH_ACTIONS, ACCOUNT_HEALTH_HANDLE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AccountHealthOverviewService } from './account-health-overview.service'
import { PolicyIssuesDetailService } from './policy-issues-detail.service'
import { PolicyIssuesListService } from './policy-issues-list.service'
import { PolicyIssuesWriteService } from './policy-issues-write.service'

// 账户健康（P5-02；09 章 9.2；freeze/api.md /account-health*）。静态路径 issues 必须写在前面。
// 数据来自卖家表现报告（每日一次），只读；写入只有“处理政策问题”（负责人、处理状态、备注、关联案件编号），只改本系统的处理信息，不调用亚马逊。
@UseGuards(AuthGuard)
@Controller('account-health')
export class AccountHealthController {
  constructor(
    private readonly overview: AccountHealthOverviewService,
    private readonly issues: PolicyIssuesListService,
    private readonly details: PolicyIssuesDetailService,
    private readonly writes: PolicyIssuesWriteService,
  ) {}

  @Get()
  async index(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.overview.overview(req, query), req)
  }

  @Get('issues')
  async listIssues(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.issues.list(req, query), req)
  }

  @Get('issues/:id')
  async issue(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.details.detail(req, id), req)
  }

  @Write({ action: ACCOUNT_HEALTH_ACTIONS.issueUpdated, resourceType: 'PolicyIssue', permission: ACCOUNT_HEALTH_HANDLE })
  @Patch('issues/:id')
  async updateIssue(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }
}
