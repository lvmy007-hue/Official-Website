import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ProcurementModule } from '../procurement'
import { ReplenishmentModule } from '../replenishment'
import { CarrierRatesService } from './carrier-rates.service'
import { CarriersController } from './carriers.controller'
import { CarriersService } from './carriers.service'
import { FirstMileAllocationService } from './first-mile-allocation.service'
import { FirstMileReadService } from './first-mile-read.service'
import { FirstMileRecordService } from './first-mile-record.service'
import { FirstMileWriteService } from './first-mile-write.service'
import { FirstMileController } from './first-mile.controller'
import { ForwarderController } from './forwarder.controller'
import { FreightEstimateService } from './freight-estimate.service'
import { ForwarderService } from './forwarder.service'
import { TransitStatsService } from './transit-stats.service'

// 头程物流（P2a-11）：运单、节点、费用、分摊、出库、时效统计与回写；P6-26 加物流渠道与报价、预估与批量补录。附件复用采购模块的签名直传，策略回写走补货模块的版本化入口。
@Module({
  imports: [AuthModule, ProcurementModule, ReplenishmentModule],
  // CarriersController 必须在 FirstMileController 之前：静态路径 /first-mile/carriers 不能被 /first-mile/:id 吞掉
  controllers: [CarriersController, FirstMileController, ForwarderController],
  providers: [
    FirstMileReadService,
    FirstMileWriteService,
    FirstMileRecordService,
    FirstMileAllocationService,
    ForwarderService,
    TransitStatsService,
    CarriersService,
    CarrierRatesService,
    FreightEstimateService,
  ],
})
export class FirstMileModule {}
