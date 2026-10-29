import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { CollabModule } from '../collab'
import { EventsController } from './events.controller'
import { EventsService } from './events.service'

@Module({
  imports: [AuthModule, CollabModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
