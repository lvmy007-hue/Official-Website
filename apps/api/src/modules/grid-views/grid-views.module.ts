import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { GridViewsController } from './grid-views.controller'
import { GridViewsService } from './grid-views.service'

@Module({
  imports: [AuthModule],
  controllers: [GridViewsController],
  providers: [GridViewsService],
})
export class GridViewsModule {}
