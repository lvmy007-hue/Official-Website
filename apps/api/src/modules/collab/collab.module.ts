import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { NotificationsModule } from '../notifications'
import { WorkModule } from '../work'
import { CollabController } from './collab.controller'
import { CommentsService } from './comments.service'
import { EntityAccessService } from './entity-access.service'
import { TimelineService } from './timeline.service'
import { ViewsService } from './views.service'
import { WatchesService } from './watches.service'

@Module({
  imports: [AuthModule, NotificationsModule, WorkModule],
  controllers: [CollabController],
  providers: [EntityAccessService, ViewsService, CommentsService, WatchesService, TimelineService],
  exports: [EntityAccessService],
})
export class CollabModule {}
