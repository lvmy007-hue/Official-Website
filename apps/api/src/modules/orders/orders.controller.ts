import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ORDERS_PERMISSION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { OrdersNetIncomeService } from './orders-net-income.service'
import { OrdersDetailService } from './orders-detail.service'
import { OrdersFinanceService } from './orders-finance.service'
import { OrdersListService } from './orders-list.service'
import { OrdersReturnsService } from './orders-returns.service'

// 订单页（P2b-01）：列表与详情各页签各一个读接口，页签按需加载。买家信息明文不在这里：只能经统一出口 POST /pii/reveal（P6-14）。
@UseGuards(AuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly list: OrdersListService,
    private readonly netIncomeColumn: OrdersNetIncomeService,
    private readonly detail: OrdersDetailService,
    private readonly finance: OrdersFinanceService,
    private readonly returns: OrdersReturnsService,
  ) {}

  @Get()
  async index(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.list.list(req, query), req)
  }

  // 净收益异步列：只读的批量查询，用 POST 带编号列表，不写业务数据也不进审计
  @Write({ action: 'ORDER_NET_INCOME_LOADED', resourceType: 'Order', permission: ORDERS_PERMISSION, audit: false })
  @HttpCode(200)
  @Post('net-income')
  async netIncome(@Req() req: RequestWithContext, @Query() query: Record<string, string>, @Body() body: unknown) {
    return ok(await this.netIncomeColumn.netIncome(req, query, body), req)
  }

  @Get(':id')
  async identity(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.identity(req, id), req)
  }

  @Get(':id/items')
  async items(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.items(req, id), req)
  }

  @Get(':id/charges')
  async charges(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.finance.charges(req, id), req)
  }

  @Get(':id/packages')
  async packages(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.packages(req, id), req)
  }

  @Get(':id/returns')
  async returnsOf(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.returns.returns(req, id), req)
  }

  @Get(':id/transactions')
  async transactions(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.finance.transactions(req, id), req)
  }

  @Get(':id/timeline')
  async timeline(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.detail.timeline(req, id), req)
  }

  @Get(':id/risks')
  async risks(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.returns.risks(req, id), req)
  }
}
