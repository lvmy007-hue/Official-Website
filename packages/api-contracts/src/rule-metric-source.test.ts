import { describe, expect, it } from 'vitest'
import {
  RULE_READ_ROWS_PER_QUERY,
  RULE_SUPPORTED_METRICS,
  addDays,
  conditionValuesOf,
  dataPlan,
  evaluateConditions,
  isRuleMetricSupported,
  loadStoreMetricData,
  localDateOf,
  resolveRange,
  unsupportedRuleMetrics,
  type ConditionGroups,
  type RuleMetricReader,
  type StoreDayRow,
  type StoreMetricData,
} from './index.js'

const day = (date: string, sales: number, extra: Partial<StoreDayRow> = {}): StoreDayRow => ({
  date,
  orders: 1,
  units: 1,
  sales,
  adsSpend: null,
  adsSales: null,
  profit: null,
  sessions: null,
  ...extra,
})
const dataOf = (rows: StoreDayRow[]): StoreMetricData => ({ store: new Map(rows.map(row => [row.date, row])), traffic: new Map(), inventory: new Map() })
const one = (metric: string, window: ConditionGroups['groups'][number]['conditions'][number]['window'], op: '<' | '>', threshold: number, agg: 'sum' | 'avg' | 'last' = 'sum'): ConditionGroups => ({
  groups: [{ conditions: [{ metric, window, agg, op, threshold }] }],
})

