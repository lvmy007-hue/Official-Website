import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AwdModule } from '../awd'
import { AllWarehousesService } from './all-warehouses.service'
import { CapacityImportService } from './capacity-import.service'
import { CapacityService } from './capacity.service'
import { InventoryDetailController } from './inventory-detail.controller'
import { InventoryDetailMoreService } from './inventory-detail-more.service'
import { InventoryDetailService } from './inventory-detail.service'
import { InventoryHealthController } from './inventory-health.controller'
import { InventoryHealthService } from './inventory-health.service'
import { InventoryItemService } from './inventory-item.service'
import { InventoryLoaderService } from './inventory-loader.service'
import { InventoryPolicyService } from './inventory-policy.service'
import { InventoryReportsController } from './inventory-reports.controller'
import { InventoryStockController } from './inventory-stock.controller'
import { InventoryController } from './inventory.controller'
import { InventoryService } from './inventory.service'
import { LedgerService } from './ledger.service'
import { MovementReportService } from './movement-report.service'
import { RemovalReadService } from './removal-read.service'
import { RemovalReceiptService } from './removal-receipt.service'

// 控制器顺序有意义：静态路径（inventory/movements、summary、rules、ledger、removals、capacity）要排在带 :id 的详情控制器之前。
@Module({
  imports: [AuthModule, AwdModule],
  controllers: [InventoryController, InventoryHealthController, InventoryStockController, InventoryReportsController, InventoryDetailController],
  providers: [
    InventoryService,
    InventoryLoaderService,
    InventoryPolicyService,
    InventoryHealthService,
    InventoryItemService,
    InventoryDetailService,
    InventoryDetailMoreService,
    LedgerService,
    RemovalReadService,
    RemovalReceiptService,
    CapacityService,
    CapacityImportService,
    AllWarehousesService,
    MovementReportService,
  ],
  exports: [InventoryService, InventoryLoaderService, InventoryPolicyService, InventoryItemService, InventoryDetailService, InventoryHealthService],
})
export class InventoryModule {}
