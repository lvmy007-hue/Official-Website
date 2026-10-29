import type {
  DryRunResponse,
  GuardrailView,
  PriceSimulationResponse,
  PricingDetailResponse,
  PricingListResponse,
  PricingRow,
  PricingRuleView,
  PricingWriteStatus,
  PricingWriteStatuses,
  RuleRunView,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok, runView } from '../listings/listing-quality-fixtures.test-helper'

// 定价页测试用的假服务端数据（只在测试里使用）。

export { ok, runView }

const GOOD: PricingWriteStatus = { allowed: true, step: null, reason: null, remedyPath: null }
export const writeOk: PricingWriteStatuses = { validate: GOOD, update: GOOD, rule: GOOD }
const freshness = { lastSuccessAt: '2026-10-24T06:00:00Z', sources: ['定价接口'], qualityIssues: 0 } as PricingListResponse['freshness']

export const priceRow = (patch: Partial<PricingRow> = {}): PricingRow => ({
  id: 'st1|SKU-1',
  storeId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  title: '玻璃保鲜盒套装',
  imageUrl: null,
  price: 24.99,
  currency: 'USD',
  priceObservedAt: '2026-10-24T06:00:00Z',
  lowestPrice: 22.5,
  featured: { price: 23.5, ownIsFeatured: false, fulfillment: 'AFN' },
  expectedPrice: 23.99,
  expectedStatus: 'ABOVE_EXPECTED',
  gap: 1,
  buyBoxPct: 0.62,
  viewWeight: { member: null, nonMember: null },
  health: 'ABOVE_EXPECTED',
  healthLabel: '价格高于预期获胜价',
  lastChange: { at: '2026-10-20T08:00:00Z', from: 26.99, to: 24.99 },
  margin: { state: 'OK', note: null, atCurrent: 0.21, atExpected: 0.17 },
  limits: { minPrice: 20, maxPrice: null, minMarginPct: 0.1, maxChangePct: 0.1 },
  ...patch,
})

export const noPriceRow = (): PricingRow =>
  priceRow({
    id: 'st1|SKU-2',
    sku: 'SKU-2',
    asin: '',
    title: '没有价格记录的商品',
    price: null,
    priceObservedAt: null,
    lowestPrice: null,
    featured: { price: null, ownIsFeatured: null, fulfillment: null },
    expectedPrice: null,
    expectedStatus: null,
    gap: null,
    buyBoxPct: null,
    health: 'UNKNOWN',
    healthLabel: '尚无记录',
    lastChange: null,
    margin: { state: 'NO_DATA', note: '缺少成本', atCurrent: null, atExpected: null },
    limits: null,
  })

export const listResponse = (patch: Partial<PricingListResponse> = {}): PricingListResponse => ({
  state: 'OK',
  note: null,
  items: [priceRow(), noPriceRow()],
  pageInfo: { hasMore: false, nextCursor: null, approxTotal: 2 } as PricingListResponse['pageInfo'],
  summary: {
    total: 2,
    health: [
      { state: 'WINNING', label: '已获得推荐报价', count: 0 },
      { state: 'ABOVE_EXPECTED', label: '价格高于预期获胜价', count: 1 },
      { state: 'UNKNOWN', label: '尚无记录', count: 1 },
    ],
    withPrice: 1,
    withoutPrice: 1,
  },
  currency: 'USD',
  stores: [{ id: 'st1', name: 'Northstar US' }],
  write: writeOk,
  marginBasis: '利润率是估算。',
  truncated: false,
  freshness,
  basis: '价格每 2 小时同步。',
  ...patch,
})

export const guardrail = (patch: Partial<GuardrailView> = {}): GuardrailView => ({
  id: 'g1',
  storeId: 'st1',
  storeName: 'Northstar US',
  scope: 'STORE',
  scopeRef: '',
  minPrice: 20,
  maxPrice: null,
  minMarginPct: 0.1,
  maxChangePct: 0.1,
  enabled: true,
  version: 2,
  updatedAt: '2026-10-23T08:00:00Z',
  ...patch,
})

export const ruleView = (patch: Partial<PricingRuleView> = {}): PricingRuleView => ({
  id: 'rule1',
  storeId: 'st1',
  storeName: 'Northstar US',
  name: '跟随预期价',
  mode: 'MANUAL',
  modeLabel: '手动（只生成建议）',
  strategy: 'FOLLOW_EXPECTED',
  strategyLabel: '跟随推荐报价预期价格',
  params: { offsetPct: 0 },
  paramsText: '与预期价格持平',
  scope: { all: true, skus: [], asins: [] },
  scopeText: '全部商品',
  status: 'ACTIVE',
  statusLabel: '启用中',
  maxChangePct: 0.05,
  dailyLimit: 1,
  breaker: { failureStreak: 3, conversionDropPct: 0.3, minMarginPct: null },
  scenarioMatrix: null,
  scenarioText: null,
  breakerReason: null,
  lastEvaluatedAt: '2026-10-24T06:10:00Z',
  autoReady: false,
  autoNote: null,
  version: 3,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-23T00:00:00Z',
  pendingSuggestions: 1,
  ...patch,
})

