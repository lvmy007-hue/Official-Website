import { Module } from '@nestjs/common'
import { NotificationsModule } from '../notifications'
import { ApprovalsRegistryService } from './approval-registry.service'

// 审批登记与回写（P6-27）：只有登记服务，不依赖任何会反过来依赖它的模块；财务口径、口径版本、期间关账模块引用它。
// 收件箱本身（列表、处理）在 approvals 模块，由它去调用上面三个模块的审批服务，两个模块分开才不会循环依赖。
@Module({
  imports: [NotificationsModule],
  providers: [ApprovalsRegistryService],
  exports: [ApprovalsRegistryService],
})
export class ApprovalRegistryModule {}
