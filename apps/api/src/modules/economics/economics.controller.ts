import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { EconomicsCompareService } from './economics-compare.service'
import { EconomicsPreviewService } from './economics-preview.service'
import { EconomicsSimulateService } from './economics-simulate.service'

// 官方经济数据对账（P2b-11，07 章 7.10；freeze/api.md /finance/economics/*）。查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 双源核对与费用预览只读；情景模拟向亚马逊数据中心提交查询（建模拟记录与后台任务），结果异步返回，用 simulations/:id 轮询。
@UseGuards(AuthGuard)
@Controller('finance/economics')
export class EconomicsController {
  constructor(
    private readonly compare: EconomicsCompareService,
    private readonly preview: EconomicsPreviewService,
    private readonly simulation: EconomicsSimulateService,
  ) {}

  @Get('compare')
  async readCompare(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.compare.compare(req, query), req)
  }

  @Get('preview')
  async readPreview(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.preview.preview(req, query), req)
  }

  @Write({ action: 'ECONOMICS_SIMULATED', resourceType: 'EconomicsSimulationRun', permission: 'finance.read' })
  @Post('simulate')
  async simulate(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.simulation.simulate(req, body), req)
  }

  @Get('simulations/:id')
  async simulationRun(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.simulation.run(req, id), req)
  }
}
