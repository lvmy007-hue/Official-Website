// 补货模块的服务按职责拆成多个文件（模块边界检查要求每个领域模块有 *.service.ts 入口）：
// policy（三级策略与版本）、loader（数据装配）、compute（重算产出批次）、read（建议与批次读取）、action（采纳与草稿）、
// evaluate（结果回看）、simulate（库存走势与上游仓储经济模拟）、sku（库存详情页签）。
export { ReplenishmentActionService } from './replenishment-action.service'
export { ReplenishmentComputeService } from './replenishment-compute.service'
export { ReplenishmentEvaluateService } from './replenishment-evaluate.service'
export { ReplenishmentPolicyService } from './replenishment-policy.service'
export { ReplenishmentReadService } from './replenishment-read.service'
export { ReplenishmentSimulateService } from './replenishment-simulate.service'
export { ReplenishmentSkuService } from './replenishment-sku.service'
