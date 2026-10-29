import { describe, expect, it } from 'vitest'
import { ADS_RULE_EXECUTION_PENDING, ADS_RULE_LEVEL_ACTIONS, ADS_RULE_METRICS, type AdsRuleDay, type AdsRuleSpec, type AdsRuleSubject } from './ads-rules'
import { conditionHolds, defaultAsOf, evaluateRule, matchesFilters, metricValue, proposeChange, shiftDate, windowTotals } from './ads-rules-math'
import { AdsRuleBodySchema, AdsRuleDryRunBodySchema, AdsRuleRunsQuerySchema, AdsRuleUpdateBodySchema } from './ads-rules-query'
import { describeAction, describeCondition, describeGuardrails, describeRuleSpec, effectPairOf, formatRuleValue, ruleDueOf, ruleSpecIssues, summarizeEffect } from './ads-rules-text'

const AS_OF = '2026-10-20'
const day = (date: string, patch: Partial<AdsRuleDay> = {}): AdsRuleDay => ({ date, impressions: 1000, clicks: 20, spend: 10, sales: 40, orders: 2, ...patch })
const days = (count: number, patch: Partial<AdsRuleDay> = {}): AdsRuleDay[] => Array.from({ length: count }, (_, index) => day(shiftDate(AS_OF, -index), patch))
const subject = (patch: Partial<AdsRuleSubject> = {}): AdsRuleSubject => ({ key: 'k1', label: '词一', campaignLabel: '活动 A', state: 'ENABLED', bid: 1, budget: 20, daily: days(7), ...patch })
const spec = (patch: Partial<AdsRuleSpec> = {}): AdsRuleSpec => ({
  level: 'TARGET',
  conditions: [{ metric: 'spend', windowDays: 7, op: 'gte', value: 50 }],
  textFilters: [],
  campaignIds: [],
  action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -20 },
  guardrails: { minValue: 0.1, maxValue: 5, maxChangePercent: 30, dailyLimit: 10 },
  ...patch,
})

describe('自动规则：日期与窗口合计', () => {
  it('日期加减不受时区影响，默认截止日是昨天', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(defaultAsOf('2026-10-21')).toBe('2026-10-20')
  })

  it('窗口含截止日、往前数 N 天；窗口之外的行不算；花费或销售额全空保持空', () => {
    const rows = [...days(10), day('2026-10-21', { spend: 999 })]
    expect(windowTotals(rows, AS_OF, 3)).toMatchObject({ rows: 3, spend: 30, sales: 120, orders: 6, clicks: 60 })
    expect(windowTotals(rows, AS_OF, 7).spend).toBe(70)
    expect(windowTotals(days(3, { spend: null, sales: null }), AS_OF, 7)).toMatchObject({ rows: 3, spend: null, sales: null })
    expect(windowTotals([], AS_OF, 7).rows).toBe(0)
    const mixed = [day(AS_OF, { spend: null }), day(shiftDate(AS_OF, -1), { spend: 5 })]
    expect(windowTotals(mixed, AS_OF, 3).spend).toBe(5)
  })
})

