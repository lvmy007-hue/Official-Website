import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { SHIP_FROM_ACTIONS, SHIP_FROM_MANAGE } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ShipFromService } from './ship-from.service'

// 发货地址接口（P6-08）：读取要 inbound.read，写入要 shipfrom.manage（在服务里先于参数校验检查，并核对店铺在数据范围内）。查询参数类型必须直接写 Record<string, string>。
@UseGuards(AuthGuard)
@Controller('ship-from-addresses')
export class ShipFromController {
  constructor(private readonly addresses: ShipFromService) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.addresses.list(req, query), req)
  }

  @Write({ action: SHIP_FROM_ACTIONS.created, resourceType: 'ShipFromAddress', permission: SHIP_FROM_MANAGE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.addresses.create(req, body), req)
  }

  @Write({ action: SHIP_FROM_ACTIONS.updated, resourceType: 'ShipFromAddress', permission: SHIP_FROM_MANAGE })
  @Put(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.addresses.update(req, id, body), req)
  }

  @Write({ action: SHIP_FROM_ACTIONS.defaulted, resourceType: 'ShipFromAddress', permission: SHIP_FROM_MANAGE })
  @HttpCode(200)
  @Post(':id/default')
  async setDefault(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.addresses.setDefault(req, id), req)
  }

  @Write({ action: SHIP_FROM_ACTIONS.deleted, resourceType: 'ShipFromAddress', permission: SHIP_FROM_MANAGE })
  @Delete(':id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.addresses.remove(req, id), req)
  }
}
