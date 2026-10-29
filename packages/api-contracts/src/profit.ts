// 利润日表（P2b-09，07 章 7.9、10 章 10.1）的常量与类型。纯类型与常量，不含 zod：前端用到这里的东西不会把校验代码带进首屏。
// 利润日表由后台派生任务计算：店铺 × SKU × 日 × 收入确认口径，一行一个口径；金额统一折算成店铺币种（美元），不同币种之间从不直接相加。

export const PROFIT_READ = 'profit.read'
/** 当前版本的计算口径；任何公式、归类、取舍的变化都要升版本，历史行按旧版本保留到下次刷新。 */
export const PROFIT_METRIC_VERSION = 'p6-20@1'
/** 店铺级行的 SKU：没有 SKU 的费用（订阅费等）与没能分摊到商品的广告花费落在这一行（广告分摊见 worker 的 ads-allocation，P3-16）。 */
export const STORE_LEVEL_SKU = '__STORE__'
/** 利润日表的币种：当前只有美国站，店铺币种就是美元；别的币种的订单行、广告行不计入并打标记。 */
export const PROFIT_CURRENCY = 'USD'
/** 定时重算的天数（含今天）：汇率、成本版本、迟到的费用都会让近期的行变化。 */
export const PROFIT_RECENT_DAYS = 45
export const PROFIT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
export const PROFIT_DERIVE_TASK = 'profit_daily'

/** 三种收入确认口径并存：下单口径（订单创建日）、发货口径（订单发货日）、结算释放口径（财务交易已释放的入账日）。 */
export const PROFIT_BASES = ['ORDERED', 'SHIPPED', 'SETTLED'] as const
export type ProfitBasis = (typeof PROFIT_BASES)[number]
export const PROFIT_BASIS_LABEL: Readonly<Record<ProfitBasis, string>> = { ORDERED: '下单口径', SHIPPED: '发货口径', SETTLED: '结算释放口径' }
export const PROFIT_BASIS_NOTE: Readonly<Record<ProfitBasis, string>> = {
  ORDERED: '销售额与件数按订单创建日；费用按所属订单的创建日；退款与赔付按入账日。',
  SHIPPED: '销售额与件数按订单发货日；费用按所属订单的发货日；退款与赔付按入账日。',
  SETTLED: '只认已释放的交易：销售额、费用、退款与赔付都按财务交易的入账日；递延中的交易不计入。',
}

/** 三种存货计价：先进先出、移动加权平均、月末加权平均。 */
export const INVENTORY_COSTINGS = ['FIFO', 'MOVING_AVG', 'MONTH_AVG'] as const
export type InventoryCosting = (typeof INVENTORY_COSTINGS)[number]
export const INVENTORY_COSTING_LABEL: Readonly<Record<InventoryCosting, string>> = { FIFO: '先进先出', MOVING_AVG: '移动加权平均', MONTH_AVG: '月末加权平均' }
export const DEFAULT_INVENTORY_COSTING: InventoryCosting = 'FIFO'
/** 企业设置项（TenantSetting）的键：存货计价。取值不合法时按默认值计算并在派生结果里打标记。 */
export const INVENTORY_COSTING_SETTING = 'finance.inventoryCosting'

