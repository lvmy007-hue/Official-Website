import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { SupportDetailService } from './support-detail.service'
import { SupportLinkService } from './support-link.service'
import { SupportListService } from './support-list.service'
import { SupportPiiSource } from './support-pii-source'
import { SupportController } from './support.controller'

// 支持案件（P2b-04）：只读。SupportLinkService 对外提供，赔付案件详情用它显示“关联的亚马逊支持案件”；
// SupportPiiSource 给统一出口 POST /pii/reveal（modules/pii）用，沟通正文完整内容只经那里查看。
@Module({
  imports: [AuthModule],
  controllers: [SupportController],
  providers: [SupportListService, SupportDetailService, SupportLinkService, SupportPiiSource],
  exports: [SupportLinkService, SupportPiiSource],
})
export class SupportModule {}
