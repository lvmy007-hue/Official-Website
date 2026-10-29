import { describe, expect, it } from 'vitest'
import { PolicyIssueListQuerySchema, PolicyIssueUpdateBodySchema } from './account-health-input.js'
import {
  accountStatusChanges,
  classifyHealthMetric,
  classifyPolicyKind,
  formatHealthValue,
  healthMetricLabel,
  isOrderDefectTotal,
  judgeHealthMetric,
  normalizeAccountStatus,
  normalizeTargetCondition,
  orderDefectBreakdown,
  ratingStatusLabel,
  splitMetricKey,
  targetText,
  toMetricView,
} from './account-health-math.js'
import { checkAlertParams } from './alert-rule-params.js'
import { ALERT_RULE_DEFS, ALERT_UNCONNECTED_TYPES } from './alert-rules.js'
import { entityDetailPath } from './collab.js'
import { freshnessSourceOfReport } from './freshness.js'

describe('账户状态与指标归类', () => {
  it('账户状态归一：认得的映射到三种状态，认不出的返回空，不猜成正常', () => {
    expect(normalizeAccountStatus('GOOD')).toBe('NORMAL')
    expect(normalizeAccountStatus('Normal')).toBe('NORMAL')
    expect(normalizeAccountStatus('AT_RISK')).toBe('AT_RISK')
    expect(normalizeAccountStatus('at risk')).toBe('AT_RISK')
    expect(normalizeAccountStatus('DEACTIVATED')).toBe('DEACTIVATED')
    expect(normalizeAccountStatus('CRITICAL')).toBe('DEACTIVATED')
    expect(normalizeAccountStatus('SOMETHING_NEW')).toBeNull()
    expect(normalizeAccountStatus('')).toBeNull()
    expect(normalizeAccountStatus(3)).toBeNull()
  })

  it('指标归类：订单缺陷、政策合规、状态、评级与其他；配送方式后缀不影响归类', () => {
    expect(classifyHealthMetric('orderDefectRate.afn')).toBe('ORDER_DEFECT')
    expect(classifyHealthMetric('negativeFeedbackRate')).toBe('ORDER_DEFECT')
    expect(classifyHealthMetric('listingPolicyViolations')).toBe('POLICY')
    expect(classifyHealthMetric('productSafetyCustomerComplaints')).toBe('POLICY')
    expect(classifyHealthMetric('ACCOUNT_STATUS')).toBe('STATUS')
    expect(classifyHealthMetric('lateShipmentRate')).toBe('OTHER')
    expect(splitMetricKey('orderDefectRate.mfn')).toEqual({ base: 'orderDefectRate', fulfillment: 'MFN' })
    expect(splitMetricKey('lateShipmentRate')).toEqual({ base: 'lateShipmentRate', fulfillment: null })
  })

  it('指标名：认得的用中文（带配送方式），认不得的显示报告原名', () => {
    expect(healthMetricLabel('orderDefectRate.afn')).toBe('订单缺陷率（亚马逊配送）')
    expect(healthMetricLabel('lateShipmentRate')).toBe('迟发率')
    expect(healthMetricLabel('someNewMetric')).toBe('someNewMetric')
  })

  it('政策问题归类按键名与标题关键词，认不出归“其他”', () => {
    expect(classifyPolicyKind('listingPolicyViolations', null, 'x')).toBe('LISTING_POLICY')
    expect(classifyPolicyKind('violations', 'Intellectual Property', 'x')).toBe('IP_COMPLAINT')
    expect(classifyPolicyKind('issues', null, 'Counterfeit complaint')).toBe('AUTHENTICITY')
    expect(classifyPolicyKind('issues', null, '???')).toBe('OTHER')
  })
})

describe('达标判定与显示', () => {
  it('只按报告自带的目标判定：缺目标、缺条件、缺值都是“报告没给目标”', () => {
    expect(judgeHealthMetric(0.005, 0.01, 'LT')).toBe('MET')
    expect(judgeHealthMetric(0.01, 0.01, 'LT')).toBe('NOT_MET')
    expect(judgeHealthMetric(0.01, 0.01, 'LTE')).toBe('MET')
    expect(judgeHealthMetric(3, 3, 'GTE')).toBe('MET')
    expect(judgeHealthMetric(2, 3, 'GT')).toBe('NOT_MET')
    expect(judgeHealthMetric(1, 1, 'EQ')).toBe('MET')
    expect(judgeHealthMetric(0.5, null, 'LT')).toBe('UNKNOWN')
    expect(judgeHealthMetric(0.5, 1, null)).toBe('UNKNOWN')
    expect(judgeHealthMetric(null, 1, 'LT')).toBe('UNKNOWN')
  })

  it('目标条件归一：符号与英文词都认', () => {
    expect(normalizeTargetCondition('<')).toBe('LT')
    expect(normalizeTargetCondition('LESS_THAN_OR_EQUAL_TO')).toBe('LTE')
    expect(normalizeTargetCondition('GREATER_THAN')).toBe('GT')
    expect(normalizeTargetCondition('foo')).toBeNull()
  })

  it('比率按百分比显示，计数原样，没有值写“尚无记录”而不是 0', () => {
    expect(formatHealthValue(0.0085, 'RATIO')).toBe('0.85%')
    expect(formatHealthValue(3, 'COUNT')).toBe('3')
    expect(formatHealthValue(0, 'COUNT')).toBe('0')
    expect(formatHealthValue(null, 'RATIO')).toBe('尚无记录')
    expect(targetText(0.01, 'LTE', 'RATIO')).toBe('不高于 1%')
    expect(targetText(null, 'LTE', 'RATIO')).toBeNull()
    const view = toMetricView({ metricKey: 'orderDefectRate.afn', metricGroup: 'ORDER_DEFECT', value: 0.02, target: 0.01, targetCondition: 'LTE', status: 'NOT_MET', unit: 'RATIO', windowDays: 60 })
    expect(view).toMatchObject({ label: '订单缺陷率（亚马逊配送）', statusLabel: '未达标', targetText: '不高于 1%', windowDays: 60 })
  })

  it('评级状态：认得的用中文，其余显示原文', () => {
    expect(ratingStatusLabel('GOOD')).toBe('良好')
    expect(ratingStatusLabel('Weird')).toBe('Weird')
    expect(ratingStatusLabel(null)).toBeNull()
  })
})