describe('自动规则：指标与条件', () => {
  const totals = windowTotals(days(7), AS_OF, 7)
  it('10 个指标的单位：百分数、倍数与金额', () => {
    expect(ADS_RULE_METRICS).toHaveLength(10)
    expect(metricValue('spend', totals)).toBe(70)
    expect(metricValue('acos', totals)).toBeCloseTo(25, 6)
    expect(metricValue('cpc', totals)).toBeCloseTo(0.5, 6)
    expect(metricValue('ctr', totals)).toBeCloseTo(2, 6)
    expect(metricValue('cvr', totals)).toBeCloseTo(10, 6)
    expect(metricValue('roas', totals)).toBeCloseTo(4, 6)
    expect(metricValue('orders', totals)).toBe(14)
  })

  it('没有记录或分母为 0 时是 null，不是 0；条件遇到 null 一律不成立', () => {
    expect(metricValue('spend', windowTotals([], AS_OF, 7))).toBeNull()
    expect(metricValue('acos', windowTotals(days(3, { sales: 0 }), AS_OF, 3))).toBeNull()
    expect(metricValue('cpc', windowTotals(days(3, { clicks: 0 }), AS_OF, 3))).toBeNull()
    expect(metricValue('ctr', windowTotals(days(3, { impressions: 0 }), AS_OF, 3))).toBeNull()
    expect(metricValue('roas', windowTotals(days(3, { spend: 0 }), AS_OF, 3))).toBeNull()
    expect(metricValue('acos', windowTotals(days(3, { sales: null }), AS_OF, 3))).toBeNull()
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) expect(conditionHolds(op, null, 5)).toBe(false)
    // 订单是 0 是真实的 0，能参与比较
    expect(metricValue('orders', windowTotals(days(3, { orders: 0 }), AS_OF, 3))).toBe(0)
    expect(conditionHolds('lte', 0, 0)).toBe(true)
  })

  it('四种比较在边界上的行为', () => {
    expect(conditionHolds('gt', 5, 5)).toBe(false)
    expect(conditionHolds('gte', 5, 5)).toBe(true)
    expect(conditionHolds('lt', 5, 5)).toBe(false)
    expect(conditionHolds('lte', 5, 5)).toBe(true)
  })
})

describe('自动规则：文本过滤', () => {
  it('包含与不包含，不分大小写；所属活动未知时“包含”不成立、“不包含”成立', () => {
    const s = subject({ label: 'Garden Hose', campaignLabel: '品牌词活动' })
    expect(matchesFilters(s, [{ field: 'NAME', mode: 'CONTAINS', text: 'hose' }])).toBe(true)
    expect(matchesFilters(s, [{ field: 'NAME', mode: 'NOT_CONTAINS', text: 'HOSE' }])).toBe(false)
    expect(matchesFilters(s, [{ field: 'CAMPAIGN_NAME', mode: 'CONTAINS', text: '品牌' }])).toBe(true)
    expect(
      matchesFilters(s, [
        { field: 'NAME', mode: 'CONTAINS', text: 'hose' },
        { field: 'CAMPAIGN_NAME', mode: 'NOT_CONTAINS', text: '品牌' },
      ]),
    ).toBe(false)
    const unknown = subject({ campaignLabel: null })
    expect(matchesFilters(unknown, [{ field: 'CAMPAIGN_NAME', mode: 'CONTAINS', text: 'x' }])).toBe(false)
    expect(matchesFilters(unknown, [{ field: 'CAMPAIGN_NAME', mode: 'NOT_CONTAINS', text: 'x' }])).toBe(true)
    expect(matchesFilters(s, [])).toBe(true)
  })
})