export const ruleRun = (patch: Partial<RuleRunView> = {}): RuleRunView => ({
  id: 'rr1',
  ruleId: 'rule1',
  ruleName: '跟随预期价',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  currentPrice: 24.99,
  rawPrice: 23.99,
  suggestedPrice: 23.99,
  guardrailResult: 'PASS',
  guardrailText: '通过护栏',
  outcome: 'SUGGESTED',
  outcomeLabel: '待确认的建议',
  message: null,
  writeRunId: null,
  runAt: '2026-10-24T06:10:00Z',
  compare: null,
  ...patch,
})

export const dryRunResponse = (): DryRunResponse => ({
  ruleId: 'rule1',
  days: 7,
  daily: [{ date: '2026-10-23', evaluated: 5, hits: 2, blocked: 1 }],
  current: [{ sku: 'SKU-1', asin: 'B0TEST0001', currentPrice: 24.99, rawPrice: 23.99, suggestedPrice: 23.99, guardrailResult: 'PASS', guardrailText: '通过护栏', hit: true }],
  evaluated: 5,
  note: '试运行不会改价。',
  basis: '逐日按当天结束时的数据模拟。',
})

export const simulation = (patch: Partial<PriceSimulationResponse> = {}): PriceSimulationResponse => ({
  state: 'OK',
  note: null,
  price: 22.99,
  currentPrice: 24.99,
  net: 4.2,
  margin: 0.18,
  deltaNet: -1.1,
  breakEvenPrice: 18.4,
  expectedPrice: 23.99,
  reachesExpected: true,
  guardrail: { ok: true, violations: [] },
  elasticity: { state: 'INSUFFICIENT', value: null, samples: 3, note: '价格变动样本不足，不给价格弹性' },
  projection: { state: 'UNAVAILABLE', note: '弹性样本不足，不做销量预测', unitsPerDay: null, profitPerDay: null, baselineUnitsPerDay: 4 },
  basis: '估算口径。',
  ...patch,
})

export const detailResponse = (patch: Partial<PricingDetailResponse> = {}): PricingDetailResponse => ({
  row: priceRow(),
  history: {
    state: 'OK',
    note: null,
    points: [
      { at: '2026-10-20T08:00:00Z', ownPrice: 26.99, featuredPrice: 24, lowestPrice: 23, expectedPrice: 24.5 },
      { at: '2026-10-24T06:00:00Z', ownPrice: 24.99, featuredPrice: 23.5, lowestPrice: 22.5, expectedPrice: 23.99 },
    ],
  },
  offers: {
    state: 'OK',
    note: null,
    observedAt: '2026-10-24T06:00:00Z',
    rows: [
      { offerKey: 'own', isOwn: true, isFeatured: false, price: 24.99, shipping: 0, condition: '全新', fulfillment: 'FBA' },
      { offerKey: 'other', isOwn: false, isFeatured: true, price: 23.5, shipping: 0, condition: '全新', fulfillment: 'FBA' },
    ],
  },
  events: [{ at: '2026-10-20T08:00:00Z', kind: 'PRICE_CHANGE', title: '价格从 $26.99 变为 $24.99', detail: null }],
  adjustments: [
    {
      runId: 'w1',
      at: '2026-10-20T08:00:00Z',
      source: 'MANUAL',
      sourceLabel: '手工调价',
      from: 26.99,
      to: 24.99,
      status: 'SUCCEEDED',
      statusLabel: '已完成',
      by: '林然',
      compare: {
        state: 'OK',
        note: null,
        before: { days: 7, unitsPerDay: 3.5, sessions: 700, conversionPct: 0.1, buyBoxPct: 0.5 },
        after: { days: 4, unitsPerDay: 4.5, sessions: 650, conversionPct: 0.12, buyBoxPct: 0.62 },
      },
    },
  ],
  limits: { minPrice: 20, maxPrice: null, minMarginPct: 0.1, maxChangePct: 0.1 },
  guardrails: [guardrail()],
  pendingRuns: [ruleRun()],
  write: writeOk,
  basis: '价格数据说明。',
  freshness,
  ...patch,
})

/** 列表页的服务端：列表、护栏、规则；extra 覆盖或追加。 */
export const pricingHandlers = (response: () => PricingListResponse, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/pricing': () => ok(response()),
  '/pricing/guardrails': () => ok({ items: [guardrail()], truncated: false }),
  '/pricing/rules': () => ok({ items: [ruleView()], truncated: false }),
  '/listings/runs/r1': () => ok(runView({ kind: 'VALIDATE', usableUntil: '2026-10-24T08:30:00Z' })),
  ...extra,
})
