import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { AuthGuard } from '../auth'
import { AllWarehousesService } from './all-warehouses.service'
import { MovementReportService } from './movement-report.service'

// 跨仓总览与进销存报表（P6-25）：只读，权限 inventory.read；范围参数（店铺、日期）在地址栏。
// 路由顺序：静态路径（all-warehouses、movement）必须在 InventoryDetailController 的 :id 之前注册，InventoryModule 里按此顺序列出。
// 查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
@UseGuards(AuthGuard)
@Controller('inventory')
export class InventoryReportsController {
  constructor(
    private readonly warehouses: AllWarehousesService,
    private readonly movement: MovementReportService,
  ) {}

  @Get('all-warehouses')
  async allWarehouses(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.warehouses.report(req, query), req)
  }

  @Get('movement')
  async movementReport(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.movement.report(req, query), req)
  }
}
