import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { InventoryModule } from '../inventory'
import { ListingJobService } from './listing-jobs.service'
import { ListingPerfService } from './listing-perf.service'
import { ListingQualityService } from './listing-quality.service'
import { ListingWriteService } from './listing-write.service'
import { ListingsController } from './listings.controller'

@Module({
  imports: [AuthModule, InventoryModule],
  controllers: [ListingsController],
  providers: [ListingPerfService, ListingQualityService, ListingWriteService, ListingJobService],
  exports: [ListingJobService],
})
export class ListingsModule {}