describe('订单缺陷率构成与状态变更点', () => {
  const view = (metricKey: string, value: number) =>
    toMetricView({ metricKey, metricGroup: 'ORDER_DEFECT', value, target: null, targetCondition: null, status: 'UNKNOWN', unit: 'RATIO', windowDays: null })

  it('构成项报告没分项给出时写明“报告未分项给出”，不用 0 代替', () => {
    expect(isOrderDefectTotal('orderDefectRate.afn')).toBe(true)
    expect(isOrderDefectTotal('orderDefectRateNegativeFeedback.afn')).toBe(false)
    const items = orderDefectBreakdown([view('orderDefectRate.afn', 0.01), view('negativeFeedbackRate', 0.004), view('chargebackRate', 0.001)])
    expect(items.map(item => [item.key, item.metric?.key ?? null, item.note])).toEqual([
      ['NEGATIVE_FEEDBACK', 'negativeFeedbackRate', null],
      ['CLAIMS', null, '报告未分项给出'],
      ['CHARGEBACK', 'chargebackRate', null],
    ])
  })

  it('状态变更点：第一天没有“之前的状态”，变差打标记，连续相同状态不重复', () => {
    const changes = accountStatusChanges([
      { date: '2026-10-01', status: 'NORMAL' },
      { date: '2026-10-02', status: 'NORMAL' },
      { date: '2026-10-03', status: 'AT_RISK' },
      { date: '2026-10-04', status: 'AT_RISK' },
      { date: '2026-10-05', status: 'NORMAL' },
    ])
    expect(changes.map(change => [change.date, change.status, change.previousStatus, change.worse])).toEqual([
      ['2026-10-01', 'NORMAL', null, false],
      ['2026-10-03', 'AT_RISK', 'NORMAL', true],
      ['2026-10-05', 'NORMAL', 'AT_RISK', false],
    ])
    expect(accountStatusChanges([])).toEqual([])
  })
})

describe('请求校验', () => {
  it('处理问题：版本号必填，至少改一项，案件编号只允许字母数字与横线下划线，未知字段拒绝', () => {
    expect(PolicyIssueUpdateBodySchema.safeParse({ handlingStatus: 'DONE' }).success).toBe(false)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1 }).success).toBe(false)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1, handlingStatus: 'DONE' }).success).toBe(true)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1, handlingStatus: 'NOPE' }).success).toBe(false)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1, amazonCaseId: '12 34' }).success).toBe(false)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1, amazonCaseId: null, ownerUserId: null, handlingNote: null }).success).toBe(true)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1, handlingNote: 'x'.repeat(501) }).success).toBe(false)
    expect(PolicyIssueUpdateBodySchema.safeParse({ version: 1, handlingStatus: 'DONE', resolvedAt: 'x' }).success).toBe(false)
  })

  it('问题列表：筛选取值受限，默认按首次出现时间从新到旧', () => {
    const parsed = PolicyIssueListQuerySchema.parse({})
    expect(parsed.sort).toEqual({ field: 'firstSeenAt', dir: 'desc' })
    expect(PolicyIssueListQuerySchema.safeParse({ status: 'OPEN', kind: 'IP_COMPLAINT', handlingStatus: 'IN_PROGRESS' }).success).toBe(true)
    expect(PolicyIssueListQuerySchema.safeParse({ kind: 'NOPE' }).success).toBe(false)
    expect(PolicyIssueListQuerySchema.safeParse({ sort: 'title:asc' }).success).toBe(false)
  })
})

describe('登记项', () => {
  it('卖家表现报告登记了新鲜度来源；两条账户预警成了预置规则，不再在“尚未接入”清单里', () => {
    expect(freshnessSourceOfReport('GET_V2_SELLER_PERFORMANCE_REPORT')?.key).toBe('rpt.seller-performance')
    expect(ALERT_RULE_DEFS.map(def => def.code)).toEqual(expect.arrayContaining(['SYS_ACCOUNT_STATUS_CHANGED', 'SYS_ACCOUNT_HEALTH_DECLINE']))
    expect(ALERT_UNCONNECTED_TYPES.map(item => item.key)).toEqual(['INV_REALTIME_STOCKOUT'])
  })

  it('两条预警的默认阈值通过各自的参数校验', () => {
    for (const code of ['SYS_ACCOUNT_STATUS_CHANGED', 'SYS_ACCOUNT_HEALTH_DECLINE']) {
      const def = ALERT_RULE_DEFS.find(item => item.code === code)
      expect(def, code).toBeDefined()
      expect(checkAlertParams(def!.type, {}, def!.params).ok, code).toBe(true)
    }
    expect(checkAlertParams('account.status-changed', { lookbackDays: 31 }, { lookbackDays: 7, statuses: ['AT_RISK'] }).ok).toBe(false)
    expect(checkAlertParams('account.health-decline', { groups: ['NOPE'] }, { maxAgeDays: 3, groups: ['POLICY'] }).ok).toBe(false)
  })

  it('政策问题有对象类型的详情路径', () => {
    expect(entityDetailPath('POLICY_ISSUE', 'abc')).toBe('/app/account-health?issue=abc')
  })
})
