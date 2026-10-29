import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { CARRIER_ACTIONS } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CarrierRatesService } from './carrier-rates.service'
import { CarriersService } from './carriers.service'
import { FM_WRITE } from './first-mile-common'

// 物流渠道与报价（P6-26）：物流商、渠道、阶梯报价的增删改查。读取要 firstmile.read，写入要 firstmile.write（在服务里先于参数校验检查）。
// 这个控制器必须排在 FirstMileController 之前注册：/first-mile/carriers 不能被 /first-mile/:id 吞掉。查询参数类型必须直接写 Record<string, string>。
@UseGuards(AuthGuard)
@Controller('first-mile/carriers')
export class CarriersController {
  constructor(
    private readonly carriers: CarriersService,
    private readonly rates: CarrierRatesService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.carriers.list(req, query), req)
  }

  @Write({ action: CARRIER_ACTIONS.carrierCreated, resourceType: 'Carrier', permission: FM_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.carriers.createCarrier(req, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.carrierUpdated, resourceType: 'Carrier', permission: FM_WRITE })
  @Put(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.carriers.updateCarrier(req, id, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.carrierDeleted, resourceType: 'Carrier', permission: FM_WRITE })
  @Delete(':id')
  async remove(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.carriers.deleteCarrier(req, id), req)
  }

  @Write({ action: CARRIER_ACTIONS.channelCreated, resourceType: 'CarrierChannel', permission: FM_WRITE })
  @Post(':id/channels')
  async createChannel(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.carriers.createChannel(req, id, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.channelUpdated, resourceType: 'CarrierChannel', permission: FM_WRITE })
  @Put(':id/channels/:channelId')
  async updateChannel(@Req() req: RequestWithContext, @Param('id') id: string, @Param('channelId') channelId: string, @Body() body: unknown) {
    return ok(await this.carriers.updateChannel(req, id, channelId, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.channelDeleted, resourceType: 'CarrierChannel', permission: FM_WRITE })
  @Delete(':id/channels/:channelId')
  async removeChannel(@Req() req: RequestWithContext, @Param('id') id: string, @Param('channelId') channelId: string) {
    return ok(await this.carriers.deleteChannel(req, id, channelId), req)
  }

  @Get(':id/channels/:channelId/rates')
  async listRates(@Req() req: RequestWithContext, @Param('id') id: string, @Param('channelId') channelId: string, @Query() query: Record<string, string>) {
    return ok(await this.rates.list(req, id, channelId, query), req)
  }

  @Write({ action: CARRIER_ACTIONS.rateCreated, resourceType: 'ChannelRate', permission: FM_WRITE })
  @Post(':id/channels/:channelId/rates')
  async createRate(@Req() req: RequestWithContext, @Param('id') id: string, @Param('channelId') channelId: string, @Body() body: unknown) {
    return ok(await this.rates.create(req, id, channelId, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.rateUpdated, resourceType: 'ChannelRate', permission: FM_WRITE })
  @Put(':id/channels/:channelId/rates/:rateId')
  async updateRate(@Req() req: RequestWithContext, @Param('id') id: string, @Param('channelId') channelId: string, @Param('rateId') rateId: string, @Body() body: unknown) {
    return ok(await this.rates.update(req, id, channelId, rateId, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.rateDeleted, resourceType: 'ChannelRate', permission: FM_WRITE })
  @Delete(':id/channels/:channelId/rates/:rateId')
  async removeRate(@Req() req: RequestWithContext, @Param('id') id: string, @Param('channelId') channelId: string, @Param('rateId') rateId: string) {
    return ok(await this.rates.remove(req, id, channelId, rateId), req)
  }
}
