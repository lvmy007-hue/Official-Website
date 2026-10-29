export { ReplenishmentModule } from './replenishment.module'
// 头程物流（P2a-11）把实际时效回写成企业级补货策略的新版本，走同一个版本化入口
export { ReplenishmentPolicyService } from './replenishment-policy.service'
// 补货动作推出批次状态与去掉已被取代的登记动作的纯函数（P6-08 补货转入仓计划草稿用，不依赖补货模块的任何服务）
export { batchStatusOf, effectiveActions } from './replenishment-status'
