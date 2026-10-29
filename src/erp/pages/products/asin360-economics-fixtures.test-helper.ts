import type {
  Asin360CostsResponse,
  Asin360EconomicsResponse,
  Asin360IdentityResponse,
  Asin360OfficialResponse,
  Asin360PreviewResponse,
  Asin360ReturnsResponse,
  Asin360UnitLine,
} from '@nova/api-contracts'

// ASIN 360 利润与成本、退货页签的测试数据：数字与服务端真实数据库测试的种子一致（15 件、平均售价 20、每件净利润 5.666667）。

const freshness = { lastSuccessAt: '2026-10-22T02:00:00Z', sources: ['订单', '财务'], qualityIssues: 0 }

export const identityFixture = (): Asin360IdentityResponse => ({
  product: {
    id: 'p1',
    sellerAccountId: 's1',
    storeName: '店铺一',
    asin: 'B0TEST0001',
    sku: 'SKU-1',
    fnsku: 'X0TEST0001',
    title: '示例商品标题',
    brand: '示例品牌',
    productType: null,
    listingStatus: 'ACTIVE',
    fulfillmentChannel: 'AFN',
    price: 19.9,
    currency: 'USD',
    imageUrl: null,
    categoryPath: 'Home > Kitchen',
    parentAsin: null,
    ownerUserId: null,
    ownerName: null,
    tags: [],
  },
  catalog: { state: 'OK', syncedAt: '2026-10-22T02:00:00Z', note: null },
  siblings: [{ id: 'p1', sku: 'SKU-1', fnsku: 'X0TEST0001', listingStatus: 'ACTIVE' }],
  variants: { parentAsin: null, childCount: null, isParent: false, siblingCount: 1, variationTheme: null },
  ranks: { state: 'NO_DATA', note: '商品目录尚未同步', snapshotDate: null, items: [] },
  stock: { state: 'NO_DATA', note: null, inventoryId: null, sellable: null, inboundCounted: null, daysOfCover: null, stockoutDate: null, noDemand: false, riskLabel: null },
  freshness,
})

const line = (
  key: Asin360UnitLine['key'],
  label: string,
  direction: Asin360UnitLine['direction'],
  perUnit: number | null,
  link: Asin360UnitLine['link'],
  state: Asin360UnitLine['state'] = 'OK',
): Asin360UnitLine => ({
  key,
  label,
  direction,
  perUnit,
  state,
  link,
  contribution: perUnit === null ? null : direction === 'INCOME' ? perUnit : -perUnit,
})

const bridgeItem = (key: Asin360UnitLine['key'], label: string, direction: Asin360UnitLine['direction'], value: number | null, state: Asin360UnitLine['state'] = 'OK') => ({
  key,
  label,
  direction,
  value,
  contribution: value === null ? null : direction === 'INCOME' ? value : -value,
  state,
  note: null,
})

export const economicsFixture = (over: Partial<Asin360EconomicsResponse> = {}): Asin360EconomicsResponse => ({
  state: 'OK',
  note: null,
  recognition: 'ORDERED',
  basisLabel: '下单口径',
  basisNote: '按下单日期归集',
  currency: 'USD',
  range: { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false },
  bridge: {
    items: [
      bridgeItem('REVENUE', '销售额', 'INCOME', 300),
      bridgeItem('COMMISSION', '平台佣金', 'COST', 45),
      bridgeItem('PRODUCT_COST', '商品成本', 'COST', 75),
      bridgeItem('ADS', '广告费', 'COST', null, 'NO_DATA'),
    ],
    netProfit: 85,
    coveredProfit: 85,
    incompleteRows: 0,
    rows: 2,
  },
  unit: {
    state: 'OK',
    note: null,
    units: 15,
    avgPrice: 20,
    netPerUnit: 5.666667,
    proportionalShare: 0.216667,
    lines: [
      line('REVENUE', '销售额', 'INCOME', 20, 'PRICE'),
      line('COMMISSION', '平台佣金', 'COST', 3, 'PROPORTIONAL'),
      line('PRODUCT_COST', '商品成本', 'COST', 5, 'FIXED'),
      line('ADS', '广告费', 'COST', null, 'FIXED', 'NO_DATA'),
    ],
  },
  trend: [
    { date: '2026-10-01', revenue: 200, profit: 50, coveredProfit: 50 },
    { date: '2026-10-02', revenue: 100, profit: 35, coveredProfit: 35 },
  ],
  listPrice: 19.9,
  winPrice: { state: 'NOT_CONNECTED', note: '推荐报价与预期获胜价来自定价数据，在“定价与购物车”页签上线后接入' },
  costCoverage: 1,
  notes: ['店铺级费用与账户级广告不含在内'],
  freshness,
  ...over,
})

