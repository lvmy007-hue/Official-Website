import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { WriteExempt } from '../../platform/write'
import { AuthGuard } from '../auth'
import { TelemetryService } from './telemetry.service'

// 前端性能埋点上报（P1-09）：仅需登录，内容只有指标名、耗时、路由模板。
@UseGuards(AuthGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @WriteExempt('前端性能埋点：只写入进程内指标，不改动任何业务数据，无需审计与幂等；字段严格校验且不含个人信息')
  @Post('web-vitals')
  report(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok({ accepted: this.telemetry.report(body) }, req)
  }
}