/** 利润桥的项目（顺序即 07 章 7.9 瀑布图的顺序）。 */
export const BRIDGE_KEYS = [
  'REVENUE',
  'REFUNDS',
  'COMMISSION',
  'FULFILLMENT',
  'STORAGE',
  'AGED_SURCHARGE',
  'INBOUND_PLACEMENT',
  'OTHER_FEES',
  'PROMOTION',
  'ADS',
  'PRODUCT_COST',
  'FIRST_MILE',
  'DUTY',
  'OTHER_COST',
  'REIMBURSEMENT',
  'FX_GAIN_LOSS',
  'NET_PROFIT',
] as const
export type BridgeKey = (typeof BRIDGE_KEYS)[number]
/** 利润桥项目对利润的方向：INCOME 加，COST 减，RESULT 是结果。 */
export type BridgeDirection = 'INCOME' | 'COST' | 'RESULT'
export const BRIDGE_DEFS: Readonly<Record<BridgeKey, { label: string; direction: BridgeDirection; group: 'SALES' | 'PLATFORM' | 'PROMO' | 'ADS' | 'COST' | 'OTHER' | 'RESULT' }>> = {
  REVENUE: { label: '销售额', direction: 'INCOME', group: 'SALES' },
  REFUNDS: { label: '退款', direction: 'COST', group: 'SALES' },
  COMMISSION: { label: '佣金', direction: 'COST', group: 'PLATFORM' },
  FULFILLMENT: { label: '配送费', direction: 'COST', group: 'PLATFORM' },
  STORAGE: { label: '仓储费', direction: 'COST', group: 'PLATFORM' },
  AGED_SURCHARGE: { label: '库龄附加费', direction: 'COST', group: 'PLATFORM' },
  INBOUND_PLACEMENT: { label: '入仓配置费', direction: 'COST', group: 'PLATFORM' },
  OTHER_FEES: { label: '其他平台费用', direction: 'COST', group: 'PLATFORM' },
  PROMOTION: { label: '促销费用', direction: 'COST', group: 'PROMO' },
  ADS: { label: '广告', direction: 'COST', group: 'ADS' },
  PRODUCT_COST: { label: '采购成本', direction: 'COST', group: 'COST' },
  FIRST_MILE: { label: '头程', direction: 'COST', group: 'COST' },
  DUTY: { label: '关税', direction: 'COST', group: 'COST' },
  OTHER_COST: { label: '其他成本', direction: 'COST', group: 'COST' },
  REIMBURSEMENT: { label: '赔付收入', direction: 'INCOME', group: 'OTHER' },
  FX_GAIN_LOSS: { label: '汇兑损益', direction: 'INCOME', group: 'OTHER' },
  NET_PROFIT: { label: '净利润', direction: 'RESULT', group: 'RESULT' },
}
/** 还没有数据来源的项目：汇兑损益需要采购付款日汇率（没有对接）；显示“尚未接入”，不显示 0。关税自 P6-18 起取自生效成本版本的单件关税，已接入。 */
export const BRIDGE_NOT_CONNECTED: readonly BridgeKey[] = ['FX_GAIN_LOSS']
/** 利润日表的列与利润桥项目的对应（净利润、广告在 buildBridge 里单独处理）。 */
export const BRIDGE_COLUMN: Readonly<Partial<Record<BridgeKey, keyof ProfitAmounts>>> = {
  REVENUE: 'revenue',
  REFUNDS: 'refunds',
  COMMISSION: 'feeCommission',
  FULFILLMENT: 'feeFulfillment',
  STORAGE: 'feeStorage',
  AGED_SURCHARGE: 'feeAged',
  INBOUND_PLACEMENT: 'feeInbound',
  OTHER_FEES: 'feeOther',
  PROMOTION: 'promotion',
  PRODUCT_COST: 'productCost',
  FIRST_MILE: 'firstMileCost',
  DUTY: 'dutyCost',
  OTHER_COST: 'otherCost',
  REIMBURSEMENT: 'reimbursement',
}

/** 一行利润日表的金额（店铺币种；费用、退款、促销、成本都是正数的“花费”，赔付是正数的“收入”）。null 表示这一项还没有数据，不是 0。 */
export interface ProfitAmounts {
  units: number
  costedUnits: number
  revenue: number
  refunds: number
  feeCommission: number
  feeFulfillment: number
  feeStorage: number
  feeAged: number
  feeInbound: number
  feeOther: number
  promotion: number
  adsSpendAllocated: number | null
  adsUnallocated: number | null
  productCost: number | null
  firstMileCost: number | null
  otherCost: number | null
  /** 关税（P6-18）：生效成本版本里的单件关税 × 件数；旧快照与旧行没有这一列，按“没有数据”处理。 */
  dutyCost?: number | null
  reimbursement: number
}

