import {
  BRIDGE_DEFS,
  BRIDGE_KEYS,
  BRIDGE_NOT_CONNECTED,
  type BridgeKey,
  type ProfitAdsResponse,
  type ProfitBridgeCompareResponse,
  type ProfitBridgeView,
  type ProfitCoverageResponse,
  type ProfitGroupRow,
  type ProfitGroupsResponse,
  type ProfitOverviewResponse,
  type ProfitStoresResponse,
} from '@nova/api-contracts'

// 利润分析页面测试用的接口返回样例（只在测试里使用）。数值自洽：销售额 420，各项费用与成本加总后净利润 66（不含缺成本的行）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['orders.api', 'finance.transactions'], qualityIssues: 0 }
const range = { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false }
const common = {
  state: 'OK' as const,
  note: null,
  recognition: 'ORDERED' as const,
  basisLabel: '下单口径',
  basisNote: '销售额与件数按订单创建日；费用按所属订单的创建日；退款与赔付按入账日。',
  currency: 'USD',
  range,
  freshness,
}

/** 按给定金额生成利润桥：没给的项目是“尚无记录”，关税与汇兑损益是“尚未接入”。 */
export function bridge(values: Partial<Record<BridgeKey, number>>, netProfit: number | null, over: Partial<ProfitBridgeView> = {}): ProfitBridgeView {
  return {
    items: BRIDGE_KEYS.map(key => {
      const def = BRIDGE_DEFS[key]
      if (key === 'NET_PROFIT')
        return {
          key,
          label: def.label,
          direction: def.direction,
          value: netProfit,
          contribution: netProfit,
          state: netProfit === null ? ('NO_DATA' as const) : ('OK' as const),
          note: netProfit === null ? '有 1 行因缺少成本算不出利润' : null,
        }
      const value = values[key] ?? null
      const state = value !== null ? ('OK' as const) : BRIDGE_NOT_CONNECTED.includes(key) ? ('NOT_CONNECTED' as const) : ('NO_DATA' as const)
      const note = state === 'NOT_CONNECTED' ? `${def.label}尚未接入` : null
      return { key, label: def.label, direction: def.direction, value, contribution: value === null ? null : def.direction === 'COST' ? -value : value, state, note }
    }),
    netProfit,
    coveredProfit: 66,
    incompleteRows: netProfit === null ? 1 : 0,
    rows: 5,
    ...over,
  }
}

const VALUES: Partial<Record<BridgeKey, number>> = { REVENUE: 420, REFUNDS: 10, COMMISSION: 63, FULFILLMENT: 84, OTHER_FEES: 5, PRODUCT_COST: 100, FIRST_MILE: 15, ADS: 25 }

export const overview = (over: Partial<ProfitOverviewResponse> = {}): ProfitOverviewResponse => ({
  ...common,
  summary: { revenue: 420, units: 21, netProfit: null, margin: null, coveredProfit: 66, incompleteRows: 1, rows: 5, costCoverage: 17 / 21 },
  bridge: bridge(VALUES, null),
  trend: [
    { date: '2026-10-01', revenue: 280, profit: null, coveredProfit: 50 },
    { date: '2026-10-02', revenue: 100, profit: 30, coveredProfit: 30 },
  ],
  flags: [
    { flag: 'COST_MISSING', label: '缺少成本', severity: 'WARN', note: '这一天卖出的件数里有没有成本的，利润不计算。', rows: 1 },
    { flag: 'FX_FALLBACK', label: '汇率沿用前值', severity: 'INFO', note: '当天没有汇率，沿用了前一个有汇率的日子。', rows: 1 },
    { flag: 'COST_DRAFT_ONLY', label: '成本仍是草稿', severity: 'WARN', note: '只有草稿状态的成本版本。', rows: 0 },
  ],
  refreshedAt: '2026-10-23T08:30:00.000Z',
  metricVersion: 'p2b-09@1',
  notes: ['关税尚未接入，不计入净利润。', '汇兑损益尚未接入，不计入净利润。', '广告花费在店铺级，尚未分摊到商品。'],
  ...over,
})

