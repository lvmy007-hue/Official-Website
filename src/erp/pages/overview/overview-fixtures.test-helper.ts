import type { Handler } from '../../test/app-harness'

// 经营控制台测试用的假服务端数据（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const PERIOD = { from: '2026-09-23', to: '2026-10-22', days: 30 }
export const COMPARE = { mode: 'previous', from: '2026-08-24', to: '2026-09-22', days: 30 }

const card = (key: string, label: string, format: string, drill: string, patch: Record<string, unknown> = {}) => ({
  key,
  label,
  state: 'NOT_CONNECTED',
  format,
  value: null,
  compareValue: null,
  change: null,
  changeKind: 'ratio',
  trend: null,
  note: `${label}尚未接入的原因`,
  drill,
  ...patch,
})

export const kpis = (patch: Record<string, unknown> = {}) => ({
  period: PERIOD,
  compare: COMPARE,
  defaulted: true,
  currency: 'USD',
  metricVersion: 'v1',
  salesSource: 'ORDERS',
  refreshedAt: '2026-10-22T07:00:00Z',
  cards: [
    card('sales', '销售额', 'money', 'OrdersPage', { state: 'OK', value: 12345.67, compareValue: 11000, change: 0.12, trend: [1, 2, 3], note: null }),
    card('profit', '净利润', 'money', 'ProfitPage'),
    card('margin', '利润率', 'percent', 'ProfitPage'),
    card('adsSpend', '广告花费', 'money', 'AdsConsolePage'),
    card('adsShare', '广告占总销售比', 'percent', 'AdsConsolePage'),
    card('stockRisk', '可售天数风险数', 'number', 'InventoryHealthPage'),
    card('anomalies', '待处理异常数', 'number', 'MyWorkItemsPage', { state: 'OK', value: 3, note: '严重 1 · 警告 1 · 提示 1' }),
  ],
  officialProfit: { state: 'NOT_CONNECTED', note: '官方净收益对照说明' },
  target: { state: 'NOT_CONNECTED', note: '目标与预算在 P2a-04 上线后接入' },
  anomalyBreakdown: { critical: 1, warning: 1, info: 1 },
  ...patch,
})

export const trend = (patch: Record<string, unknown> = {}) => ({
  period: PERIOD,
  compare: COMPARE,
  granularity: 'day',
  metric: 'sales',
  state: 'OK',
  note: null,
  unit: 'money',
  points: [
    { key: '2026-10-01', value: 100 },
    { key: '2026-10-02', value: null },
  ],
  previous: null,
  yoy: null,
  profit: { state: 'NOT_CONNECTED', note: '净利润尚未接入的原因', points: null },
  events: [],
  ...patch,
})

export const attribution = (patch: Record<string, unknown> = {}) => ({
  granularity: 'day',
  current: { from: '2026-10-01', to: '2026-10-01' },
  previous: { from: '2026-09-30', to: '2026-09-30' },
  state: 'OK',
  sales: { before: 80, after: 100 },
  mode: 'TWO_FACTOR',
  factors: [
    { key: 'units', label: '件数', before: 8, after: 10 },
    { key: 'unitPrice', label: '件单价', before: 10, after: 10 },
  ],
  unavailable: [{ key: 'sessions', label: '会话数', reason: '会话数据尚未接入' }],
  profitBridge: { state: 'NOT_CONNECTED', note: '利润桥尚未接入的原因' },
  ...patch,
})

export const storeCompare = {
  period: PERIOD,
  compare: COMPARE,
  rows: [
    { storeId: 'st1', storeName: 'Northstar US', sales: 800, compareSales: 600, salesChange: 1 / 3, profit: null, margin: null, adsShare: null },
    { storeId: 'st2', storeName: 'Oak & Pine', sales: 200, compareSales: 0, salesChange: null, profit: null, margin: null, adsShare: null },
  ],
  columns: { profit: 'NOT_CONNECTED', ads: 'NOT_CONNECTED', inventoryRisk: 'NOT_CONNECTED', accountHealth: 'NOT_CONNECTED' },
  notes: { profit: '店铺利润尚未接入', ads: null, inventoryRisk: '库存风险尚未接入', accountHealth: '账户健康尚未接入' },
}

