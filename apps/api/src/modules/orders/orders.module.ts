import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { OrderAccessService } from './orders-access.service'
import { OrdersDetailService } from './orders-detail.service'
import { OrdersFinanceService } from './orders-finance.service'
import { OrdersListService } from './orders-list.service'
import { OrdersNetIncomeService } from './orders-net-income.service'
import { OrdersPiiSource } from './orders-pii-source'
import { OrdersReturnsService } from './orders-returns.service'
import { OrdersController } from './orders.controller'

// 买家信息明文只能经统一出口 POST /pii/reveal（modules/pii）查看；本模块只提供它需要的“来源”（OrdersPiiSource）。
@Module({
  imports: [AuthModule],
  controllers: [OrdersController],
  providers: [OrderAccessService, OrdersListService, OrdersNetIncomeService, OrdersDetailService, OrdersFinanceService, OrdersReturnsService, OrdersPiiSource],
  exports: [OrdersPiiSource],
})
export class OrdersModule {}
