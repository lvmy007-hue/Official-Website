import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { FreshnessModule } from '../freshness'
import { CashService } from './cash.service'
import { CompareService } from './compare.service'
import { KpisService } from './kpis.service'
import { OverviewContextService } from './overview-context.service'
import { OverviewController } from './overview.controller'
import { OverviewService } from './overview.service'
import { TrendService } from './trend.service'

@Module({
  imports: [AuthModule, FreshnessModule],
  controllers: [OverviewController],
  providers: [OverviewService, OverviewContextService, KpisService, TrendService, CompareService, CashService],
})
export class OverviewModule {}
