import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { AllocationRulesPreviewService } from './allocation-rules-preview.service'
import { AllocationRulesReadService } from './allocation-rules-read.service'
import { AllocationRulesWriteService } from './allocation-rules-write.service'
import { AllocationRulesController } from './allocation-rules.controller'

@Module({
  imports: [AuthModule],
  controllers: [AllocationRulesController],
  providers: [AllocationRulesReadService, AllocationRulesWriteService, AllocationRulesPreviewService],
})
export class AllocationRulesModule {}