describe('自动规则：动作与护栏', () => {
  it('调价：按百分比计算，超出单次幅度上限收窄，再受最低与最高值限制，并写明原因', () => {
    const base = spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: 50 }, guardrails: { minValue: null, maxValue: null, maxChangePercent: 30, dailyLimit: 5 } })
    expect(proposeChange(base, subject({ bid: 1 }))).toEqual({ ok: true, before: '1.00', after: '1.30', notes: ['超出单次调整幅度上限 30%，已收窄'] })
    const capped = spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: 20 }, guardrails: { minValue: null, maxValue: 1.1, maxChangePercent: 50, dailyLimit: 5 } })
    expect(proposeChange(capped, subject({ bid: 1 }))).toMatchObject({ ok: true, after: '1.10', notes: ['超出最高竞价 $1.10，已收窄'] })
    const floored = spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -40 }, guardrails: { minValue: 0.8, maxValue: null, maxChangePercent: 50, dailyLimit: 5 } })
    expect(proposeChange(floored, subject({ bid: 1 }))).toMatchObject({ ok: true, after: '0.80', notes: ['低于最低竞价 $0.80，已抬高'] })
    const amount = spec({ action: { type: 'ADJUST_BID', mode: 'AMOUNT', value: -0.1 }, guardrails: { minValue: null, maxValue: null, maxChangePercent: 50, dailyLimit: 5 } })
    expect(proposeChange(amount, subject({ bid: 1 }))).toMatchObject({ ok: true, before: '1.00', after: '0.90' })
  })

  it('调价：只动启用中的对象；缺当前值不猜；护栏压成没变化或方向冲突都说明原因', () => {
    const down = spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -20 } })
    expect(proposeChange(down, subject({ state: 'PAUSED' }))).toMatchObject({ ok: false, reason: expect.stringContaining('只有启用中的对象') })
    expect(proposeChange(down, subject({ bid: null }))).toMatchObject({ ok: false, reason: expect.stringContaining('还没有同步下来') })
    const atFloor = spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -20 }, guardrails: { minValue: 1, maxValue: null, maxChangePercent: 50, dailyLimit: 5 } })
    expect(proposeChange(atFloor, subject({ bid: 1 }))).toMatchObject({ ok: false, reason: expect.stringContaining('没有需要调整') })
    const above = spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: 10 }, guardrails: { minValue: null, maxValue: 2, maxChangePercent: 50, dailyLimit: 5 } })
    expect(proposeChange(above, subject({ bid: 3 }))).toMatchObject({ ok: false, reason: expect.stringContaining('越过护栏范围') })
  })

  it('预算：同样适用护栏，文字写“日预算”', () => {
    const budget = spec({ level: 'CAMPAIGN', action: { type: 'ADJUST_BUDGET', mode: 'PERCENT', value: 10 }, guardrails: { minValue: null, maxValue: 21, maxChangePercent: 20, dailyLimit: 5 } })
    expect(proposeChange(budget, subject({ budget: 20 }))).toEqual({ ok: true, before: '20.00', after: '21.00', notes: ['超出最高日预算 $21.00，已收窄'] })
    const noBudget = proposeChange(budget, subject({ budget: null }))
    expect(noBudget).toMatchObject({ ok: false, reason: expect.stringContaining('日预算') })
  })

  it('暂停与启用只对对应状态有意义', () => {
    const pause = spec({ level: 'CAMPAIGN', action: { type: 'PAUSE' } })
    expect(proposeChange(pause, subject({ state: 'ENABLED' }))).toEqual({ ok: true, before: 'ENABLED', after: 'PAUSED', notes: [] })
    expect(proposeChange(pause, subject({ state: 'PAUSED' }))).toMatchObject({ ok: false })
    expect(proposeChange(pause, subject({ state: null }))).toMatchObject({ ok: false, reason: expect.stringContaining('未知') })
    const enable = spec({ level: 'CAMPAIGN', action: { type: 'ENABLE' } })
    expect(proposeChange(enable, subject({ state: 'PAUSED' }))).toMatchObject({ ok: true, before: 'PAUSED', after: 'ENABLED' })
    expect(proposeChange(enable, subject({ state: 'ENABLED' }))).toMatchObject({ ok: false })
  })

  it('搜索词：未投放才能否定或加词，已投放与已否定各有说明', () => {
    const negate = spec({ level: 'SEARCH_TERM', action: { type: 'NEGATE', matchType: 'NEGATIVE_EXACT' }, guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 } })
    expect(proposeChange(negate, subject({ state: 'UNTARGETED' }))).toEqual({ ok: true, before: 'UNTARGETED', after: 'NEGATIVE_EXACT', notes: [] })
    expect(proposeChange(negate, subject({ state: 'NEGATED' }))).toMatchObject({ reason: '这个搜索词已经被否定' })
    expect(proposeChange(negate, subject({ state: 'TARGETED' }))).toMatchObject({ reason: expect.stringContaining('已经是投放词') })
    const add = spec({ level: 'SEARCH_TERM', action: { type: 'ADD_KEYWORD', matchType: 'EXACT', bid: 1.2 }, guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 } })
    expect(proposeChange(add, subject({ state: 'UNTARGETED' }))).toMatchObject({ ok: true, after: 'EXACT@1.20' })
    expect(proposeChange(add, subject({ state: 'NEGATED' }))).toMatchObject({ ok: false })
    expect(proposeChange(add, subject({ state: 'TARGETED' }))).toMatchObject({ ok: false })
  })
})

