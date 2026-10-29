import { registerEconomicsDaily } from './economics-daily'
import { registerEconomicsPreview } from './economics-preview'
import { registerEconomicsSimulation } from './economics-simulation'
import { registerSalesTraffic } from './sales-traffic'

/** 登记全部数据中心数据集（进程启动时调一次；重复登记会报错）。 */
export function registerDataKioskDatasets() {
  registerEconomicsSimulation() // P2a-07：补货页的上游仓储模拟；P2b-11 起也服务官方经济数据对账页的情景模拟
  registerEconomicsDaily() // P2b-11：官方单品经济（按天、按 MSKU）
  registerEconomicsPreview() // P2b-11：官方费用预览（未来 120 天）
  registerSalesTraffic() // P4-01：销售与流量（按日期、按 ASIN、趋势），需要品牌分析角色
}
