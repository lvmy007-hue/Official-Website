export { OrdersModule } from './orders.module'
export { OrdersPiiSource } from './orders-pii-source'
// 退货页（P2b-02）与订单页共用的财务事实装配：退款、结算口径只在一处计算
export { ID_SET_LIMIT } from './orders-filters'
export { keyOf, loadOrderFacts, summarizeOrder, type FactRow, type OrderFacts } from './orders-facts'