/** 数据质量标记：写在每行的 flags 里，利润分析页按标记汇总。WARN 表示数字不完整或带假设，INFO 表示口径说明。 */
export const PROFIT_FLAGS = {
  COST_MISSING: { label: '缺少成本', severity: 'WARN', note: '这一天卖出的件数里有没有成本的（没有生效的成本版本或采购入库记录），利润不计算。' },
  COST_LAYERS_EXHAUSTED: { label: '成本批次不够', severity: 'WARN', note: '卖出的件数超过已登记的入库批次，超出部分没有成本，利润不计算。' },
  COST_DRAFT_ONLY: { label: '成本仍是草稿', severity: 'WARN', note: '该 SKU 只有草稿状态的成本版本，需到商品成本页面生效后才计入。' },
  COST_PROVISIONAL: { label: '成本为暂估', severity: 'INFO', note: '月末加权平均在当月结束前会随入库变化，当月数字是暂估。' },
  COST_MIXED_CURRENCY: { label: '成本币种混用', severity: 'WARN', note: '加权平均不能跨币种，只用该 SKU 最早批次的币种，其余币种的批次未计入。' },
  COSTING_INVALID: { label: '存货计价设置无效', severity: 'WARN', note: '企业设置里的存货计价取值不合法，已按先进先出计算。' },
  FIRST_MILE_MISSING: { label: '头程成本缺失', severity: 'WARN', note: '部分件数没有头程成本（运单费用未分摊或未生效），利润未含这部分头程。' },
  FX_FALLBACK: { label: '汇率沿用前值', severity: 'INFO', note: '当天没有汇率，沿用了前一个有汇率的日子（最多 10 天）。' },
  FX_MISSING: { label: '汇率缺失', severity: 'WARN', note: '成本币种在当天及前 10 天内都没有汇率，这部分成本没有折算，利润不计算。' },
  FEES_PENDING: { label: '费用未入账', severity: 'WARN', note: '有销售额但还没有任何费用明细入账，利润可能偏高。' },
  FEES_UNLINKED_ORDER: { label: '费用关联不到订单', severity: 'INFO', note: '部分费用明细的订单还没同步，按入账日计入。' },
  DEFERRED_EXCLUDED: { label: '递延交易未计入', severity: 'INFO', note: '结算释放口径只认已释放的交易，递延中的明细没有计入。' },
  NON_USD_EXCLUDED: { label: '非美元数据未计入', severity: 'WARN', note: '有非美元的订单行或广告花费没有计入（利润日表目前只算美元）。' },
  SKU_UNKNOWN: { label: '缺少 SKU', severity: 'INFO', note: '部分金额没有 SKU，落在店铺级行。' },
  ADS_NOT_CONNECTED: { label: '广告尚未接入', severity: 'WARN', note: '这个店铺没有绑定广告账户，或还没有广告花费记录，利润未扣广告。' },
  ADS_UNALLOCATED: { label: '广告未分摊', severity: 'INFO', note: '这一天有广告花费没能分摊到商品（例如当天没有销售），留在店铺级行，没有分摊到 SKU。' },
  ADS_ATTRIBUTION_EXCEEDS: { label: '广告归属超出花费', severity: 'WARN', note: '广告商品报表里各商品的花费合计大于账户当天的总花费，归属金额已按比例缩小到总花费。' },
  ESTIMATE_INCLUDED: { label: '含估算', severity: 'INFO', note: '这一行含预估与自定义费用的估算金额（P6-20）：按企业录入的规则计入对应费用项；实际费用出账后，对应期间的估算自动冲销，不会重复计算。' },
  ADS_ASIN_UNMAPPED: { label: '广告商品对不上 SKU', severity: 'INFO', note: '广告商品报表里有的 ASIN 在商品目录里找不到对应 SKU，这部分花费并入剩余部分，按规则分摊。' },
} as const
export type ProfitFlag = keyof typeof PROFIT_FLAGS
export const PROFIT_FLAG_KEYS = Object.keys(PROFIT_FLAGS) as ProfitFlag[]
