import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { EntitiesDetailService } from './entities-detail.service'
import { EntitiesController } from './entities.controller'
import { EntitiesService } from './entities.service'

@Module({ imports: [AuthModule], controllers: [EntitiesController], providers: [EntitiesService, EntitiesDetailService] })
export class EntitiesModule {}
