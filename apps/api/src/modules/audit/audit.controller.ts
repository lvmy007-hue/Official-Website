import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AuditDetailService } from './audit-detail.service'
import { AuditListService } from './audit-list.service'
import { AuditPiiService } from './audit-pii.service'

// 审计中心（P5-09，09 章 9.11；freeze/api.md /audit*）：全部是读取接口。静态路径必须写在 :id 之前，否则会被当成审计编号。
@UseGuards(AuthGuard)
@Controller('audit')
export class AuditController {
  constructor(
    private readonly list: AuditListService,
    private readonly detail: AuditDetailService,
    private readonly pii: AuditPiiService,
  ) {}

  @Get()
  async events(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  @Get('options')
  async options(@Req() req: RequestWithContext) {
    return ok(await this.list.options(req), req)
  }

  @Get('pii-views')
  async piiViews(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.pii.list(req, query), req)
  }

  @Get(':id')
  async event(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.detail(req, id), req)
  }
}
