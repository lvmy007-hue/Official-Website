import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { FORECAST_ACTIONS, FORECAST_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ReplenishmentForecastService } from './replenishment-forecast.service'

// 人工预测规则接口（P6-09）：读取要 replenishment.read，写入要 replenishment.policy.write（在服务里先于参数校验检查，并要求数据范围是全部店铺）。查询参数类型必须直接写 Record<string, string>。
@UseGuards(AuthGuard)
@Controller('replenishment/forecast-overrides')
export class ReplenishmentForecastController {
  constructor(private readonly rules: ReplenishmentForecastService) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.rules.list(req, query), req)
  }

  @Write({ action: FORECAST_ACTIONS.created, resourceType: 'ForecastOverride', permission: FORECAST_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.rules.create(req, body), req)
  }

  @Write({ action: FORECAST_ACTIONS.updated, resourceType: 'ForecastOverride', permission: FORECAST_WRITE })
  @Put(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.rules.update(req, id, body), req)
  }

  @Write({ action: FORECAST_ACTIONS.deleted, resourceType: 'ForecastOverride', permission: FORECAST_WRITE })
  @Delete(':id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.rules.remove(req, id), req)
  }
}
