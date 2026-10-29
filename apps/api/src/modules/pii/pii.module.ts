import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { OrdersModule } from '../orders'
import { ReturnsModule } from '../returns'
import { SupportModule } from '../support'
import { PiiRevealService } from './pii-reveal.service'
import { PiiController } from './pii.controller'

// 个人信息统一出口（P6-14）：订单、退货、支持案件三个来源各在自己的模块里，这里只负责权限、解密与审计。
@Module({
  imports: [AuthModule, OrdersModule, ReturnsModule, SupportModule],
  controllers: [PiiController],
  providers: [PiiRevealService],
})
export class PiiModule {}
