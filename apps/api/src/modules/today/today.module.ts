import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { TodayContextService } from './today-context'
import { TodayController } from './today.controller'
import { TodayService } from './today.service'

@Module({
  imports: [AuthModule],
  controllers: [TodayController],
  providers: [TodayService, TodayContextService],
})
export class TodayModule {}