describe('自动规则：整条规则评估', () => {
  it('全部条件同时满足才命中（AND）；缺数据的对象不命中；命中按花费从高到低', () => {
    const rule = spec({
      conditions: [
        { metric: 'spend', windowDays: 7, op: 'gte', value: 50 },
        { metric: 'acos', windowDays: 7, op: 'gt', value: 20 },
      ],
    })
    const result = evaluateRule(
      rule,
      [
        subject({ key: 'a', daily: days(7, { spend: 10, sales: 40 }) }),
        subject({ key: 'b', daily: days(7, { spend: 20, sales: 40 }) }),
        subject({ key: 'c', daily: days(7, { spend: 10, sales: 100 }) }),
        subject({ key: 'd', daily: [] }),
        subject({ key: 'e', daily: days(7, { spend: 20, sales: null }) }),
      ],
      AS_OF,
    )
    expect(result.evaluated).toBe(5)
    expect(result.matched).toBe(2)
    expect(result.hits.map(hit => hit.key)).toEqual(['b', 'a'])
    expect(result.hits[0]).toMatchObject({ actionType: 'ADJUST_BID', before: '1.00', after: '0.80', spend: 140 })
    expect(result.hits[0].metrics).toEqual({ 'spend:7': 140, 'acos:7': 50 })
    expect(result.skipped).toEqual([])
  })

  it('文本过滤先收窄候选；命中但不能动作的进跳过清单并计入命中', () => {
    const rule = spec({ textFilters: [{ field: 'NAME', mode: 'NOT_CONTAINS', text: '品牌' }], conditions: [{ metric: 'orders', windowDays: 3, op: 'gte', value: 1 }] })
    const result = evaluateRule(rule, [subject({ key: 'a', label: '品牌词' }), subject({ key: 'b', label: '通用词' }), subject({ key: 'c', label: '另一个词', state: 'PAUSED' })], AS_OF)
    expect(result.evaluated).toBe(2)
    expect(result.matched).toBe(2)
    expect(result.hits.map(hit => hit.key)).toEqual(['b'])
    expect(result.skipped).toEqual([{ key: 'c', label: '另一个词', reason: expect.stringContaining('只有启用中的对象') }])
  })

  it('没有任何对象时评估数为 0；花费为空的命中排在有花费的后面', () => {
    expect(evaluateRule(spec(), [], AS_OF)).toEqual({ evaluated: 0, matched: 0, hits: [], skipped: [] })
    const rule = spec({ conditions: [{ metric: 'clicks', windowDays: 7, op: 'gte', value: 1 }] })
    const result = evaluateRule(rule, [subject({ key: 'z', daily: days(7, { spend: null }) }), subject({ key: 'y', daily: days(7) })], AS_OF)
    expect(result.hits.map(hit => hit.key)).toEqual(['y', 'z'])
    expect(result.hits[1].spend).toBeNull()
  })
})

