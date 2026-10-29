import { describe, expect, it } from 'vitest'
import { CHECK_KEYS, type BasisSnapshot, type CostSnapshot, type FxSnapshot, type ProfitSnapshot } from './periods.js'
import {
  buildChecklist,
  earliestMonth,
  evaluateAds,
  evaluateCostCoverage,
  evaluateFx,
  evaluateRecon,
  evaluateSettlements,
  evaluateSync,
  monthPeriodOf,
  needlessAcknowledgements,
  periodActionsOf,
  periodEnded,
  statusAfterCheck,
  statusAfterReject,
  type CheckEval,
} from './periods-math.js'
import { PeriodApproveBodySchema, PeriodCheckBodySchema, PeriodCreateBodySchema, PeriodReopenBodySchema } from './periods-query.js'
import { diffSnapshots, previewOf, snapSkuOf, snapTotalsOf, type SnapshotBundle } from './periods-snapshot.js'
import { PROFIT_BASES } from './profit.js'

const pass: CheckEval = { baseState: 'PASS', summary: 'ok', details: [], value: 0 }
const allPass = () => Object.fromEntries(CHECK_KEYS.map(key => [key, pass])) as Record<(typeof CHECK_KEYS)[number], CheckEval>
const now = new Date('2026-10-05T00:00:00Z')

