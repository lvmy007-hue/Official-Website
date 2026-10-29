import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AwdLabelService } from './awd-label.service'
import { AwdReadService } from './awd-read.service'
import { AwdWriteService } from './awd-write.service'

// 亚马逊仓储分销（P2a-08，06 章 6.3；freeze/api.md 第八节）。查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 写入类接口都要依次通过：权限 → 店铺连接 → 写入开关（sw.awd.order.write）；本地草稿的保存与取消不调用亚马逊，只要求权限。
@UseGuards(AuthGuard)
@Controller('awd')
export class AwdController {
  constructor(
    private readonly read: AwdReadService,
    private readonly writes: AwdWriteService,
    private readonly labels: AwdLabelService,
  ) {}

  @Get('inventory')
  async inventory(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.inventory(req, query), req)
  }

  @Get('orders')
  async orders(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.orders(req, query), req)
  }

  @Get('orders/:id')
  async order(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.read.orderDetail(req, id), req)
  }

  @Get('shipments')
  async shipments(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.shipments(req, query), req)
  }

  @Get('shipments/:id/labels')
  async shipmentLabels(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.labels.labels(req, id), req)
  }

  @Write({ action: 'AWD_LABEL_REQUESTED', resourceType: 'AwdInboundShipment', permission: 'awd.read' })
  @Post('shipments/:id/labels')
  async requestLabels(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.labels.request(req, id), req)
  }

  @Write({ action: 'AWD_ORDER_CREATED', resourceType: 'AwdInboundOrder', permission: 'awd.order.write' })
  @Post('orders')
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Write({ action: 'AWD_ORDER_UPDATED', resourceType: 'AwdInboundOrder', permission: 'awd.order.write' })
  @Patch('orders/:id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  @Write({ action: 'AWD_ORDER_CONFIRMED', resourceType: 'AwdInboundOrder', permission: 'awd.order.write' })
  @Post('orders/:id/confirm')
  async confirm(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.confirm(req, id, body), req)
  }

  @Write({ action: 'AWD_ORDER_CANCELLED', resourceType: 'AwdInboundOrder', permission: 'awd.order.write' })
  @Post('orders/:id/cancel')
  async cancel(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.cancel(req, id, body), req)
  }
}
