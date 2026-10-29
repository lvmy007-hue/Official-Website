export { InventoryModule } from './inventory.module'
export { InventoryHealthService } from './inventory-health.service'
export { InventoryService } from './inventory.service'
// 补货建议（P2a-07）复用库存口径：装配、规则引擎与差异解释都从这里取，不另起一套
export { diffReasons } from './inventory-advice'
// ASIN 360 的库存摘要与建议动作（P2a-14）直接用库存详情的概览，不另算一套
export { InventoryDetailService } from './inventory-detail.service'
export { InventoryItemService } from './inventory-item.service'
export { InventoryLoaderService } from './inventory-loader.service'
export { InventoryPolicyService } from './inventory-policy.service'
export { assess, countedInbound, daysBetween, plusDays, riskRank } from './inventory-rules'
// 带分隔符文件（CSV、制表符）的逐字符解析；头程运单的货代节点文件（P2a-11）复用
export { parseDelimited } from './capacity-import'
// 订单页（P2b-01）与库存页共用的数据新鲜度汇总：按来源键聚合范围内店铺的同步记录
export { sourceFreshness } from './inventory-freshness'
