import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { CostsAccessService } from './costs-access.service'
import { CostsDetailService } from './costs-detail.service'
import { CostsImportService } from './costs-import.service'
import { CostsListService } from './costs-list.service'
import { CostsWriteService } from './costs-write.service'
import { CostsController } from './costs.controller'

// 商品成本（P2b-14，05 章 5.9）：成本列表、版本时间线与详情、录入与导入、确认生效、版本对比。
@Module({
  imports: [AuthModule],
  controllers: [CostsController],
  providers: [CostsAccessService, CostsListService, CostsDetailService, CostsWriteService, CostsImportService],
  exports: [CostsDetailService],
})
export class CostsModule {}
