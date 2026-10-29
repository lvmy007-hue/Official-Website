import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { InventoryModule } from '../inventory'
import { CompetitorsCandidatesService } from './competitors-candidates.service'
import { CompetitorsDetailService } from './competitors-detail.service'
import { CompetitorsListService } from './competitors-list.service'
import { CompetitorsWriteService } from './competitors-write.service'
import { CompetitorsController } from './competitors.controller'

@Module({
  imports: [AuthModule, InventoryModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsListService, CompetitorsCandidatesService, CompetitorsDetailService, CompetitorsWriteService],
})
export class CompetitorsModule {}
