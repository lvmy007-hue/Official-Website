import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { HijackListService } from './hijack-list.service'
import { HijackWhitelistService } from './hijack-whitelist.service'
import { PricingCalculatorController } from './pricing-calculator.controller'
import { PricingCalculatorService } from './pricing-calculator.service'
import { ToolsController } from './tools.controller'

@Module({
  imports: [AuthModule],
  controllers: [ToolsController, PricingCalculatorController],
  providers: [HijackListService, HijackWhitelistService, PricingCalculatorService],
})
export class ToolsModule {}
