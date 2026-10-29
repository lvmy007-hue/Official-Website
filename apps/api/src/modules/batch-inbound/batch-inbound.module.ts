import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ShipFromModule } from '../ship-from'
import { BatchInboundController } from './batch-inbound.controller'
import { BatchInboundService } from './batch-inbound.service'

@Module({
  imports: [AuthModule, ShipFromModule],
  controllers: [BatchInboundController],
  providers: [BatchInboundService],
})
export class BatchInboundModule {}
