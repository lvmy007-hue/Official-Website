import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ProcurementService } from './procurement.service'

@UseGuards(AuthGuard)
@Controller('procurement')
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get('suppliers')
  async suppliers(@Req() req: RequestWithContext) {
    return ok(await this.procurement.suppliers(req), req)
  }

  @Get('purchase-orders')
  async purchaseOrders(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.procurement.purchaseOrders(req, query), req)
  }

  @Write({ action: 'PURCHASE_ORDER_CREATED', resourceType: 'PurchaseOrder', permission: 'purchase.order.write' })
  @Post('purchase-orders')
  async createPurchaseOrder(@Req() req: RequestWithContext, @Body() body: Record<string, unknown>, @Res() response: Response) {
    const result = await this.procurement.createPurchaseOrder(req, body)
    return response.status(201).json(ok(result, req))
  }
}
