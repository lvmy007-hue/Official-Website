import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { CommerceOrderCreateSchema, CommerceRefundCreateSchema } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { RateLimitService } from '../../platform/rate-limit.service'
import { Write, WriteExempt } from '../../platform/write'
import { AuthGuard } from '../auth'
import { CommerceService } from './commerce.service'

@Controller()
export class CommerceController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ---- 官网在线购买（公开接口）----

  @Get('commerce/plans')
  async plans(@Req() req: RequestWithContext) {
    return ok(await this.commerce.publicPlans(), req)
  }

  @Get('commerce/payment-configuration')
  paymentConfiguration(@Req() req: RequestWithContext) {
    return ok(this.commerce.paymentConfiguration(), req)
  }

  @WriteExempt('官网公开下单：购买方没有登录态，按来源地址限流；订单只能凭下单时返回的访问凭据查看')
  @Post('commerce/orders')
  async createOrder(@Req() req: RequestWithContext, @Body() body: unknown, @Res() response: Response) {
    await this.rateLimit.check('commerce-order', req.ip ?? 'unknown', 3, 600)
    const result = await this.commerce.createOrder(CommerceOrderCreateSchema.parse(body), req.requestId)
    return response.status(201).json(ok(result, req))
  }

  @Get('commerce/orders/:orderNo')
  async order(@Req() req: RequestWithContext, @Param('orderNo') orderNo: string, @Headers('x-order-token') token = '') {
    return ok(await this.commerce.publicOrder(orderNo, token), req)
  }

  @WriteExempt('官网公开支付：凭订单访问凭据发起，按来源地址与订单限流')
  @Post('commerce/orders/:orderNo/pay')
  async startPayment(@Req() req: RequestWithContext, @Param('orderNo') orderNo: string, @Headers('x-order-token') token = '') {
    await this.rateLimit.check('commerce-pay', `${req.ip}:${orderNo}`, 5, 300)
    return ok(await this.commerce.startPayment(orderNo, token, req.requestId), req, 'external')
  }

  @WriteExempt('官网公开退款申请：凭订单访问凭据提交，同一订单只允许一个进行中的申请')
  @Post('commerce/orders/:orderNo/refunds')
  async requestRefund(@Req() req: RequestWithContext, @Param('orderNo') orderNo: string, @Headers('x-order-token') token = '', @Body() body: unknown) {
    return ok(await this.commerce.requestRefund(orderNo, token, CommerceRefundCreateSchema.parse(body), req.requestId), req)
  }

  @WriteExempt('支付宝异步通知：第三方回调，没有登录态，按支付宝签名校验并幂等处理')
  @Post('payments/alipay/notify')
  async alipayNotify(@Req() req: RequestWithContext, @Body() body: Record<string, unknown>, @Res() response: Response) {
    const accepted = await this.commerce.handleAlipayNotify(body, req.requestId)
    return response
      .type('text/plain')
      .status(accepted ? 200 : 400)
      .send(accepted ? 'success' : 'failure')
  }

  // ---- 平台运营：套餐、订单、退款 ----

  @UseGuards(AuthGuard)
  @Get('commerce/admin/plans')
  async adminPlans(@Req() req: RequestWithContext) {
    return ok(await this.commerce.adminPlans(req), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'COMMERCIAL_PLAN_UPDATED', resourceType: 'CommercialPlan' })
  @Patch('commerce/admin/plans/:id')
  async updatePlan(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.commerce.updatePlan(req, id, body), req)
  }

  @UseGuards(AuthGuard)
  @Get('commerce/admin/orders')
  async adminOrders(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.commerce.adminOrders(req, query), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'COMMERCIAL_ORDER_ACTIVATED', resourceType: 'CommerceOrder' })
  @Post('commerce/admin/orders/:id/activate')
  async activateOrder(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.commerce.activateOrder(req, id, body), req)
  }

  @UseGuards(AuthGuard)
  @Get('commerce/admin/refunds')
  async adminRefunds(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.commerce.adminRefunds(req, query), req)
  }

  @UseGuards(AuthGuard)
  @Write({ action: 'COMMERCIAL_REFUND_REVIEWED', resourceType: 'RefundRequest' })
  @Patch('commerce/admin/refunds/:id')
  async reviewRefund(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.commerce.reviewRefund(req, id, body), req, 'external')
  }
}
