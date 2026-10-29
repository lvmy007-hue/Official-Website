import { describe, expect, it } from 'vitest'
import { dayRangesOverlap, daysInMonthOf, estimateShare, feeCoversDay, fixedAmountOnDay, isDayText, isEstimatedFeeTarget, percentAmount, scopeText, valueText } from './estimated-fees.js'
import { EstimatedFeeCreateBodySchema, EstimatedFeeDeleteQuerySchema, EstimatedFeeUpdateBodySchema, EstimatedFeesQuerySchema } from './estimated-fees-query.js'
import { estimatedFeeExportCsv, estimatedFeeTemplateCsv, parseEstimatedFeeFile } from './estimated-fees-file.js'
import { FUNNEL_STAGE_KEYS, buildFunnelStages, payoutRateOf, reserveSummary } from './cashflow-funnel.js'

// 预估与自定义费用（P6-20）：日期与区间、固定金额按月平均、比例、请求校验、导入文件解析；回款漏斗纯函数。

const rule = { mode: 'FIXED', value: 300, period: 'MONTHLY', status: 'ACTIVE', from: '2026-02-01', to: '2026-02-28' } as const

describe('日期与区间', () => {
  it('日期文本要真实存在', () => {
    expect(isDayText('2026-02-28')).toBe(true)
    expect(isDayText('2026-02-30')).toBe(false)
    expect(isDayText('2026-2-1')).toBe(false)
  })
  it('当月天数含闰年', () => {
    expect(daysInMonthOf('2026-02-10')).toBe(28)
    expect(daysInMonthOf('2028-02-10')).toBe(29)
    expect(daysInMonthOf('2026-12-31')).toBe(31)
  })
  it('区间两端都含：首尾日有效、前后一天无效；停用无效；截止日为空表示长期', () => {
    expect(feeCoversDay(rule, '2026-02-01')).toBe(true)
    expect(feeCoversDay(rule, '2026-02-28')).toBe(true)
    expect(feeCoversDay(rule, '2026-01-31')).toBe(false)
    expect(feeCoversDay(rule, '2026-03-01')).toBe(false)
    expect(feeCoversDay({ ...rule, status: 'INACTIVE' }, '2026-02-10')).toBe(false)
    expect(feeCoversDay({ ...rule, to: null }, '2030-01-01')).toBe(true)
  })
  it('重叠判断：相邻不算重叠，共用一天算重叠，长期与任何之后的区间重叠', () => {
    expect(dayRangesOverlap({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: null })).toBe(false)
    expect(dayRangesOverlap({ from: '2026-01-01', to: '2026-02-01' }, { from: '2026-02-01', to: null })).toBe(true)
    expect(dayRangesOverlap({ from: '2026-01-01', to: null }, { from: '2030-01-01', to: '2030-02-01' })).toBe(true)
  })
})

describe('金额', () => {
  it('固定金额：按日是整额，按月按当月天数平均，比例规则返回 null', () => {
    expect(fixedAmountOnDay({ mode: 'FIXED', value: 10, period: 'DAILY' }, '2026-02-03')).toBe(10)
    expect(fixedAmountOnDay({ mode: 'FIXED', value: 280, period: 'MONTHLY' }, '2026-02-03')).toBe(10)
    expect(fixedAmountOnDay({ mode: 'PERCENT_OF_SALES', value: 5, period: 'DAILY' }, '2026-02-03')).toBeNull()
  })
  it('比例：销售额乘比例，没有销售额不估算', () => {
    expect(percentAmount({ value: 2.5 }, 200)).toBe(5)
    expect(percentAmount({ value: 2.5 }, 0)).toBe(0)
  })
  it('估算占比不超过 1，没有估算返回 null', () => {
    expect(estimateShare(25, 100)).toBe(0.25)
    expect(estimateShare(200, 100)).toBe(1)
    expect(estimateShare(0, 100)).toBeNull()
    expect(estimateShare(null, 100)).toBeNull()
  })
  it('文字展示', () => {
    expect(scopeText('STORE', 's1', '美国店')).toBe('店铺：美国店')
    expect(valueText('FIXED', 300, 'MONTHLY')).toBe('$300.00 / 月')
    expect(valueText('PERCENT_OF_SALES', 2.5, 'DAILY')).toBe('销售额的 2.5%')
  })
  it('只有花费类利润桥项目能挂预估', () => {
    expect(isEstimatedFeeTarget('PROMOTION')).toBe(true)
    expect(isEstimatedFeeTarget('REVENUE')).toBe(false)
    expect(isEstimatedFeeTarget(null)).toBe(false)
  })
})

const valid = { itemId: 'i1', scopeType: 'STORE', scopeId: 's1', mode: 'FIXED', value: 100, period: 'MONTHLY', from: '2026-01-01' }

