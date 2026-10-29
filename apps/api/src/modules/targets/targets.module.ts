import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { TargetsController } from './targets.controller'
import { TargetsQueryService } from './targets-query.service'
import { TargetsWriteService } from './targets-write.service'

@Module({
  imports: [AuthModule],
  controllers: [TargetsController],
  providers: [TargetsQueryService, TargetsWriteService],
})
export class TargetsModule {}
