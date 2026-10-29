import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { EconomicsAccessService } from './economics-access.service'
import { EconomicsCompareService } from './economics-compare.service'
import { EconomicsPreviewService } from './economics-preview.service'
import { EconomicsSimulateService } from './economics-simulate.service'
import { EconomicsSkuService } from './economics-sku.service'
import { EconomicsController } from './economics.controller'

@Module({
  imports: [AuthModule],
  controllers: [EconomicsController],
  providers: [EconomicsAccessService, EconomicsCompareService, EconomicsPreviewService, EconomicsSimulateService, EconomicsSkuService],
  exports: [EconomicsSkuService],
})
export class EconomicsModule {}
