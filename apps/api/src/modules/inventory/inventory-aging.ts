// 库龄分段与跨档时间线（06 章 6.1 库存详情第 7 页签）。纯函数在 @nova/api-contracts（inventory-age-math.ts）：
// 库存详情与后台任务的预警评估（P2a-15）共用同一份，这里只保留本模块原有的名字。
export {
  inventoryAgeCrossings as crossings,
  inventoryAgeFeeBands as ageFeeBands,
  inventoryAgeView as ageView,
  type InventoryAgeColumns as AgeColumns,
  type InventoryAgeFeeColumns as AgeFeeColumns,
  type InventoryAgeView as AgeView,
} from '@nova/api-contracts'
