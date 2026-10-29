import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { FM_WRITE } from './first-mile-common'
import { ForwarderService } from './forwarder.service'

// 货代档案（P2a-11，06 章 6.10；freeze/api.md /freight-forwarders*）。停用走 PATCH status，不物理删除。
@UseGuards(AuthGuard)
@Controller('freight-forwarders')
export class ForwarderController {
  constructor(private readonly forwarders: ForwarderService) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.forwarders.list(req, query), req)
  }

  @Write({ action: 'FREIGHT_FORWARDER_CREATED', resourceType: 'FreightForwarder', permission: FM_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.forwarders.create(req, body), req)
  }

  @Write({ action: 'FREIGHT_FORWARDER_UPDATED', resourceType: 'FreightForwarder', permission: FM_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.forwarders.update(req, id, body), req)
  }
}