const NO_SIDE = { sales: null, fees: null, ads: null, cost: null, netProceeds: null }

export const officialFixture = (over: Partial<Asin360OfficialResponse> = {}): Asin360OfficialResponse => ({
  state: 'NO_DATA',
  note: '这个商品在所选范围内没有官方单品经济记录',
  recognition: 'ORDERED',
  basisLabel: '下单口径',
  currency: 'USD',
  range: { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false },
  summary: {
    rows: 0,
    comparable: 0,
    matched: 0,
    notComparable: 0,
    official: NO_SIDE,
    ours: NO_SIDE,
    netDiff: null,
    byClass: { COST: { amount: 0, rows: 0 }, ADS: { amount: 0, rows: 0 }, TIME: { amount: 0, rows: 0 }, UNEXPLAINED: { amount: 0, rows: 0 } },
  },
  items: [],
  officialCoverage: null,
  truncated: false,
  notes: [],
  freshness,
  ...over,
})

export const previewFixture = (over: Partial<Asin360PreviewResponse> = {}): Asin360PreviewResponse => ({
  state: 'NO_DATA',
  note: '官方最近一次费用预览里没有这个 SKU',
  currency: 'USD',
  queriedAt: null,
  horizon: null,
  summary: { products: 0, rows: 0, changedRows: 0, unknownRows: 0, totalImpact: null, byFeeType: [] },
  items: [],
  notes: [],
  freshness,
  ...over,
})

export const costsFixture = (over: Partial<Asin360CostsResponse> = {}): Asin360CostsResponse =>
  ({ state: 'NO_DATA', note: '这个 SKU 还没有任何成本版本', sku: 'SKU-1', today: '2026-10-23', row: null, versions: [], versionsTruncated: false, notes: [], ...over }) as Asin360CostsResponse

const disposition = (group: 'SELLABLE' | 'CARRIER_DAMAGED', label: string) => ({ group, label, sellable: group === 'SELLABLE', raw: null })

export const returnsFixture = (over: Partial<Asin360ReturnsResponse> = {}): Asin360ReturnsResponse => ({
  state: 'OK',
  note: null,
  range: { from: '2026-07-25', to: '2026-10-22', defaulted: true },
  bucket: 'WEEK',
  totals: { returnedUnits: 3, soldUnits: 30, rate: 0.1 },
  trend: [{ bucket: '2026-10-19', returnedUnits: 3, soldUnits: 30, rate: 0.1 }],
  reasons: [
    { reason: 'DEFECTIVE', label: '商品有缺陷', units: 2, share: 0.6667 },
    { reason: 'UNSPECIFIED', label: '未提供原因', units: 1, share: 0.3333 },
  ],
  dispositions: [
    { group: 'CARRIER_DAMAGED', label: '承运人损坏', units: 2, share: 0.6667 },
    { group: 'SELLABLE', label: '可售', units: 1, share: 0.3333 },
  ],
  recent: [
    { id: 'r1', returnDate: '2026-10-20T00:00:00Z', amazonOrderId: '111-r1', sku: 'SKU-1', quantity: 2, reasonLabel: '商品有缺陷', disposition: disposition('CARRIER_DAMAGED', '承运人损坏') },
    { id: 'r2', returnDate: '2026-10-18T00:00:00Z', amazonOrderId: '111-r2', sku: 'SKU-1B', quantity: 1, reasonLabel: null, disposition: disposition('SELLABLE', '可售') },
  ],
  reimbursements: {
    state: 'OK',
    note: null,
    items: [
      {
        id: 'opp-1',
        ruleCode: 'RETURN_DISPOSITION',
        ruleLabel: '退货处置异常',
        status: 'CASE_CREATED',
        statusLabel: '已立案',
        estimatedAmount: 24.5,
        currency: 'USD',
        deadlineAt: null,
        qty: 2,
        caseId: 'case-1',
        caseNo: 'RC-1',
        caseStatusLabel: '已提交',
        receivedAmount: null,
      },
    ],
  },
  categoryThemes: { state: 'NOT_CONNECTED', note: '类目的退货主题来自亚马逊客户反馈接口，在评价与反馈模块上线后接入' },
  truncated: false,
  basis: '退货按店铺 × ASIN 统计，退货率的分母是同期销售件数',
  freshness,
  ...over,
})
