import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ADS_READ, DAYPARTING_CREATED_ACTION, DAYPARTING_UPDATED_ACTION, DAYPARTING_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AdsDaypartingService } from './ads-dayparting.service'
import { AdsDaypartingSimulateService } from './ads-dayparting-simulate.service'
import { AdsDaypartingWriteService } from './ads-dayparting-write.service'

// 分时策略（P3-12，08 章 8.9；freeze/api.md /ads/dayparting*）：热力图与策略列表（ads.read）、创建与修改（ads.rule.write，只改本系统里的策略）、效果模拟（只读）。
// 策略的调度执行写亚马逊，受写入开关“分时策略执行”控制，随 P3-17 接入；本包保存的策略不会改变亚马逊账户。
@UseGuards(AuthGuard)
@Controller('ads')
export class AdsDaypartingController {
  constructor(
    private readonly lists: AdsDaypartingService,
    private readonly writes: AdsDaypartingWriteService,
    private readonly simulates: AdsDaypartingSimulateService,
  ) {}

  @Get('dayparting')
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  @Write({ action: DAYPARTING_CREATED_ACTION, resourceType: 'DaypartingStrategy', permission: DAYPARTING_WRITE })
  @Post('dayparting')
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Write({ action: DAYPARTING_UPDATED_ACTION, resourceType: 'DaypartingStrategy', permission: DAYPARTING_WRITE })
  @Patch('dayparting/:id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  // 模拟用 POST 是冻结里的约定；它只读、不改任何数据，所以不写审计（但仍要幂等键，和其他 POST 一致）。
  @Write({ action: 'ADS_DAYPARTING_SIMULATED', resourceType: 'DaypartingStrategy', permission: ADS_READ, audit: false })
  @HttpCode(200)
  @Post('dayparting/:id/simulate')
  async simulate(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.simulates.simulate(req, id), req)
  }
}
