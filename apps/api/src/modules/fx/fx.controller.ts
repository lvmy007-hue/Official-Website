import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { FxService } from './fx.service'
import { FxWriteService } from './fx-write.service'

@UseGuards(AuthGuard)
@Controller('settings/fx')
export class FxController {
  constructor(
    private readonly fx: FxService,
    private readonly writes: FxWriteService,
  ) {}

  @Get()
  async overview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.fx.overview(req, query), req)
  }

  // 手工覆盖汇率或选择来源：再次验证身份（fx.write），写审计（含原因）
  @Write({ action: 'FX_CHANGED', resourceType: 'FxRate', permission: 'settings.fx.write', stepUp: 'fx.write' })
  @HttpCode(200)
  @Post()
  async write(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.write(req, body), req)
  }

  @Write({ action: 'FX_CURRENCIES_CHANGED', resourceType: 'TenantSetting', permission: 'settings.fx.write' })
  @HttpCode(200)
  @Post('currencies')
  async currencies(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.setCurrencies(req, body), req)
  }

  @Write({ action: 'FX_FETCH_REQUESTED', resourceType: 'FxRate', permission: 'settings.fx.write' })
  @HttpCode(202)
  @Post('refresh')
  async refresh(@Req() req: RequestWithContext) {
    return ok(await this.writes.refresh(req), req)
  }

  @Write({ action: 'FX_OVERRIDE_REMOVED', resourceType: 'FxRate', permission: 'settings.fx.write', stepUp: 'fx.write' })
  @Delete('overrides/:id')
  async removeOverride(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.writes.removeOverride(req, id), req)
  }
}
