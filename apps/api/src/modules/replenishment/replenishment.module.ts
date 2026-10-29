import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AwdModule } from '../awd'
import { InventoryModule } from '../inventory'
import { ReplenishmentActionService } from './replenishment-action.service'
import { ReplenishmentComputeService } from './replenishment-compute.service'
import { ReplenishmentEvaluateService } from './replenishment-evaluate.service'
import { ReplenishmentForecastController } from './replenishment-forecast.controller'
import { ReplenishmentForecastService } from './replenishment-forecast.service'
import { ReplenishmentInventoryController } from './replenishment-inventory.controller'
import { ReplenishmentLoaderService } from './replenishment-loader.service'
import { ReplenishmentPolicyService } from './replenishment-policy.service'
import { ReplenishmentReadService } from './replenishment-read.service'
import { ReplenishmentSimulateService } from './replenishment-simulate.service'
import { ReplenishmentSkuService } from './replenishment-sku.service'
import { ReplenishmentController } from './replenishment.controller'

@Module({
  imports: [AuthModule, AwdModule, InventoryModule],
  controllers: [ReplenishmentController, ReplenishmentForecastController, ReplenishmentInventoryController],
  providers: [
    ReplenishmentForecastService,
    ReplenishmentPolicyService,
    ReplenishmentLoaderService,
    ReplenishmentComputeService,
    ReplenishmentReadService,
    ReplenishmentActionService,
    ReplenishmentEvaluateService,
    ReplenishmentSimulateService,
    ReplenishmentSkuService,
  ],
  exports: [ReplenishmentPolicyService],
})
export class ReplenishmentModule {}
