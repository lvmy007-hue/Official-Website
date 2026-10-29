import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { EstimatedFeesImportService } from './estimated-fees-import.service'
import { EstimatedFeesReadService } from './estimated-fees-read.service'
import { EstimatedFeesWriteService } from './estimated-fees-write.service'
import { EstimatedFeesController } from './estimated-fees.controller'

@Module({
  imports: [AuthModule],
  controllers: [EstimatedFeesController],
  providers: [EstimatedFeesReadService, EstimatedFeesWriteService, EstimatedFeesImportService],
})
export class EstimatedFeesModule {}
