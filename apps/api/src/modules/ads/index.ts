export { AdsModule } from './ads.module'
export { AdsMetricsService } from './ads-metrics.service'
export { AdsService } from './ads.service'
// ASIN 360 的“广告”页签（P3-19）：商品模块只负责准入与找到商品，广告数据的读取与口径都在这里
export { AsinAdsTabService } from './ads-asin-tab.service'
// 父体分析的“广告覆盖”页签（P4-03）：各子体的广告花费、销售、订单与在投广告数
export { AsinAdsCoverageService, type AdsCoverageResult, type AsinAdsCoverage } from './ads-asin-coverage.service'
