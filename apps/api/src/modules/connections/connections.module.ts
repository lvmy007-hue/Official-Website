import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AdsBindingService } from './ads-binding.service'
import { AdsOAuthService } from './ads-oauth.service'
import { ConnectionActionsService } from './connection-actions.service'
import { ConnectionCenterService } from './connection-center.service'
import { ConnectionHealthService } from './connection-health.service'
import { ConnectionsController } from './connections.controller'
import { ConnectionsService } from './connections.service'
import { SpOAuthService } from './sp-oauth.service'

@Module({
  imports: [AuthModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService, SpOAuthService, AdsOAuthService, AdsBindingService, ConnectionCenterService, ConnectionActionsService, ConnectionHealthService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
