export { ProfitModule } from './profit.module'
export { ProfitGroupsService } from './profit-groups.service'
// ASIN 360 商品页签（P2b-17）按一个商品取利润合计，口径与利润分析一致
export { loadTotals, loadTotalsByDate, loadSkuGroups, profitWhere, type SkuGroup } from './profit-load'
export { bridgeViewOf, coverageOf, marginOf, mergeTotals, type Totals } from './profit-aggregate'
