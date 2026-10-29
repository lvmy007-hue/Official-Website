import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ProfitAccessService } from './profit-access.service'
import { ProfitBridgeService } from './profit-bridge.service'
import { ProfitCoverageService } from './profit-coverage.service'
import { ProfitDictionaryService } from './profit-dictionary.service'
import { ProfitGroupsService } from './profit-groups.service'
import { ProfitOverviewService } from './profit-overview.service'
import { ProfitStoresService } from './profit-stores.service'
import { ProfitController } from './profit.controller'

@Module({
  imports: [AuthModule],
  controllers: [ProfitController],
  providers: [ProfitAccessService, ProfitOverviewService, ProfitStoresService, ProfitGroupsService, ProfitCoverageService, ProfitBridgeService, ProfitDictionaryService],
  exports: [ProfitGroupsService],
})
export class ProfitModule {}
