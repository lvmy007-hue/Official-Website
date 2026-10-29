// 库存健康规则引擎（06 章 6.1“健康规则”；freeze/metrics.md M-210）。纯函数在 @nova/api-contracts（inventory-assess.ts）：
// 接口侧的库存健康页与后台任务的预警评估（P2a-15）共用同一份，这里只保留本模块原有的名字。
export {
  agingRiskOf as agingRisk,
  assessInventory as assess,
  computeInventoryDemand as computeDemand,
  countedInboundQty as countedInbound,
  inventoryRiskRank as riskRank,
  isoDaysBetween as daysBetween,
  isoPlusDays as plusDays,
  type AssessInput,
  type OrderWindows,
  type ReportSales,
} from '@nova/api-contracts'
