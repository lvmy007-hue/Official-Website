import { Module } from '@nestjs/common'
import { AdsModule } from '../ads'
import { AuthModule } from '../auth'
import { PromotionsDetailService } from './promotions-detail.service'
import { PromotionsListService } from './promotions-list.service'
import { PromotionsStackingService } from './promotions-stacking.service'
import { PromotionsController } from './promotions.controller'

// 促销与优惠券（P4-05）：只读。广告页签复用广告模块的 ASIN 广告覆盖。
@Module({
  imports: [AuthModule, AdsModule],
  controllers: [PromotionsController],
  providers: [PromotionsListService, PromotionsDetailService, PromotionsStackingService],
})
export class PromotionsModule {}