describe('自动规则：规则内容校验与摘要', () => {
  it('每个层级只能做对应的动作', () => {
    expect(ADS_RULE_LEVEL_ACTIONS.CAMPAIGN).toEqual(['PAUSE', 'ENABLE', 'ADJUST_BUDGET'])
    expect(ruleSpecIssues(spec())).toBeNull()
    expect(ruleSpecIssues(spec({ level: 'CAMPAIGN' }))).toContain('不适用于活动')
    expect(ruleSpecIssues(spec({ level: 'SEARCH_TERM', action: { type: 'PAUSE' }, guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 } }))).toContain('不适用于搜索词')
  })

  it('调整类动作必须有单次幅度上限，幅度不能是 0 或超范围；其他动作不能带幅度上限与最低最高值', () => {
    const guard = (patch: Partial<AdsRuleSpec['guardrails']>) => ({ minValue: null, maxValue: null, maxChangePercent: 30, dailyLimit: 5, ...patch })
    expect(ruleSpecIssues(spec({ guardrails: guard({ maxChangePercent: null }) }))).toContain('单次调整幅度上限')
    expect(ruleSpecIssues(spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: 0 } }))).toContain('不能是 0')
    expect(ruleSpecIssues(spec({ action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -95 } }))).toContain('之间')
    expect(ruleSpecIssues(spec({ action: { type: 'ADJUST_BID', mode: 'AMOUNT', value: 1001 } }))).toContain('不能超过')
    expect(ruleSpecIssues(spec({ guardrails: guard({ minValue: 3, maxValue: 2 }) }))).toContain('最低值不能高于最高值')
    expect(ruleSpecIssues(spec({ guardrails: guard({ dailyLimit: 0 }) }))).toContain('每日执行次数上限')
    expect(ruleSpecIssues(spec({ guardrails: guard({ dailyLimit: 201 }) }))).toContain('每日执行次数上限')
    const pause = (patch: Partial<AdsRuleSpec['guardrails']>) => spec({ action: { type: 'PAUSE' }, guardrails: guard({ maxChangePercent: null, ...patch }) })
    expect(ruleSpecIssues(pause({}))).toBeNull()
    expect(ruleSpecIssues(pause({ maxChangePercent: 10 }))).toContain('只用于调整')
    expect(ruleSpecIssues(pause({ minValue: 1 }))).toContain('只用于')
  })

  it('添加关键词的出价要落在护栏范围内', () => {
    const add = (bid: number, patch: Partial<AdsRuleSpec['guardrails']> = {}) =>
      spec({ level: 'SEARCH_TERM', action: { type: 'ADD_KEYWORD', matchType: 'EXACT', bid }, guardrails: { minValue: 0.5, maxValue: 2, maxChangePercent: null, dailyLimit: 5, ...patch } })
    expect(ruleSpecIssues(add(1))).toBeNull()
    expect(ruleSpecIssues(add(0.3))).toContain('最低值')
    expect(ruleSpecIssues(add(2.5))).toContain('最高值')
    expect(ruleSpecIssues(add(0.001))).toContain('之间')
  })

  it('中文摘要：条件、过滤、动作、护栏、范围', () => {
    const rule = spec({
      conditions: [
        { metric: 'acos', windowDays: 7, op: 'gt', value: 35 },
        { metric: 'spend', windowDays: 14, op: 'gte', value: 20 },
        { metric: 'roas', windowDays: 3, op: 'lt', value: 2.5 },
      ],
      textFilters: [{ field: 'CAMPAIGN_NAME', mode: 'NOT_CONTAINS', text: '品牌' }],
      campaignIds: ['c1', 'c2'],
    })
    const summary = describeRuleSpec(rule)
    expect(summary.conditions).toBe('近 7 天广告成本销售比 > 35% 且 近 14 天花费 ≥ $20.00 且 近 3 天广告投入产出比 < 2.5 倍')
    expect(summary.filters).toBe('所属活动名称不包含“品牌”')
    expect(summary.action).toBe('竞价 -20%')
    expect(summary.guardrails).toBe('最低竞价 $0.10；最高竞价 $5.00；单次调整幅度不超过 30%；每天最多处理 10 个对象')
    expect(summary.scope).toBe('投放词（关键词与投放）；限定 2 个活动')
    expect(describeRuleSpec(spec()).filters).toBeNull()
    expect(describeRuleSpec(spec()).scope).toContain('全部活动')
    expect(describeAction({ type: 'ADJUST_BUDGET', mode: 'AMOUNT', value: 5 })).toBe('日预算 +$5')
    expect(describeAction({ type: 'NEGATE', matchType: 'NEGATIVE_PHRASE' })).toBe('添加为否定投放（否定词组）')
    expect(describeAction({ type: 'ADD_KEYWORD', matchType: 'BROAD', bid: 0.8 })).toBe('添加为关键词（广泛匹配，出价 $0.80）')
    expect(describeCondition({ metric: 'orders', windowDays: 1, op: 'lte', value: 0 })).toBe('近 1 天订单 ≤ 0')
    expect(describeGuardrails({ minValue: null, maxValue: 3, maxChangePercent: null, dailyLimit: 1 }, { type: 'ADD_KEYWORD', matchType: 'EXACT', bid: 1 })).toBe(
      '最高出价 $3.00；每天最多处理 1 个对象',
    )
    expect(formatRuleValue('spend', null)).toBe('无数据')
  })
})

