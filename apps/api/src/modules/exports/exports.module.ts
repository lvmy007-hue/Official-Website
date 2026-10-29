import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ExportsController } from './exports.controller'
import { ExportsService } from './exports.service'

@Module({
  imports: [AuthModule],
  controllers: [ExportsController],
  providers: [ExportsService],
  exports: [ExportsService],
})
export class ExportsModule {}