const asin = (code: string, sales: number) => ({ asin: code, sku: `SKU-${code}`, units: 5, sales, profit: null, margin: null, profitChange: null, salesChange: null })
export const asinRank = (patch: Record<string, unknown> = {}) => ({
  period: PERIOD,
  compare: COMPARE,
  rankBy: 'sales',
  state: 'OK',
  note: null,
  top: [asin('B0AAAAAAA1', 500), asin('B0AAAAAAA2', 300)],
  bottom: [asin('B0AAAAAAA9', 10)],
  candidateLimit: null,
  ...patch,
})

export const volatility = (patch: Record<string, unknown> = {}) => ({
  period: PERIOD,
  previous: { from: '2026-09-14', to: '2026-10-13', days: 30 },
  earlier: { from: '2026-08-15', to: '2026-09-13', days: 30 },
  state: 'OK',
  note: null,
  rows: [{ asin: 'B0DOWNAAA1', sku: 'SKU-DOWN', sales: 40, previousSales: 80, earlierSales: 100, salesChange: -0.5, previousChange: -0.2, totalDrop: 60 }],
  candidateLimit: null,
  ...patch,
})

export const waterfall = {
  period: PERIOD,
  compare: COMPARE,
  state: 'OK',
  note: '与上一期相比',
  base: 600,
  current: 1000,
  total: 400,
  byStore: [{ key: 'st1', label: 'Northstar US', amount: 400, kind: 'store' }],
  byDriver: [
    { key: 'asin-1', label: 'B0AAAAAAA1', amount: 300, kind: 'asin' },
    { key: 'stockout', label: '断货损失', amount: null, kind: 'stockout', estimate: true, note: '库存规则引擎交付后估算' },
    { key: 'unattributed', label: '未归属 ASIN', amount: 100, kind: 'unattributed' },
  ],
}

export const cash = (patch: Record<string, unknown> = {}) => ({
  state: 'OK',
  note: null,
  period: PERIOD,
  released: 160,
  deferred: { amount: 390, asOf: '2026-10-21' },
  nextPayoutDate: '2026-10-28',
  nextPayoutNote: '来自亚马逊已公布的结算周期，实际到账以银行为准',
  ...patch,
})

export const workItem = {
  id: 'w1',
  title: '广告花费异常需要确认',
  source: 'ALERT',
  status: 'PENDING',
  severity: 'WARNING',
  dueAt: null,
  overdue: false,
  remainingMinutes: null,
  groupKey: 'LATER',
  entity: null,
  impact: null,
  suggestedAction: null,
  owner: { id: 'u1', name: '林然' },
  createdBy: { id: 'u1', name: '林然' },
  deferredUntil: null,
  closeConclusion: null,
  ignoreReason: null,
  version: 1,
}

export const baseHandlers = (): Record<string, Handler> => ({
  '/settings/integrations/summary': () => ok({ mode: 'READ_ONLY', enabledCount: 0, total: 8, emergencyForced: false }),
  '/notifications/unread-count': () => ok({ unreadCount: 0 }),
  '/onboarding': () => ok({ initialized: true, version: 2, completed: true, completedAt: '2026-10-20T10:00:00Z', currentStep: null, steps: [], tenant: {}, quotas: [], firstSync: null }),
  '/overview/source-health': () => ok({ asOf: '2026-10-22T08:00:00Z', storeCount: 2, rows: [], summary: { completeness: 1, attention: 0 } }),
  '/overview/kpis': () => ok(kpis()),
  '/overview/trend': () => ok(trend()),
  '/overview/attribution': () => ok(attribution()),
  '/overview/store-compare': () => ok(storeCompare),
  '/overview/asin-rank': () => ok(asinRank()),
  '/overview/volatility': () => ok(volatility()),
  '/overview/ad-anomalies': () => ok({ state: 'NOT_CONNECTED', note: '广告异常来自广告同步', workPackage: 'P3' }),
  '/overview/inventory-risk': () => ok({ state: 'NOT_CONNECTED', note: '库存风险来自规则引擎', workPackage: 'P2a-06' }),
  '/overview/growth-waterfall': () => ok(waterfall),
  '/overview/cash': () => ok(cash()),
  '/work-items': () => ok({ items: [workItem], pageInfo: { nextCursor: null, hasMore: false }, counts: null }),
  '/views': () => ok({ items: [], limit: 20 }),
})
