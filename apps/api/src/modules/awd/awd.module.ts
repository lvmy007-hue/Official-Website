import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AwdJobService } from './awd-jobs.service'
import { AwdLabelService } from './awd-label.service'
import { AwdReadService } from './awd-read.service'
import { AwdWriteService } from './awd-write.service'
import { AwdController } from './awd.controller'
import { AwdDraftService } from './awd-draft.service'
import { AwdInventoryDetailService } from './awd-inventory-detail.service'

@Module({
  imports: [AuthModule],
  controllers: [AwdController],
  providers: [AwdReadService, AwdWriteService, AwdLabelService, AwdJobService, AwdInventoryDetailService, AwdDraftService],
  exports: [AwdInventoryDetailService, AwdDraftService],
})
export class AwdModule {}