describe('请求校验', () => {
  it('合法的新建通过，状态默认生效', () => {
    expect(EstimatedFeeCreateBodySchema.parse(valid).status).toBe('ACTIVE')
  })
  it('金额必须大于 0、比例不超过 100、截止日不早于起始日、不允许多余字段', () => {
    for (const bad of [{ value: 0 }, { value: -5 }, { mode: 'PERCENT_OF_SALES', value: 100.5 }, { to: '2025-12-31' }, { from: '2026-02-30' }, { extra: 1 }]) {
      expect(EstimatedFeeCreateBodySchema.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
    expect(EstimatedFeeCreateBodySchema.safeParse({ ...valid, mode: 'PERCENT_OF_SALES', value: 100 }).success).toBe(true)
  })
  it('修改必须带编号与版本；删除的版本走查询参数', () => {
    expect(EstimatedFeeUpdateBodySchema.safeParse(valid).success).toBe(false)
    expect(EstimatedFeeUpdateBodySchema.safeParse({ ...valid, id: 'e1', version: 2 }).success).toBe(true)
    expect(EstimatedFeeDeleteQuerySchema.safeParse({ id: 'e1', version: '3' }).data).toEqual({ id: 'e1', version: 3 })
    expect(EstimatedFeeDeleteQuerySchema.safeParse({ id: 'e1' }).success).toBe(false)
  })
  it('列表默认按起始日倒序，排序白名单外 422', () => {
    expect(EstimatedFeesQuerySchema.parse({}).sort).toEqual({ field: 'from', dir: 'desc' })
    expect(EstimatedFeesQuerySchema.safeParse({ sort: 'password:asc' }).success).toBe(false)
  })
})

describe('导入文件', () => {
  it('模板可以被解析器读懂', () => {
    const parsed = parseEstimatedFeeFile(estimatedFeeTemplateCsv())
    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toMatchObject({ itemName: '站外推广', scopeType: 'STORE', mode: 'FIXED', value: 300, period: 'MONTHLY', to: null, status: 'ACTIVE' })
    expect(parsed.rows[1]).toMatchObject({ scopeType: 'SKU', mode: 'PERCENT_OF_SALES', value: 2.5, to: '2026-06-30' })
  })
  it('任何一行有错整份不返回行，并指出行号', () => {
    const head = '费用项,范围,范围对象,方式,金额或比例,周期,起始日,截止日,状态,备注'
    const parsed = parseEstimatedFeeFile(`${head}\r\n推广,店铺,A,固定金额,10,按月,2026-01-01,,,\r\n推广,店铺,A,固定金额,-1,按月,2026-13-01,,,\r\n`)
    expect(parsed.rows).toEqual([])
    expect(parsed.errors.every(error => error.line === 3)).toBe(true)
    expect(parsed.errors.length).toBeGreaterThanOrEqual(2)
  })
  it('缺列、空文件、没有数据行都报错', () => {
    expect(parseEstimatedFeeFile('').errors).toHaveLength(1)
    expect(parseEstimatedFeeFile('费用项,范围\r\n').errors.some(error => error.message.includes('缺少'))).toBe(true)
    expect(parseEstimatedFeeFile('费用项,范围,范围对象,方式,金额或比例,周期,起始日\r\n').errors[0]?.message).toContain('没有数据行')
  })
  it('导出的文件可以直接再导入', () => {
    const csv = estimatedFeeExportCsv([
      { itemName: '站外推广', scopeType: 'SKU', scopeName: 'SKU,A', mode: 'PERCENT_OF_SALES', value: 3, period: 'DAILY', from: '2026-01-01', to: null, status: 'INACTIVE', note: '含"引号"' },
    ])
    const parsed = parseEstimatedFeeFile(csv)
    expect(parsed.errors).toEqual([])
    expect(parsed.rows[0]).toMatchObject({ scopeId: 'SKU,A', status: 'INACTIVE', note: '含"引号"', value: 3 })
  })
})

describe('回款漏斗纯函数', () => {
  it('回款率：已公布不大于 0 不给，其余四位小数', () => {
    expect(payoutRateOf(50, 0)).toBeNull()
    expect(payoutRateOf(2, 3)).toBe(0.6667)
  })
  it('预留金：没有财务数据是未接入，有财务但无预留金交易是无记录，都不是 0', () => {
    expect(reserveSummary([], false).state).toBe('NOT_CONNECTED')
    expect(reserveSummary([], true)).toMatchObject({ state: 'NONE', unreturned: null })
    expect(reserveSummary([-100, -50, 30], true)).toMatchObject({ state: 'OK', held: 150, returned: 30, unreturned: 120 })
    expect(reserveSummary([-10, 40], true).unreturned).toBe(0)
  })
  it('漏斗各级：没有来源是 null；应收 = 已公布 − 已到账', () => {
    const none = buildFunnelStages({ posted: null, released: null, deferred: null, announced: null, paid: null })
    expect(none.map(stage => stage.key)).toEqual([...FUNNEL_STAGE_KEYS])
    expect(none.every(stage => stage.amount === null)).toBe(true)
    const some = buildFunnelStages({
      posted: { amount: 1000, count: 9 },
      released: { amount: 700, count: 6 },
      deferred: { amount: 300, count: 3 },
      announced: { amount: 800, count: 4 },
      paid: { amount: 500, count: 3 },
    })
    expect(some.find(stage => stage.key === 'UPCOMING')).toMatchObject({ amount: 300, count: 1 })
  })
})
