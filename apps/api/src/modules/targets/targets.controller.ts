import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { TargetsQueryService } from './targets-query.service'
import { TargetsWriteService } from './targets-write.service'

// 目标与预算（P2a-04，04 章 4.4）：目标网格（含达成进度、预测达成）、变更历史、编辑目标。
// 查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
@UseGuards(AuthGuard)
@Controller('targets')
export class TargetsController {
  constructor(
    private readonly query: TargetsQueryService,
    private readonly write: TargetsWriteService,
  ) {}

  @Get()
  async grid(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.query.grid(req, query), req)
  }

  @Get('history')
  async history(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.query.history(req, query), req)
  }

  @Write({ action: 'BUSINESS_TARGET_UPSERTED', resourceType: 'BusinessTarget', permission: 'targets.write' })
  @Put()
  async upsert(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.write.upsert(req, body), req)
  }
}
