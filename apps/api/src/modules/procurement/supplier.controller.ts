import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { AttachmentService } from './attachment.service'
import { SUPPLIER_WRITE } from './procurement-common'
import { SupplierService } from './supplier.service'

// 供应商（P2a-10，06 章 6.8；freeze/api.md /suppliers*）。DELETE 是“停用”（保留历史），不物理删除。
@UseGuards(AuthGuard)
@Controller('suppliers')
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly attachments: AttachmentService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.suppliers.list(req, query), req)
  }

  @Get(':id')
  async detail(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.suppliers.detail(req, id), req)
  }

  @Write({ action: 'SUPPLIER_CREATED', resourceType: 'Supplier', permission: SUPPLIER_WRITE })
  @Post()
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.suppliers.create(req, body), req)
  }

  @Write({ action: 'SUPPLIER_UPDATED', resourceType: 'Supplier', permission: SUPPLIER_WRITE })
  @Patch(':id')
  async update(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.suppliers.update(req, id, body), req)
  }

  @Write({ action: 'SUPPLIER_DEACTIVATED', resourceType: 'Supplier', permission: SUPPLIER_WRITE })
  @Delete(':id')
  async deactivate(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.suppliers.deactivate(req, id), req)
  }

  @Write({ action: 'ATTACHMENT_UPLOAD_REQUESTED', resourceType: 'Supplier', permission: SUPPLIER_WRITE, audit: false })
  @Post(':id/attachments')
  async attachmentTicket(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.attachments.ticket(req, 'SUPPLIER', id, body), req)
  }

  @Write({ action: 'ATTACHMENT_ADDED', resourceType: 'Supplier', permission: SUPPLIER_WRITE })
  @Post(':id/attachments/confirm')
  async attachmentConfirm(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.attachments.confirm(req, 'SUPPLIER', id, body), req)
  }

  @Get(':id/attachments/:attachmentId/download')
  async attachmentDownload(@Req() req: RequestWithContext, @Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return ok(await this.attachments.download(req, 'SUPPLIER', id, attachmentId), req)
  }
}
