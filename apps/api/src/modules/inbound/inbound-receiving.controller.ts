import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AttachmentService } from '../procurement'
import { INBOUND_READ, INBOUND_WRITE } from './inbound-common'
import { InboundShipmentsService } from './inbound-shipments.service'
import { ReceivingStatsService } from './receiving-stats.service'

const RESOURCE = 'FbaInboundShipment'
const POLICY_WRITE = 'replenishment.policy.write'
const TYPE = 'INBOUND_SHIPMENT'

// 货件接收与差异（P2a-13，06 章 6.12；freeze/api.md /inbound/shipments*、/inbound/receiving*）：
// 证据附件（装箱单、提单、签收证明，复用采购模块的签名直传）、审计记录、按运营中心的接收时长统计与回写。
// 货件在成员数据范围内的校验先于附件的权限之外的所有动作；附件接口本身只校验权限与货件属于本企业。
@UseGuards(AuthGuard)
@Controller('inbound')
export class InboundReceivingController {
  constructor(
    private readonly shipments: InboundShipmentsService,
    private readonly stats: ReceivingStatsService,
    private readonly attachments: AttachmentService,
  ) {}

  @Get('receiving/stats')
  async receivingStats(@Req() req: RequestWithContext) {
    return ok(await this.stats.stats(req), req)
  }

  @Write({ action: 'INBOUND_RECEIVING_TIME_APPLIED', resourceType: 'ReplenishmentPolicy', permission: POLICY_WRITE })
  @Post('receiving/stats/apply')
  async applyStats(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.stats.apply(req, body), req)
  }

  @Get('shipments/:id/attachments')
  async attachmentList(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.shipments.evidence(req, id), req)
  }

  @Get('shipments/:id/audit')
  async audit(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.shipments.audit(req, id), req)
  }

  @Write({ action: 'ATTACHMENT_UPLOAD_REQUESTED', resourceType: RESOURCE, permission: INBOUND_WRITE, audit: false })
  @Post('shipments/:id/attachments')
  async attachmentTicket(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    await this.shipments.assertShipmentInScope(req, id, INBOUND_WRITE)
    return ok(await this.attachments.ticket(req, TYPE, id, body), req)
  }

  @Write({ action: 'ATTACHMENT_ADDED', resourceType: RESOURCE, permission: INBOUND_WRITE })
  @Post('shipments/:id/attachments/confirm')
  async attachmentConfirm(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    await this.shipments.assertShipmentInScope(req, id, INBOUND_WRITE)
    return ok(await this.attachments.confirm(req, TYPE, id, body), req)
  }

  @Get('shipments/:id/attachments/:attachmentId/download')
  async attachmentDownload(@Req() req: RequestWithContext, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    await this.shipments.assertShipmentInScope(req, id, INBOUND_READ)
    return ok(await this.attachments.download(req, TYPE, id, attachmentId), req)
  }
}