describe('规则指标取数层（P6-16）', () => {
  it('日期：加减天、企业时区的今天、时区无效回退', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(localDateOf(new Date('2026-10-27T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-26')
    expect(localDateOf(new Date('2026-10-27T03:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-27')
    expect(localDateOf(new Date('2026-10-27T03:00:00Z'), 'Not/AZone')).toBe('2026-10-26')
  })

  it('窗口换算：今天、昨天、最近 N 天（到昨天）、本月累计、上月、环比、同比', () => {
    const today = '2026-10-27'
    expect(resolveRange({ kind: 'today' }, undefined, today)).toEqual({ start: today, end: today })
    expect(resolveRange({ kind: 'yesterday' }, undefined, today)).toEqual({ start: '2026-10-26', end: '2026-10-26' })
    expect(resolveRange({ kind: 'days', days: 3 }, undefined, today)).toEqual({ start: '2026-10-24', end: '2026-10-26' })
    expect(resolveRange({ kind: 'month_to_date' }, undefined, today)).toEqual({ start: '2026-10-01', end: '2026-10-26' })
    expect(resolveRange({ kind: 'month_to_date' }, undefined, '2026-10-01')).toBeNull()
    expect(resolveRange({ kind: 'last_month' }, undefined, today)).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(resolveRange({ kind: 'previous_period' }, { kind: 'days', days: 3 }, today)).toEqual({ start: '2026-10-21', end: '2026-10-23' })
    expect(resolveRange({ kind: 'same_period_last_year' }, { kind: 'days', days: 3 }, today)).toEqual({ start: '2025-10-24', end: '2025-10-26' })
    expect(resolveRange({ kind: 'same_period_last_year' }, { kind: 'last_month' }, '2028-03-15')).toEqual({ start: '2027-02-01', end: '2027-02-28' })
    expect(resolveRange({ kind: 'previous_period' }, undefined, today)).toBeNull()
  })

  it('支持的指标：登记表与未接入的指标', () => {
    expect(RULE_SUPPORTED_METRICS.length).toBeGreaterThan(10)
    expect(isRuleMetricSupported('M-001')).toBe(true)
    expect(isRuleMetricSupported('M-503')).toBe(false)
    expect(isRuleMetricSupported('toString')).toBe(false)
    expect(unsupportedRuleMetrics({ groups: [{ conditions: [{ metric: 'M-001' }, { metric: 'M-999' }, { metric: 'M-999' }] as never }] })).toEqual(['M-999'])
  })

  it('取值与判断：合计、平均、最新值；窗口里缺的天不算；全缺返回无数据', () => {
    const data = dataOf([day('2026-10-24', 10), day('2026-10-25', 20), day('2026-10-26', 30)])
    const today = '2026-10-27'
    const sum = conditionValuesOf(data, today)({ metric: 'M-001', window: { kind: 'days', days: 3 }, agg: 'sum' })
    expect(sum).toBe(60)
    expect(conditionValuesOf(data, today)({ metric: 'M-001', window: { kind: 'days', days: 3 }, agg: 'avg' })).toBe(20)
    expect(conditionValuesOf(data, today)({ metric: 'M-001', window: { kind: 'days', days: 3 }, agg: 'last' })).toBe(30)
    expect(conditionValuesOf(data, today)({ metric: 'M-001', window: { kind: 'days', days: 5 }, agg: 'sum' })).toBe(60)
    expect(conditionValuesOf(data, today)({ metric: 'M-001', window: { kind: 'yesterday' }, agg: 'sum' })).toBe(30)
    expect(conditionValuesOf(data, '2026-12-01')({ metric: 'M-001', window: { kind: 'days', days: 3 }, agg: 'sum' })).toBeNull()
    expect(conditionValuesOf(data, today)({ metric: 'M-999', window: { kind: 'yesterday' }, agg: 'sum' })).toBeNull()
    expect(evaluateConditions(one('M-001', { kind: 'days', days: 3 }, '<', 100), conditionValuesOf(data, today)).triggered).toBe(true)
    expect(evaluateConditions(one('M-001', { kind: 'days', days: 3 }, '<', 50), conditionValuesOf(data, today)).triggered).toBe(false)
  })

  it('比率类指标按日算比率再聚合；分母为 0 的天不算', () => {
    const data = dataOf([day('2026-10-25', 100, { adsSpend: 20, adsSales: 100 }), day('2026-10-26', 100, { adsSpend: 30, adsSales: 0 })])
    const value = conditionValuesOf(data, '2026-10-27')({ metric: 'M-501', window: { kind: 'days', days: 2 }, agg: 'avg' })
    expect(value).toBe(20)
  })

  it('批量读数：条件需要的来源才读；没有可取数的指标不读；店铺多时按每次 6000 行分批', async () => {
    const calls: Array<{ source: string; stores: number; from: string; to: string }> = []
    const reader: RuleMetricReader = {
      storeDays: async (_tenant, ids, from, to) => {
        calls.push({ source: 'store', stores: ids.length, from, to })
        return ids.map(id => ({ ...day('2026-10-26', 5), storeId: id }))
      },
      trafficDays: async (_tenant, ids, from, to) => {
        calls.push({ source: 'traffic', stores: ids.length, from, to })
        return []
      },
      inventoryDays: async (_tenant, ids, from, to) => {
        calls.push({ source: 'inventory', stores: ids.length, from, to })
        return []
      },
    }
    const ids = Array.from({ length: 50 }, (_, index) => `s${index}`)
    const groups = one('M-001', { kind: 'days', days: 365 }, '<', 1)
    expect(dataPlan(groups, ['2026-10-27'])).toMatchObject({ from: '2025-10-27', to: '2026-10-26' })
    const loaded = await loadStoreMetricData(reader, 't', ids, groups, ['2026-10-27'])
    expect(loaded.size).toBe(50)
    expect(loaded.get('s49')?.store.get('2026-10-26')?.sales).toBe(5)
    const chunk = Math.floor(RULE_READ_ROWS_PER_QUERY / 365)
    expect(calls.every(call => call.source === 'store' && call.stores <= chunk)).toBe(true)
    expect(calls.reduce((sum, call) => sum + call.stores, 0)).toBe(50)
    expect(calls.length).toBe(Math.ceil(50 / chunk))
    expect(chunk * 365).toBeLessThanOrEqual(RULE_READ_ROWS_PER_QUERY)

    calls.length = 0
    const empty = await loadStoreMetricData(reader, 't', ids, { groups: [{ conditions: [{ metric: 'M-999', window: { kind: 'yesterday' }, agg: 'sum', op: '<', threshold: 1 }] }] }, ['2026-10-27'])
    expect(calls).toHaveLength(0)
    expect(empty.get('s0')?.store.size).toBe(0)
  })
})