describe('自动规则：执行频率与执行后效果', () => {
  const at = (iso: string) => new Date(iso)
  it('到期判断：从没评估过就到期；按频率留 10 分钟余量', () => {
    expect(ruleDueOf('DAILY', null, at('2026-10-21T00:00:00Z'))).toBe(true)
    expect(ruleDueOf('DAILY', at('2026-10-20T00:00:00Z'), at('2026-10-20T23:00:00Z'))).toBe(false)
    expect(ruleDueOf('DAILY', at('2026-10-20T00:00:00Z'), at('2026-10-20T23:51:00Z'))).toBe(true)
    expect(ruleDueOf('EVERY_3_DAYS', at('2026-10-18T00:00:00Z'), at('2026-10-20T23:00:00Z'))).toBe(false)
    expect(ruleDueOf('WEEKLY', at('2026-10-13T00:00:00Z'), at('2026-10-20T00:00:00Z'))).toBe(true)
  })

  it('效果：动作前后各 7 天（不含动作当天），任何一边没有记录就不算', () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, index) => day(shiftDate('2026-10-10', -1 - index), { spend: 10, sales: 20 })),
      ...Array.from({ length: 7 }, (_, index) => day(shiftDate('2026-10-10', 1 + index), { spend: 8, sales: 40 })),
    ]
    const pair = effectPairOf(rows, '2026-10-10')
    expect(pair?.before).toMatchObject({ rows: 7, spend: 70, sales: 140 })
    expect(pair?.after).toMatchObject({ rows: 7, spend: 56, sales: 280 })
    expect(effectPairOf(rows.slice(0, 7), '2026-10-10')).toBeNull()
    expect(effectPairOf(rows.slice(7), '2026-10-10')).toBeNull()
  })

  it('效果汇总：没执行过、执行了但没样本、有样本三种说法；比率由合计算出', () => {
    expect(summarizeEffect([], 0)).toMatchObject({ state: 'NOT_CONNECTED', samples: 0, before: null })
    expect(summarizeEffect([], 3)).toMatchObject({ state: 'NO_DATA', samples: 0, after: null })
    const rows = [
      ...Array.from({ length: 7 }, (_, index) => day(shiftDate('2026-10-10', -1 - index), { spend: 10, sales: 20 })),
      ...Array.from({ length: 7 }, (_, index) => day(shiftDate('2026-10-10', 1 + index), { spend: 8, sales: 40 })),
    ]
    const pair = effectPairOf(rows, '2026-10-10')!
    const effect = summarizeEffect([pair, pair], 2)
    expect(effect).toMatchObject({ state: 'OK', samples: 2, windowDays: 7 })
    expect(effect.before).toMatchObject({ spend: 140, sales: 280, acos: 50 })
    expect(effect.after).toMatchObject({ spend: 112, sales: 560, acos: 20 })
    expect(effect.note).toContain('不代表因果')
  })
})