export const emptyOverview = (): ProfitOverviewResponse =>
  overview({
    state: 'NO_DATA',
    note: '所选范围内尚无利润数据：店铺授权并完成订单与财务同步、利润日表计算后显示。',
    summary: { revenue: null, units: 0, netProfit: null, margin: null, coveredProfit: null, incompleteRows: 0, rows: 0, costCoverage: null },
    bridge: bridge({}, null, { coveredProfit: null, incompleteRows: 0, rows: 0 }),
    trend: [],
    flags: [],
    refreshedAt: null,
  })

export const stores = (): ProfitStoresResponse => ({
  ...common,
  items: [
    { sellerAccountId: 's1', storeName: '美国主店', units: 19, revenue: 380, netProfit: null, margin: null, bridge: bridge({ ...VALUES, REVENUE: 380 }, null) },
    { sellerAccountId: 's2', storeName: '欧洲店', units: 2, revenue: 40, netProfit: 16, margin: 0.4, bridge: bridge({ REVENUE: 40, COMMISSION: 6, FULFILLMENT: 8, PRODUCT_COST: 10 }, 16) },
    { sellerAccountId: 's3', storeName: '日本店', units: 0, revenue: null, netProfit: null, margin: null, bridge: bridge({}, null, { coveredProfit: null, incompleteRows: 0, rows: 0 }) },
  ],
})

const OFFICIAL = { state: 'NOT_CONNECTED' as const, note: '本表暂不并排对照官方单品经济；逐 SKU 逐日核对在“官方经济数据对账”页' }

export const groupRow = (over: Partial<ProfitGroupRow> = {}): ProfitGroupRow => ({
  key: 's1\u001fSKU-A',
  dimension: 'SKU',
  asin: 'B0A',
  sku: 'SKU-A',
  parentAsin: 'PARENT1',
  title: '商品 A',
  storeName: '美国主店',
  productId: 'prod-SKU-A',
  units: 15,
  revenue: 300,
  refunds: 10,
  fees: 105,
  promotion: 0,
  reimbursement: 0,
  adsAllocated: null,
  productCost: 90,
  firstMileCost: 15,
  otherCost: 0,
  costCoverage: 1,
  costDetail: [{ currency: 'CNY', rate: 7.2, source: 'MANUAL', fallbackRows: 1, productOriginal: 648, productConverted: 90, firstMileOriginal: 108, firstMileConverted: 15 }],
  profit: 80,
  margin: 80 / 300,
  incompleteRows: 0,
  rows: 2,
  perUnit: { revenue: 20, fees: 7, productCost: 6, profit: 80 / 15 },
  official: OFFICIAL,
  ...over,
})

export const asins = (over: Partial<ProfitGroupsResponse> = {}): ProfitGroupsResponse => ({
  ...common,
  dimension: 'SKU',
  items: [
    groupRow(),
    groupRow({
      key: 's1\u001fSKU-B',
      asin: 'B0B',
      sku: 'SKU-B',
      title: '商品 B',
      productId: 'prod-SKU-B',
      units: 4,
      revenue: 80,
      fees: 28,
      profit: null,
      margin: null,
      costCoverage: 0,
      incompleteRows: 1,
      rows: 1,
      costDetail: [],
    }),
  ],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  storeLevel: bridge({ OTHER_FEES: 5, ADS: 25 }, -30, { coveredProfit: -30, incompleteRows: 0, rows: 1 }),
  truncated: false,
  ...over,
})