describe('自然月', () => {
  it('起止日与闰年', () => {
    expect(monthPeriodOf('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(monthPeriodOf('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(monthPeriodOf('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' })
    expect(monthPeriodOf('2026-13')).toBeNull()
    expect(monthPeriodOf('2026-9')).toBeNull()
  })
  it('必须已结束；最早月份', () => {
    expect(periodEnded('2026-09-30', '2026-10-01')).toBe(true)
    expect(periodEnded('2026-10-31', '2026-10-23')).toBe(false)
    expect(earliestMonth('2026-10-23', 5)).toBe('2021-10')
  })
})

describe('检查项判定', () => {
  const end = new Date('2026-10-01T00:00:00Z')
  it('同步：没有记录、故障、没覆盖到期间结束都不通过', () => {
    const facts = [
      { key: 'a', label: '订单', status: 'NORMAL', coveredThrough: new Date('2026-10-02T00:00:00Z') },
      { key: 'b', label: '财务交易', status: 'NORMAL', coveredThrough: new Date('2026-10-02T00:00:00Z') },
    ]
    expect(evaluateSync(facts, end).baseState).toBe('PASS')
    expect(evaluateSync([{ ...facts[0]!, status: null, coveredThrough: null }], end).details[0]).toContain('尚无同步记录')
    expect(evaluateSync([{ ...facts[0]!, status: 'FAILED' }], end).baseState).toBe('FAIL')
    expect(evaluateSync([{ ...facts[0]!, coveredThrough: new Date('2026-09-30T00:00:00Z') }], end).details[0]).toContain('没有覆盖到期间结束')
    expect(evaluateSync([{ ...facts[0]!, status: 'NOT_APPLICABLE', coveredThrough: null }], end).baseState).toBe('PASS')
  })
  it('结算：没有结算单、没覆盖到期末、报告未到', () => {
    expect(evaluateSettlements([], '2026-09-30').baseState).toBe('FAIL')
    expect(evaluateSettlements([{ externalSettlementId: 'S1', endDate: '2026-09-28', txnCount: 5 }], '2026-09-30').details[0]).toContain('最晚只到 2026-09-28')
    expect(evaluateSettlements([{ externalSettlementId: 'S1', endDate: '2026-10-05', txnCount: 0 }], '2026-09-30').details[0]).toContain('尚未到达')
    expect(evaluateSettlements([{ externalSettlementId: 'S1', endDate: '2026-10-05', txnCount: 9 }], '2026-09-30').baseState).toBe('PASS')
  })
  it('成本覆盖：边界、没有数据、没有销量', () => {
    expect(evaluateCostCoverage({ rows: 0, units: 0, costedUnits: 0 }).baseState).toBe('FAIL')
    expect(evaluateCostCoverage({ rows: 3, units: 0, costedUnits: 0 }).baseState).toBe('PASS')
    expect(evaluateCostCoverage({ rows: 3, units: 100, costedUnits: 95 }).baseState).toBe('PASS')
    expect(evaluateCostCoverage({ rows: 3, units: 100, costedUnits: 94 }).baseState).toBe('FAIL')
  })
  it('汇率：缺失不通过，沿用前值只提示', () => {
    expect(evaluateFx({ missingRows: 0, fallbackRows: 2, currencies: ['CNY'], missingDays: [{ currency: 'CNY', days: [] }] })).toMatchObject({ baseState: 'PASS' })
    expect(evaluateFx({ missingRows: 0, fallbackRows: 2, currencies: ['CNY'], missingDays: [] }).details).toHaveLength(1)
    expect(evaluateFx({ missingRows: 1, fallbackRows: 0, currencies: ['CNY'], missingDays: [{ currency: 'CNY', days: ['2026-09-03'] }] }).baseState).toBe('FAIL')
  })
  it('广告：未接入、未分摊、通过', () => {
    expect(evaluateAds({ rows: 4, allocatedRows: 0, unallocated: 12 }).baseState).toBe('NOT_CONNECTED')
    expect(evaluateAds({ rows: 4, allocatedRows: 4, unallocated: 3 }).baseState).toBe('FAIL')
    expect(evaluateAds({ rows: 4, allocatedRows: 4, unallocated: 0.01 }).baseState).toBe('PASS')
  })
  it('对账异常', () => {
    expect(evaluateRecon({ open: 0, absTotal: null }).baseState).toBe('PASS')
    expect(evaluateRecon({ open: 2, absTotal: 10.5 }).summary).toContain('10.50')
  })
})

describe('检查清单与确认放行', () => {
  const fail = (value: number): CheckEval => ({ baseState: 'FAIL', summary: 'x', details: [], value })
  it('全部通过；确认放行后视为通过', () => {
    expect(buildChecklist(allPass(), null, [], 'u1', now).passed).toBe(true)
    const evals = { ...allPass(), RECON_EXCEPTIONS: fail(2), ADS_ALLOCATED: { ...fail(0), baseState: 'NOT_CONNECTED' as const, value: null } }
    expect(buildChecklist(evals, null, [], 'u1', now).passed).toBe(false)
    const acked = buildChecklist(
      evals,
      null,
      [
        { key: 'RECON_EXCEPTIONS', note: '已与财务确认' },
        { key: 'ADS_ALLOCATED', note: '广告未接入' },
      ],
      'u1',
      now,
    )
    expect(acked.passed).toBe(true)
    expect(acked.items.find(item => item.key === 'RECON_EXCEPTIONS')).toMatchObject({ state: 'ACKNOWLEDGED', baseState: 'FAIL' })
  })
  it('数字没变沿用上次确认；数字变了确认失效', () => {
    const first = buildChecklist({ ...allPass(), RECON_EXCEPTIONS: fail(2) }, null, [{ key: 'RECON_EXCEPTIONS', note: '接受' }], 'u1', now)
    expect(buildChecklist({ ...allPass(), RECON_EXCEPTIONS: fail(2) }, first, [], 'u2', now).passed).toBe(true)
    expect(buildChecklist({ ...allPass(), RECON_EXCEPTIONS: fail(3) }, first, [], 'u2', now).passed).toBe(false)
  })
  it('只有两项可以确认放行；本来通过的确认是多余的', () => {
    const evals = { ...allPass(), COST_COVERAGE: fail(0.5) }
    expect(buildChecklist(evals, null, [], 'u1', now).items.find(item => item.key === 'COST_COVERAGE')?.acknowledgeable).toBe(false)
    expect(needlessAcknowledgements(allPass(), [{ key: 'RECON_EXCEPTIONS', note: '多余' }])).toEqual(['RECON_EXCEPTIONS'])
  })
  it('检查后与驳回后的状态', () => {
    expect(statusAfterCheck(true, 0)).toBe('CLOSING')
    expect(statusAfterCheck(false, 0)).toBe('OPEN')
    expect(statusAfterCheck(false, 2)).toBe('REOPENED')
    expect(statusAfterReject(0)).toBe('OPEN')
    expect(statusAfterReject(1)).toBe('REOPENED')
  })
})

describe('可用动作', () => {
  const base = { status: 'CLOSING' as const, approvalDecision: null, checkedBy: 'u1', userId: 'u2', canClose: true, canReopen: false }
  it('审批人不能是发起检查的人', () => {
    expect(periodActionsOf(base).approve.allowed).toBe(true)
    expect(periodActionsOf({ ...base, userId: 'u1' }).approve).toMatchObject({ allowed: false })
  })
  it('锁定必须先审批；已关账只能重新开账', () => {
    expect(periodActionsOf(base).close.allowed).toBe(false)
    expect(periodActionsOf({ ...base, approvalDecision: 'APPROVED' }).close.allowed).toBe(true)
    const closed = periodActionsOf({ ...base, status: 'CLOSED', canReopen: true })
    expect(closed.check.allowed).toBe(false)
    expect(closed.reopen.allowed).toBe(true)
  })
  it('没有权限给出原因', () => {
    expect(periodActionsOf({ ...base, canClose: false }).check.reason).toContain('finance.period.close')
    expect(periodActionsOf({ ...base, status: 'CLOSED' }).reopen.reason).toContain('finance.period.reopen')
  })
})

describe('请求校验', () => {
  it('创建：月份格式', () => {
    expect(PeriodCreateBodySchema.safeParse({ sellerAccountId: 's1', month: '2026-09' }).success).toBe(true)
    expect(PeriodCreateBodySchema.safeParse({ sellerAccountId: 's1', month: '2026-9' }).success).toBe(false)
    expect(PeriodCreateBodySchema.safeParse({ sellerAccountId: 's1', month: '1999-12' }).success).toBe(false)
    expect(PeriodCreateBodySchema.safeParse({ sellerAccountId: 's1', month: '2026-09', extra: 1 }).success).toBe(false)
  })
  it('检查：确认要写原因、不能重复', () => {
    expect(PeriodCheckBodySchema.safeParse({}).success).toBe(true)
    expect(PeriodCheckBodySchema.safeParse({ acknowledgements: [{ key: 'RECON_EXCEPTIONS', note: '' }] }).success).toBe(false)
    expect(PeriodCheckBodySchema.safeParse({ acknowledgements: [{ key: 'COST_COVERAGE', note: '随便写' }] }).success).toBe(false)
    const twice = { key: 'RECON_EXCEPTIONS', note: '接受差异' }
    expect(PeriodCheckBodySchema.safeParse({ acknowledgements: [twice, twice] }).success).toBe(false)
  })
  it('审批驳回必须写意见；重开必须写原因', () => {
    expect(PeriodApproveBodySchema.safeParse({ version: 1, decision: 'REJECTED' }).success).toBe(false)
    expect(PeriodApproveBodySchema.safeParse({ version: 1, decision: 'REJECTED', comment: '成本不对' }).success).toBe(true)
    expect(PeriodApproveBodySchema.safeParse({ version: 1, decision: 'APPROVED' }).success).toBe(true)
    expect(PeriodReopenBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(PeriodReopenBodySchema.safeParse({ version: 1, reason: '补录一笔费用' }).success).toBe(true)
  })
})

// ---- 快照 ----

const totalsOf = (revenue: number, profit: number | null, rows = 1) => snapTotalsOf({ revenue, profit, units: 10, costedUnits: 10, productCost: 4, feeCommission: 1 }, rows, profit === null ? 1 : 0)
const basisOf = (revenue: number, profit: number | null, skus: Array<[string, number, number | null]>): BasisSnapshot => ({
  totals: totalsOf(revenue, profit),
  skus: skus.map(([sku, rev, prof]) => snapSkuOf({ sku, asin: null }, { revenue: rev, profit: prof, units: 1, costedUnits: 1 }, prof === null ? 1 : 0)),
  skuCount: skus.length,
  truncated: false,
})
const profitOf = (basis: BasisSnapshot): ProfitSnapshot => ({
  version: 1,
  metricVersions: [],
  from: '2026-09-01',
  to: '2026-09-30',
  bases: Object.fromEntries(PROFIT_BASES.map(item => [item, basis])) as ProfitSnapshot['bases'],
})
const fxOf = (rate: number): FxSnapshot => ({
  from: '2026-09-01',
  to: '2026-09-30',
  currencies: ['CNY'],
  rates: [{ quote: 'CNY', date: '2026-09-01', rate, source: 'ECB', fallback: false, manual: false }],
})
const costsOf = (productCost: number): CostSnapshot => ({
  asOf: '2026-10-01',
  skuCount: 1,
  truncated: false,
  versions: [{ sku: 'A', versionNo: 1, status: 'ACTIVE', effectiveFrom: '2026-01-01', currency: 'CNY', productCost, firstMileCost: 1, otherCost: null }],
})
const bundle = (basis: BasisSnapshot, rate = 7.1, cost = 20): SnapshotBundle => ({ profit: profitOf(basis), fx: fxOf(rate), costs: costsOf(cost) })

describe('快照汇总与预览', () => {
  it('合计：缺成本的行让净利润没有数；可空列全空才是 null', () => {
    expect(totalsOf(100, 30).profit).toBe(30)
    expect(totalsOf(100, null).profit).toBeNull()
    expect(snapTotalsOf({}, 0, 0).profit).toBeNull()
    expect(snapTotalsOf({ revenue: 5 }, 1, 0).productCost).toBeNull()
  })
  it('SKU 汇总：费用合成一列；广告都空是 null', () => {
    const sku = snapSkuOf({ sku: 'A', asin: 'B0' }, { feeCommission: 1, feeStorage: 2, adsSpendAllocated: 3, adsUnallocated: 1 }, 0)
    expect(sku).toMatchObject({ fees: 3, ads: 4 })
    expect(snapSkuOf({ sku: 'A', asin: null }, {}, 0).ads).toBeNull()
  })
  it('预览：没有成本权限隐藏三项成本；没有数据就是无数据', () => {
    const snapshot = profitOf(basisOf(100, 30, [['A', 100, 30]]))
    const open = previewOf(snapshot, true, 'LIVE', null, null)
    expect(open.state).toBe('OK')
    expect(open.bases[0]!.items.find(item => item.key === 'PRODUCT_COST')).toMatchObject({ value: 4, state: 'OK' })
    const restricted = previewOf(snapshot, false, 'LIVE', null, null)
    expect(restricted.bases[0]!.items.find(item => item.key === 'PRODUCT_COST')).toMatchObject({ value: null, state: 'RESTRICTED' })
    expect(restricted.bases[0]!.items.find(item => item.key === 'REVENUE')?.value).toBe(100)
    const empty: BasisSnapshot = { totals: snapTotalsOf({}, 0, 0), skus: [], skuCount: 0, truncated: false }
    expect(previewOf(profitOf(empty), true, 'LIVE', null, null).state).toBe('NO_DATA')
  })
})

describe('差异报告', () => {
  it('没有变化', () => {
    const one = bundle(basisOf(100, 30, [['A', 100, 30]]))
    expect(diffSnapshots(one, one).hasChanges).toBe(false)
  })
  it('利润桥、净利润、SKU 新增/删除/变化、汇率、成本版本', () => {
    const before = bundle(
      basisOf(100, 30, [
        ['A', 100, 30],
        ['B', 50, 10],
      ]),
    )
    const after = bundle(
      basisOf(120, 25, [
        ['A', 110, 20],
        ['C', 10, 5],
      ]),
      7.2,
      22,
    )
    const diff = diffSnapshots(before, after)
    expect(diff.hasChanges).toBe(true)
    const ordered = diff.bases[0]!
    expect(ordered.netProfit).toMatchObject({ before: 30, after: 25, delta: -5 })
    expect(ordered.items.find(item => item.key === 'REVENUE')).toMatchObject({ before: 100, after: 120, delta: 20 })
    expect(ordered).toMatchObject({ skuChanged: 1, skuAdded: 1, skuRemoved: 1 })
    expect(ordered.skus[0]!.sku).toBe('B')
    expect(diff.fx).toMatchObject({ changed: 1, added: 0, removed: 0 })
    expect(diff.costVersions).toMatchObject({ changed: 1 })
  })
  it('利润从有数变成没有数也算变化', () => {
    const diff = diffSnapshots(bundle(basisOf(100, 30, [['A', 100, 30]])), bundle(basisOf(100, null, [['A', 100, null]])))
    expect(diff.hasChanges).toBe(true)
    expect(diff.bases[0]!.netProfit.delta).toBeNull()
  })
})
