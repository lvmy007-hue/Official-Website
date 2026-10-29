import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AttachmentService } from './attachment.service'
import { ProcurementController } from './procurement.controller'
import { ProcurementService } from './procurement.service'
import { PurchaseOrderController } from './purchase-order.controller'
import { PurchaseOrderPayService } from './purchase-order-pay.service'
import { PurchaseOrderReadService } from './purchase-order-read.service'
import { PurchaseOrderReceiveService } from './purchase-order-receive.service'
import { PurchaseOrderStatusService } from './purchase-order-status.service'
import { PurchaseOrderWriteService } from './purchase-order-write.service'
import { StockCountService } from './stock-count.service'
import { SupplierController } from './supplier.controller'
import { SupplierService } from './supplier.service'
import { WarehouseController } from './warehouse.controller'
import { WarehouseReadService } from './warehouse-read.service'

// 旧的 /procurement/* 保留；P2a-10 的采购单、供应商、国内仓是新的独立路由。
@Module({
  imports: [AuthModule],
  controllers: [ProcurementController, PurchaseOrderController, SupplierController, WarehouseController],
  providers: [
    ProcurementService,
    AttachmentService,
    SupplierService,
    PurchaseOrderReadService,
    PurchaseOrderWriteService,
    PurchaseOrderStatusService,
    PurchaseOrderReceiveService,
    PurchaseOrderPayService,
    WarehouseReadService,
    StockCountService,
  ],
  exports: [ProcurementService, AttachmentService],
})
export class ProcurementModule {}