describe('自动规则：请求校验', () => {
  const body = (patch: Record<string, unknown> = {}) => ({
    adsProfileId: 'prof_1',
    name: '高花费低转化降价',
    level: 'TARGET',
    conditions: [{ metric: 'spend', windowDays: 7, op: 'gte', value: 30 }],
    action: { type: 'ADJUST_BID', mode: 'PERCENT', value: -20 },
    guardrails: { minValue: 0.1, maxValue: 3, maxChangePercent: 30, dailyLimit: 10 },
    ...patch,
  })

  it('创建：补上默认值（建议模式、已暂停、每天一次、不过滤、全部活动）', () => {
    const parsed = AdsRuleBodySchema.parse(body())
    expect(parsed).toMatchObject({ mode: 'SUGGEST', status: 'PAUSED', frequency: 'DAILY', textFilters: [], campaignIds: [] })
  })

  it('创建：不合法的内容一律拒绝，并指出原因', () => {
    const bad = (patch: Record<string, unknown>) => AdsRuleBodySchema.safeParse(body(patch)).success
    expect(bad({})).toBe(true)
    expect(bad({ name: '' })).toBe(false)
    expect(bad({ level: 'AD_GROUP' })).toBe(false)
    expect(bad({ mode: 'MANUAL' })).toBe(false)
    expect(bad({ conditions: [] })).toBe(false)
    expect(bad({ conditions: Array.from({ length: 6 }, () => ({ metric: 'spend', windowDays: 7, op: 'gt', value: 1 })) })).toBe(false)
    expect(bad({ conditions: [{ metric: 'spend', windowDays: 5, op: 'gt', value: 1 }] })).toBe(false)
    expect(bad({ conditions: [{ metric: 'spend', windowDays: 7, op: 'eq', value: 1 }] })).toBe(false)
    expect(bad({ conditions: [{ metric: 'spend', windowDays: 7, op: 'gt', value: -1 }] })).toBe(false)
    expect(bad({ conditions: [{ metric: 'profit', windowDays: 7, op: 'gt', value: 1 }] })).toBe(false)
    expect(bad({ textFilters: Array.from({ length: 6 }, () => ({ field: 'NAME', mode: 'CONTAINS', text: 'a' })) })).toBe(false)
    expect(bad({ textFilters: [{ field: 'NAME', mode: 'CONTAINS', text: '  ' }] })).toBe(false)
    expect(bad({ campaignIds: ['a', 'a'] })).toBe(false)
    expect(bad({ campaignIds: ['a b'] })).toBe(false)
    expect(bad({ action: { type: 'PAUSE' }, guardrails: { minValue: null, maxValue: null, maxChangePercent: null, dailyLimit: 5 } })).toBe(true)
    expect(bad({ action: { type: 'DELETE' } })).toBe(false)
    expect(bad({ guardrails: { minValue: 0.1, maxValue: 3, maxChangePercent: null, dailyLimit: 10 } })).toBe(false)
    expect(bad({ guardrails: { minValue: 0.1, maxValue: 3, maxChangePercent: 30, dailyLimit: 0 } })).toBe(false)
    expect(bad({ unknownField: 1 })).toBe(false)
    const semantic = AdsRuleBodySchema.safeParse(body({ level: 'CAMPAIGN' }))
    expect(semantic.success).toBe(false)
    expect(JSON.stringify(semantic.error?.issues)).toContain('不适用于活动')
  })

  it('修改：必须带版本号与至少一个要改的字段；不能改账户与层级', () => {
    expect(AdsRuleUpdateBodySchema.safeParse({ name: 'x' }).success).toBe(false)
    expect(AdsRuleUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(AdsRuleUpdateBodySchema.safeParse({ version: 0, name: 'x' }).success).toBe(false)
    expect(AdsRuleUpdateBodySchema.safeParse({ version: 1, name: 'x' }).success).toBe(true)
    expect(AdsRuleUpdateBodySchema.safeParse({ version: 1, level: 'CAMPAIGN' }).success).toBe(false)
    expect(AdsRuleUpdateBodySchema.safeParse({ version: 1, adsProfileId: 'x' }).success).toBe(false)
  })

  it('试运行与执行记录的参数', () => {
    expect(AdsRuleDryRunBodySchema.safeParse({}).success).toBe(true)
    expect(AdsRuleDryRunBodySchema.safeParse({ asOf: '2026-10-20' }).success).toBe(true)
    expect(AdsRuleDryRunBodySchema.safeParse({ asOf: '10/20' }).success).toBe(false)
    expect(AdsRuleDryRunBodySchema.safeParse({ extra: 1 }).success).toBe(false)
    expect(AdsRuleRunsQuerySchema.parse({}).pageSize).toBe(20)
    expect(AdsRuleRunsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
    expect(AdsRuleRunsQuerySchema.safeParse({ pageSize: '50', storeIds: 'a' }).success).toBe(true)
  })

  it('自动执行已接入：说明里写明需要的开关，以及搜索词层级只生成待办', () => {
    expect(ADS_RULE_EXECUTION_PENDING.state).toBe('CONNECTED')
    expect(ADS_RULE_EXECUTION_PENDING.note).toContain('自动规则执行')
    expect(ADS_RULE_EXECUTION_PENDING.note).toContain('只生成待办')
  })
})
