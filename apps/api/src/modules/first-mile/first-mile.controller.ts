import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { CARRIER_ACTIONS } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AttachmentService } from '../procurement'
import { FirstMileAllocationService } from './first-mile-allocation.service'
import { FM_READ, FM_WRITE, POLICY_WRITE } from './first-mile-common'
import { FirstMileReadService } from './first-mile-read.service'
import { FirstMileRecordService } from './first-mile-record.service'
import { FirstMileWriteService } from './first-mile-write.service'
import { FreightEstimateService } from './freight-estimate.service'
import { TransitStatsService } from './transit-stats.service'

const RESOURCE = 'FirstMileShipment'

// 头程物流（P2a-11，06 章 6.10；freeze/api.md /first-mile*）。静态路径（transit-stats）必须写在 :id 之前。
@UseGuards(AuthGuard)
@Controller('first-mile')
export class FirstMileController {
  constructor(
    private readonly reads: FirstMileReadService,
    private readonly writes: FirstMileWriteService,
    private readonly records: FirstMileRecordService,
    private readonly allocations: FirstMileAllocationService,
    private readonly transit: TransitStatsService,
    private readonly estimates: FreightEstimateService,
    private readonly attachments: AttachmentService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.reads.list(req, query), req)
  }

  @Get('transit-stats')
  async transitStats(@Req() req: RequestWithContext) {
    return ok(await this.transit.stats(req), req)
  }

  @Write({ action: 'FIRST_MILE_TRANSIT_APPLIED', resourceType: 'ReplenishmentPolicy', permission: POLICY_WRITE })
  @Post('transit-stats/apply')
  async applyTransit(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.transit.apply(req, body), req)
  }

  @Write({ action: 'FIRST_MILE_CREATED', resourceType: RESOURCE, permission: FM_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.reads.detail(req, id), req)
  }

  @Write({ action: 'FIRST_MILE_UPDATED', resourceType: RESOURCE, permission: FM_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  // 预估是只读计算（读权限即可）；批量补录写重量与体积（写权限）。P6-26
  @Write({ action: 'FIRST_MILE_ESTIMATED', resourceType: RESOURCE, permission: FM_READ, audit: false })
  @Post(':id/estimate')
  @HttpCode(200)
  async estimate(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.estimates.estimate(req, id, body), req)
  }

  @Write({ action: CARRIER_ACTIONS.itemsFilled, resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/items/fill')
  @HttpCode(200)
  async fillItems(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.estimates.fill(req, id, body), req)
  }

  @Write({ action: 'FIRST_MILE_OUTBOUND', resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/outbound')
  async outbound(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.outbound(req, id, body), req)
  }

  @Write({ action: 'FIRST_MILE_MILESTONE_ADDED', resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/milestones')
  async addMilestone(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.records.addMilestone(req, id, body), req)
  }

  @Write({ action: 'FIRST_MILE_MILESTONES_IMPORTED', resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/milestones/import')
  async importMilestones(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.records.importMilestones(req, id, body), req)
  }

  @Write({ action: 'FIRST_MILE_MILESTONE_DELETED', resourceType: RESOURCE, permission: FM_WRITE })
  @Delete(':id/milestones/:milestoneId')
  async deleteMilestone(@Req() req: RequestWithContext, @Param('id') id: string, @Param('milestoneId') milestoneId: string, @Query() query: Record<string, string>) {
    return ok(await this.records.deleteMilestone(req, id, milestoneId, query), req)
  }

  @Write({ action: 'FIRST_MILE_COST_ADDED', resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/costs')
  async addCost(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.records.addCost(req, id, body), req)
  }

  @Write({ action: 'FIRST_MILE_COST_DELETED', resourceType: RESOURCE, permission: FM_WRITE })
  @Delete(':id/costs/:costId')
  async deleteCost(@Req() req: RequestWithContext, @Param('id') id: string, @Param('costId') costId: string, @Query() query: Record<string, string>) {
    return ok(await this.records.deleteCost(req, id, costId, query), req)
  }

  @Write({ action: 'FIRST_MILE_ALLOCATED', resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/allocate')
  async allocate(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.allocations.allocate(req, id, body), req)
  }

  @Write({ action: 'FIRST_MILE_ALLOCATION_REVERTED', resourceType: RESOURCE, permission: FM_WRITE })
  @Delete(':id/allocation')
  async revert(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.allocations.revert(req, id, query), req)
  }

  @Write({ action: 'ATTACHMENT_UPLOAD_REQUESTED', resourceType: RESOURCE, permission: FM_WRITE, audit: false })
  @Post(':id/attachments')
  async attachmentTicket(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.attachments.ticket(req, 'FIRST_MILE', id, body), req)
  }

  @Write({ action: 'ATTACHMENT_ADDED', resourceType: RESOURCE, permission: FM_WRITE })
  @Post(':id/attachments/confirm')
  async attachmentConfirm(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.attachments.confirm(req, 'FIRST_MILE', id, body), req)
  }

  @Get(':id/attachments/:attachmentId/download')
  async attachmentDownload(@Req() req: RequestWithContext, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return ok(await this.attachments.download(req, 'FIRST_MILE', id, attachmentId), req)
  }
}
