import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common'
import { RETURN_REASON_MAP_ACTION, RETURN_REASON_MAP_WRITE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ReturnsCohortService } from './returns-cohort.service'
import { ReturnsCrossMonthService } from './returns-cross-month.service'
import { ReturnsCycleService } from './returns-cycle.service'
import { ReturnsMatrixService } from './returns-matrix.service'
import { ReturnsReasonMapService } from './returns-reason-map.service'
import { ReturnsSummaryService } from './returns-summary.service'

// 退货分析与原因映射接口（P6-13）。读取要 returns.read；保存映射要 settings.write（在服务里先于参数校验检查）。
// 本控制器必须排在 ReturnsPageController 之前注册：静态路径（reason-map、analysis/*）要先于 returns/:id 匹配。
// 查询参数类型必须直接写 Record<string, string>（不能是类型别名），否则全局校验会把 query 当成未知类型拒绝。
@UseGuards(AuthGuard)
@Controller('returns')
export class ReturnsAnalysisController {
  constructor(
    private readonly summaryService: ReturnsSummaryService,
    private readonly cycleService: ReturnsCycleService,
    private readonly crossMonthService: ReturnsCrossMonthService,
    private readonly cohortService: ReturnsCohortService,
    private readonly matrixService: ReturnsMatrixService,
    private readonly reasonMap: ReturnsReasonMapService,
  ) {}

  @Get('reason-map')
  async reasonMapList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reasonMap.list(req, query), req)
  }

  @Write({ action: RETURN_REASON_MAP_ACTION, resourceType: 'ReturnReasonMap', permission: RETURN_REASON_MAP_WRITE })
  @Put('reason-map')
  async reasonMapSave(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.reasonMap.put(req, body), req)
  }

  @Get('analysis/summary')
  async summary(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.summaryService.summary(req, query), req)
  }

  @Get('analysis/cycle')
  async cycle(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.cycleService.cycle(req, query), req)
  }

  @Get('analysis/cross-month')
  async crossMonth(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.crossMonthService.crossMonth(req, query), req)
  }

  @Get('analysis/cohort')
  async cohort(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.cohortService.cohort(req, query), req)
  }

  @Get('analysis/disposition-matrix')
  async dispositionMatrix(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.matrixService.matrix(req, query), req)
  }
}
