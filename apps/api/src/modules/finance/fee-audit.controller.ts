import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { FEE_AUDIT_CONVERT } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { FeeAuditConvertService } from './fee-audit-convert.service'
import { FeeAuditListService } from './fee-audit-list.service'

// 费用核查（P2b-06，07 章 7.6；freeze/api.md /finance/fee-audit*）：核查结果列表（附各类汇总与近期尺寸分段变化）、一键转为赔付机会。
// 冻结表里的 4 类核查结果都由后台任务算出并按核查日保存，接口只读；转赔付机会是唯一的写入口。
@UseGuards(AuthGuard)
@Controller('finance/fee-audit')
export class FeeAuditController {
  constructor(
    private readonly lists: FeeAuditListService,
    private readonly converts: FeeAuditConvertService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Write({ action: 'FEE_AUDIT_CONVERTED', resourceType: 'FeeAudit', permission: FEE_AUDIT_CONVERT })
  @Post(':id/reimbursement')
  async convert(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.converts.convert(req, id), req)
  }
}
