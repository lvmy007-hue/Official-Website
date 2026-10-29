import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { InventoryModule } from '../inventory'
import { ListingsModule } from '../listings'
import { PricingController } from './pricing.controller'
import { PricingDetailService } from './pricing-detail.service'
import { PricingGuardrailService } from './pricing-guardrail.service'
import { PricingListService } from './pricing-list.service'
import { PricingRuleService } from './pricing-rule.service'
import { PricingRuleDryRunService } from './pricing-rule-dryrun.service'
import { PricingRuleRunsService } from './pricing-rule-runs.service'
import { PricingWriteService } from './pricing-write.service'

@Module({
  imports: [AuthModule, InventoryModule, ListingsModule],
  controllers: [PricingController],
  providers: [PricingListService, PricingDetailService, PricingWriteService, PricingGuardrailService, PricingRuleService, PricingRuleDryRunService, PricingRuleRunsService],
})
export class PricingModule {}
