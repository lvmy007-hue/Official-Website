import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AplusAcceptService } from './aplus-accept.service'
import { AplusDetailService } from './aplus-detail.service'
import { AplusJobService } from './aplus-jobs.service'
import { AplusReadService } from './aplus-read.service'
import { AplusUploadService } from './aplus-upload.service'
import { AplusWriteGate } from './aplus-write-gate.service'
import { AplusWriteService } from './aplus-write.service'
import { AplusController } from './aplus.controller'

@Module({
  imports: [AuthModule],
  controllers: [AplusController],
  providers: [AplusReadService, AplusDetailService, AplusWriteService, AplusUploadService, AplusWriteGate, AplusAcceptService, AplusJobService],
})
export class AplusModule {}