export const ads = (over: Partial<ProfitAdsResponse> = {}): ProfitAdsResponse => ({
  ...common,
  allocation: { state: 'NOT_ALLOCATED', note: '范围内没有广告分摊结果：广告账户没有绑定店铺或还没有花费记录，所以商品行不扣广告。' },
  stores: [{ sellerAccountId: 's1', storeName: '美国主店', revenue: 380, adsSpend: 25, adsShare: 25 / 380, profitBeforeAds: null, netProfit: null }],
  items: [
    {
      key: 's1\u001fSKU-A',
      asin: 'B0A',
      sku: 'SKU-A',
      title: '商品 A',
      storeName: '美国主店',
      productId: 'prod-SKU-A',
      revenue: 300,
      adsAllocated: null,
      profitBeforeAds: 80,
      profit: 80,
      adsShare: null,
      verdict: 'NOT_ALLOCATED',
    },
    {
      key: 's1\u001fSKU-B',
      asin: 'B0B',
      sku: 'SKU-B',
      title: '商品 B',
      storeName: '美国主店',
      productId: 'prod-SKU-B',
      revenue: 80,
      adsAllocated: null,
      profitBeforeAds: null,
      profit: null,
      adsShare: null,
      verdict: 'NO_COST',
    },
  ],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  truncated: false,
  ...over,
})

export const coverage = (over: Partial<ProfitCoverageResponse> = {}): ProfitCoverageResponse => ({
  ...common,
  summary: { skus: 3, skusWithIssues: 2, staleSkus: 1, units: 21, costedUnits: 17, coverage: 17 / 21 },
  adsUnallocated: { state: 'OK', total: 25, stores: [{ sellerAccountId: 's1', storeName: '美国主店', amount: 25 }] },
  fx: { fallbackRows: 1, missingRows: 0, items: [{ currency: 'CNY', source: 'MANUAL', fallback: true, rows: 1, rate: 7.2 }] },
  items: [
    {
      key: 's1\u001fSKU-B',
      sellerAccountId: 's1',
      storeName: '美国主店',
      sku: 'SKU-B',
      asin: 'B0B',
      title: '商品 B',
      productId: 'prod-SKU-B',
      units: 4,
      costedUnits: 0,
      coverage: 0,
      issues: [{ issue: 'COST_MISSING', label: '缺少成本', rows: 1 }],
      latestCostEffective: null,
      costAgeDays: null,
    },
    {
      key: 's1\u001fSKU-A',
      sellerAccountId: 's1',
      storeName: '美国主店',
      sku: 'SKU-A',
      asin: 'B0A',
      title: '商品 A',
      productId: 'prod-SKU-A',
      units: 15,
      costedUnits: 15,
      coverage: 1,
      issues: [{ issue: 'COST_STALE', label: '成本版本过期', rows: 2 }],
      latestCostEffective: '2020-01-01',
      costAgeDays: 2486,
    },
  ],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  truncated: false,
  staleDays: 180,
  ...over,
})

const summary = (revenue: number, netProfit: number | null) => ({
  revenue,
  units: 10,
  netProfit,
  margin: netProfit === null ? null : netProfit / revenue,
  coveredProfit: netProfit,
  incompleteRows: netProfit === null ? 1 : 0,
  rows: 2,
})

export const compare = (over: Partial<ProfitBridgeCompareResponse> = {}): ProfitBridgeCompareResponse => ({
  ...common,
  baseRange: { from: '2026-09-21', to: '2026-09-30', days: 10, defaulted: false },
  compareMode: 'previous',
  base: summary(200, 55),
  current: summary(300, 95),
  rows: [
    { key: 'REVENUE', label: '销售额', direction: 'INCOME', state: 'OK', base: 200, current: 300, impact: 100 },
    { key: 'COMMISSION', label: '佣金', direction: 'COST', state: 'OK', base: 30, current: 60, impact: -30 },
    { key: 'PRODUCT_COST', label: '采购成本', direction: 'COST', state: 'OK', base: 60, current: 90, impact: -30 },
    { key: 'ADS', label: '广告', direction: 'COST', state: 'NO_DATA', base: null, current: 25, impact: null },
    { key: 'DUTY', label: '关税', direction: 'COST', state: 'NOT_CONNECTED', base: null, current: null, impact: null },
  ],
  netImpact: 40,
  unexplained: 0,
  ...over,
})
