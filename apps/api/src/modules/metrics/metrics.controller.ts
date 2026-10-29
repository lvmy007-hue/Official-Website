import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard, ContextService } from '../auth'
import { MetricsService } from './metrics.service'

// 指标口径：登录成员即可查看（口径是冻结的公共字典，不含企业数据）。
@UseGuards(AuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly context: ContextService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('definitions')
  async definitions(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    const context = await this.context.resolve(req)
    return ok(await this.metrics.definitions(context.tenantId, query), req)
  }
}
