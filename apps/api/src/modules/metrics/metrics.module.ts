import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { MetricsController } from './metrics.controller'
import { MetricsService } from './metrics.service'

@Module({ imports: [AuthModule], controllers: [MetricsController], providers: [MetricsService] })
export class MetricsModule {}
