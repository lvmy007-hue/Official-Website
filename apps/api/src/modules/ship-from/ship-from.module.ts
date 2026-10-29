import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ShipFromController } from './ship-from.controller'
import { ShipFromService } from './ship-from.service'

@Module({
  imports: [AuthModule],
  controllers: [ShipFromController],
  providers: [ShipFromService],
  exports: [ShipFromService],
})
export class ShipFromModule {}
