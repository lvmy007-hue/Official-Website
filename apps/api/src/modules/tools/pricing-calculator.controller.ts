import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common'
import { PRICING_CALC_ACTIONS, TOOLS_READ } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { PricingCalculatorService } from './pricing-calculator.service'

// 新品定价试算（P6-29；16 章第 10 节；freeze/api.md /tools/pricing-calculator/*）。
// 试算是只读计算（audit:false）：24 小时内同样参数复用，超频 429。保存才落成“我的记录”。
@UseGuards(AuthGuard)
@Controller('tools/pricing-calculator')
export class PricingCalculatorController {
  constructor(private readonly calculator: PricingCalculatorService) {}

  @Write({ action: 'PRICING_CALC_ESTIMATED', resourceType: 'PricingCalcRecord', permission: TOOLS_READ, audit: false })
  @HttpCode(200)
  @Post('estimate')
  async estimate(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.calculator.estimate(req, body), req)
  }

  @Get('records')
  async records(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.calculator.list(req, query), req)
  }

  @Write({ action: PRICING_CALC_ACTIONS.saved, resourceType: 'PricingCalcRecord', permission: TOOLS_READ })
  @HttpCode(200)
  @Post('records')
  async save(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.calculator.save(req, body), req)
  }
}
