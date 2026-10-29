import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ConnectionsModule } from '../connections'
import { ExportsModule } from '../exports'
import { LabelTemplatesModule } from '../label-templates'
import { ProcurementModule } from '../procurement'
import { ReplenishmentModule } from '../replenishment'
import { SkuAliasModule } from '../sku-alias'
import { InboundBoxImportService } from './inbound-box-import.service'
import { InboundDraftService } from './inbound-draft.service'
import { InboundJobsService } from './inbound-jobs.service'
import { InboundLabelsService } from './inbound-labels.service'
import { InboundOptionsService } from './inbound-options.service'
import { InboundPackingListService } from './inbound-packing-list.service'
import { InboundPlansController } from './inbound-plans.controller'
import { InboundReadService } from './inbound-read.service'
import { InboundReceivingController } from './inbound-receiving.controller'
import { InboundShipmentGapService } from './inbound-shipment-gap.service'
import { InboundShipmentsService } from './inbound-shipments.service'
import { InboundWriteService } from './inbound-write.service'
import { ReceivingStatsService } from './receiving-stats.service'

// 入仓计划（P2a-12）与货件接收与差异（P2a-13）：证据附件复用采购模块的签名直传，接收时长回写走补货模块的策略版本化入口。
@Module({
  imports: [AuthModule, ConnectionsModule, ExportsModule, LabelTemplatesModule, ProcurementModule, ReplenishmentModule, SkuAliasModule],
  controllers: [InboundPlansController, InboundReceivingController],
  providers: [
    InboundReadService,
    InboundOptionsService,
    InboundShipmentsService,
    InboundShipmentGapService,
    InboundDraftService,
    InboundBoxImportService,
    InboundPackingListService,
    InboundJobsService,
    InboundLabelsService,
    InboundWriteService,
    ReceivingStatsService,
  ],
  exports: [InboundReadService],
})
export class InboundModule {}
