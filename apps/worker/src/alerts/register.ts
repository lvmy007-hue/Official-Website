import { AlertEvaluatorRegistry } from '../platform/alert-evaluate'
import { healthDeclineEvaluator, statusChangedEvaluator } from './account-evaluators'
import { adsOutOfBudgetEvaluator } from './ads-budget-evaluator'
import { adsCpcSurgeEvaluator } from './ads-cpc-evaluator'
import { adsLowReturnEvaluator } from './ads-low-return-evaluator'
import { adsStockoutEvaluator } from './ads-stockout-evaluator'
import { customMetricEvaluator } from './custom-metric-evaluator'
import { fxFailedEvaluator, writeSwitchClosedEvaluator } from './config-evaluators'
import { sizeTierChangeEvaluator } from './fee-evaluator'
import { feeOverchargeEvaluator } from './fee-overcharge-evaluator'
import { featuredOfferLostEvaluator } from './featured-offer-evaluator'
import { hijackOfferEvaluator } from './hijack-evaluator'
import { inboundDiscrepancyEvaluator } from './inbound-evaluator'
import { inventoryEvaluators } from './inventory-evaluators'
import { contentChangedByOthersEvaluator } from './listing-change-evaluator'
import { newListingIssueEvaluator, searchSuppressedEvaluator } from './listing-issue-evaluators'
import { piiBulkViewEvaluator } from './pii-bulk-view-evaluator'
import { priceHealthEvaluator } from './price-health-evaluator'
import { promoStackingEvaluator } from './promo-stacking-evaluator'
import { reimbursementDeadlineEvaluator } from './reimbursement-deadline-evaluator'
import { negativeTopicRisingEvaluator } from './review-topic-evaluator'
import { abnormalReturnRateEvaluator } from './returns-evaluator'
import { settlementDiscrepancyEvaluator } from './settlement-evaluator'
import { authExpiringEvaluator, syncFailedEvaluator } from './system-evaluators'

/**
 * 注册已交付的预警评估器：库存域 5 个、入仓差异、同步失败、授权失效（P2a-15），尺寸分段变化（P2b-06），
 * 结算差异、费用多收、赔付机会即将到期、异常退货率（P2b-16），高花费低产出、断货商品仍在投放、超预算、单次点击成本突增（P3-18），
 * 刊登问题新增、被搜索抑制、详情页被他人修改、失去推荐报价资格、价格健康异常、负面评论主题上升（P4-15），
 * 跟卖（我方 Listing 出现其他报价方）、促销叠加或折扣过深（P6-17），
 * 汇率获取失败、写入开关被自动关闭（P5-01），账户状态变化、账户健康指标未达标（P5-02），大量查看买家信息明文（P5-09）。
 * 评估器类型对应系统预置规则（api-contracts 的 ALERT_RULE_DEFS）里的 conditionJson.type。
 * 实时断货依赖亚马逊小时库存推送，接收端暂缓（14.10），没有对应评估器。
 */
export function registerPhase2aAlertEvaluators(registry: AlertEvaluatorRegistry): AlertEvaluatorRegistry {
  for (const evaluator of inventoryEvaluators()) registry.register(evaluator)
  return registry
    .register(inboundDiscrepancyEvaluator)
    .register(sizeTierChangeEvaluator)
    .register(settlementDiscrepancyEvaluator)
    .register(feeOverchargeEvaluator)
    .register(reimbursementDeadlineEvaluator)
    .register(abnormalReturnRateEvaluator)
    .register(adsLowReturnEvaluator)
    .register(adsStockoutEvaluator)
    .register(adsOutOfBudgetEvaluator)
    .register(adsCpcSurgeEvaluator)
    .register(newListingIssueEvaluator)
    .register(searchSuppressedEvaluator)
    .register(contentChangedByOthersEvaluator)
    .register(featuredOfferLostEvaluator)
    .register(priceHealthEvaluator)
    .register(hijackOfferEvaluator)
    .register(promoStackingEvaluator)
    .register(negativeTopicRisingEvaluator)
    .register(syncFailedEvaluator)
    .register(authExpiringEvaluator)
    .register(fxFailedEvaluator)
    .register(writeSwitchClosedEvaluator)
    .register(statusChangedEvaluator)
    .register(healthDeclineEvaluator)
    .register(piiBulkViewEvaluator)
    .register(customMetricEvaluator)
}

/** 后台任务入口用：新建注册表并登记各阶段已交付的评估器（后续阶段的评估器在这里继续追加）。 */
export const createAlertEvaluators = () => registerPhase2aAlertEvaluators(new AlertEvaluatorRegistry())
