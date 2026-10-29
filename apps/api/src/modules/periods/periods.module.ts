import { Module } from '@nestjs/common'
import { ApprovalRegistryModule } from '../approval-registry'
import { AuthModule } from '../auth'
import { FxModule } from '../fx'
import { PeriodsController } from './periods.controller'
import { PeriodsCloseService } from './periods-close.service'
import { PeriodsReadService } from './periods-read.service'
import { PeriodsWriteService } from './periods-write.service'

// 期间关账（P2b-13，07 章 7.12）：创建期间、完整性检查、审批、锁定快照、重新开账。锁定期间内的汇率调用汇率模块的锁定能力。
// P6-27：检查通过时登记到审批收件箱，审批时回写；收件箱模块通过导出的写服务代为审批。
@Module({
  imports: [AuthModule, FxModule, ApprovalRegistryModule],
  controllers: [PeriodsController],
  providers: [PeriodsReadService, PeriodsWriteService, PeriodsCloseService],
  exports: [PeriodsWriteService],
})
export class PeriodsModule {}
