import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AttachmentService } from './attachment.service'
import { PO_PAY, PO_RECEIVE, PO_APPROVE, PO_WRITE } from './procurement-common'
import { PurchaseOrderPayService } from './purchase-order-pay.service'
import { PurchaseOrderReadService } from './purchase-order-read.service'
import { PurchaseOrderReceiveService } from './purchase-order-receive.service'
import { PurchaseOrderStatusService } from './purchase-order-status.service'
import { PurchaseOrderWriteService } from './purchase-order-write.service'

// 采购订单（P2a-10，06 章 6.7；freeze/api.md /purchase-orders*）。查询参数类型必须直接写 Record<string, string>，不能起别名。
// 采购不挂店铺：不需要店铺连接，只看权限；写入类动作都带 @Write（权限预检、幂等、审计）。
@UseGuards(AuthGuard)
@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(
    private readonly read: PurchaseOrderReadService,
    private readonly writes: PurchaseOrderWriteService,
    private readonly status: PurchaseOrderStatusService,
    private readonly receiving: PurchaseOrderReceiveService,
    private readonly payments: PurchaseOrderPayService,
    private readonly attachments: AttachmentService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.list(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.read.detail(req, id), req)
  }

  @Write({ action: 'PURCHASE_ORDER_CREATED', resourceType: 'PurchaseOrder', permission: PO_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.writes.create(req, body), req)
  }

  @Write({ action: 'PURCHASE_ORDER_UPDATED', resourceType: 'PurchaseOrder', permission: PO_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.update(req, id, body), req)
  }

  @Write({ action: 'PURCHASE_ORDER_SUBMITTED', resourceType: 'PurchaseOrder', permission: PO_WRITE })
  @Post(':id/submit')
  async submit(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.submit(req, id, body), req)
  }

  @Write({ action: 'PURCHASE_ORDER_APPROVED', resourceType: 'PurchaseOrder', permission: PO_APPROVE })
  @Post(':id/approve')
  async approve(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.approve(req, id, body), req)
  }

  @Write({ action: 'PURCHASE_ORDER_STATUS_CHANGED', resourceType: 'PurchaseOrder', permission: PO_WRITE })
  @Post(':id/status')
  async changeStatus(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.status.apply(req, id, body), req)
  }

  @Write({ action: 'PURCHASE_RECEIPT_RECORDED', resourceType: 'PurchaseOrder', permission: PO_RECEIVE })
  @Post(':id/receipts')
  async receive(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.receiving.receive(req, id, body), req)
  }

  @Write({ action: 'PURCHASE_INSPECTION_RECORDED', resourceType: 'PurchaseOrder', permission: PO_RECEIVE })
  @Post(':id/inspections')
  async inspect(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.receiving.inspect(req, id, body), req)
  }

  @Write({ action: 'PURCHASE_PAYMENT_RECORDED', resourceType: 'PurchaseOrder', permission: PO_PAY })
  @Post(':id/payments')
  async pay(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.payments.pay(req, id, body), req)
  }

  @Write({ action: 'ATTACHMENT_UPLOAD_REQUESTED', resourceType: 'PurchaseOrder', permission: PO_WRITE, audit: false })
  @Post(':id/attachments')
  async attachmentTicket(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.attachments.ticket(req, 'PURCHASE_ORDER', id, body), req)
  }

  @Write({ action: 'ATTACHMENT_ADDED', resourceType: 'PurchaseOrder', permission: PO_WRITE })
  @Post(':id/attachments/confirm')
  async attachmentConfirm(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.attachments.confirm(req, 'PURCHASE_ORDER', id, body), req)
  }

  @Get(':id/attachments/:attachmentId/download')
  async attachmentDownload(@Req() req: RequestWithContext, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return ok(await this.attachments.download(req, 'PURCHASE_ORDER', id, attachmentId), req)
  }
}
