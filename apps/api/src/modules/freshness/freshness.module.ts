import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { FreshnessController } from './freshness.controller'
import { FreshnessService } from './freshness.service'

@Module({
  imports: [AuthModule],
  controllers: [FreshnessController],
  providers: [FreshnessService],
  exports: [FreshnessService],
})
export class FreshnessModule {}
