import { describe, expect, it } from 'vitest'
import {
  ALERT_PARAM_SPECS,
  ALERT_RULE_DEFS,
  AlertAssignBodySchema,
  AlertCloseBodySchema,
  AlertIgnoreBodySchema,
  AlertListQuerySchema,
  AlertRuleCreateBodySchema,
  AlertRuleScopeSchema,
  AlertRuleUpdateBodySchema,
  alertParamSpecsOf,
  alertScopeSupportOf,
  checkAlertParams,
} from './index.js'

describe('预警规则可调项（P5-01）', () => {
  it('每条预置规则的评估器类型都登记了可调项，且默认阈值全部在登记范围内（页面与评估器取值一致）', () => {
    for (const def of ALERT_RULE_DEFS) {
      expect(ALERT_PARAM_SPECS[def.type], def.type).toBeDefined()
      const checked = checkAlertParams(def.type, {}, def.params)
      expect(checked.ok, `${def.type} ${JSON.stringify(checked)}`).toBe(true)
    }
  })

  it('可调项的键就是默认阈值的键：不会出现页面能改、评估器不读的阈值', () => {
    for (const def of ALERT_RULE_DEFS)
      expect(
        alertParamSpecsOf(def.type)
          .map(spec => spec.key)
          .sort(),
        def.type,
      ).toEqual(Object.keys(def.params).sort())
  })

  it('超出范围、非整数、非数字、空值、未知键、空的多选都被拒绝，并指出是哪个键', () => {
    const run = (input: Record<string, unknown>) => checkAlertParams('returns.abnormal-rate', input, { windowDays: 30, rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 20 })
    for (const [key, value] of [
      ['windowDays', 1000],
      ['windowDays', 7.5],
      ['rateThreshold', 'x'],
      ['rateThreshold', null],
      ['minSoldUnits', -1],
      ['nope', 1],
    ] as const) {
      const result = run({ [key]: value })
      expect(result.ok, `${key}=${String(value)}`).toBe(false)
      if (!result.ok) expect(result.errors[key]).toBeTruthy()
    }
    const choices = checkAlertParams('inbound.discrepancy', { kinds: [] }, { kinds: ['SHORT'] })
    expect(choices.ok).toBe(false)
    expect(checkAlertParams('inbound.discrepancy', { kinds: ['SHORT', 'BOGUS'] }, { kinds: ['SHORT'] }).ok).toBe(false)
  })

  it('只传要改的键，其余沿用当前值；可空项允许 null；多选按登记顺序去重', () => {
    const merged = checkAlertParams('returns.abnormal-rate', { windowDays: 14 }, { windowDays: 30, rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 20 })
    expect(merged).toEqual({ ok: true, params: { windowDays: 14, rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 20 } })
    expect(checkAlertParams('system.auth-expiring', { tokenMaxAgeDays: null }, { tokenMaxAgeDays: 365, warnBeforeDays: 14 })).toEqual({
      ok: true,
      params: { tokenMaxAgeDays: null, warnBeforeDays: 14 },
    })
    expect(checkAlertParams('inbound.discrepancy', { kinds: ['OVER', 'SHORT', 'OVER'] }, { kinds: ['SHORT'] })).toEqual({ ok: true, params: { kinds: ['SHORT', 'OVER'] } })
  })

  it('范围支持：汇率与写入开关没有店铺维度；广告、结算、数据来源类没有 SKU 维度', () => {
    expect(alertScopeSupportOf('system.fx-failed')).toEqual({ stores: false, skus: false })
    expect(alertScopeSupportOf('ads.cpc-surge')).toEqual({ stores: true, skus: false })
    expect(alertScopeSupportOf('inventory.excess')).toEqual({ stores: true, skus: true })
  })
})

describe('预警接口参数', () => {
  it('忽略必须写原因、关闭必须选结论、分派必须有对象', () => {
    expect(AlertIgnoreBodySchema.safeParse({ reason: ' ' }).success).toBe(false)
    expect(AlertIgnoreBodySchema.safeParse({ reason: '已知' }).success).toBe(true)
    expect(AlertCloseBodySchema.safeParse({}).success).toBe(false)
    expect(AlertCloseBodySchema.safeParse({ conclusion: 'MAYBE' }).success).toBe(false)
    expect(AlertCloseBodySchema.safeParse({ conclusion: 'FALSE_POSITIVE' }).success).toBe(true)
    expect(AlertAssignBodySchema.safeParse({}).success).toBe(false)
  })

  it('列表参数：视图、业务域、严重度只接受登记值；默认按最近触发倒序', () => {
    expect(AlertListQuerySchema.safeParse({ view: 'bogus' }).success).toBe(false)
    expect(AlertListQuerySchema.safeParse({ domain: 'ADS', severity: 'CRITICAL', view: 'handled' }).success).toBe(true)
    const parsed = AlertListQuerySchema.parse({})
    expect(parsed.sort).toEqual({ field: 'lastTriggeredAt', dir: 'desc' })
  })

  it('规则改动：必须带版本与变更原因、至少有一项改动；范围里的静默时段格式与起止不同', () => {
    expect(AlertRuleUpdateBodySchema.safeParse({ version: 1, changeReason: '调整' }).success).toBe(false)
    expect(AlertRuleUpdateBodySchema.safeParse({ version: 1, enabled: false }).success).toBe(false)
    expect(AlertRuleUpdateBodySchema.safeParse({ version: 1, changeReason: '调整', enabled: false }).success).toBe(true)
    expect(AlertRuleScopeSchema.safeParse({ quiet: { start: '25:00', end: '07:00' } }).success).toBe(false)
    expect(AlertRuleScopeSchema.safeParse({ quiet: { start: '22:00', end: '22:00' } }).success).toBe(false)
    expect(AlertRuleScopeSchema.safeParse({ quiet: { start: '22:00', end: '07:00' }, unknownKey: 1 }).success).toBe(false)
    expect(AlertRuleCreateBodySchema.safeParse({ type: 'ads.cpc-surge', name: 'x' }).success).toBe(false)
    expect(AlertRuleCreateBodySchema.safeParse({ type: 'ads.cpc-surge', name: '核心词突增' }).success).toBe(true)
  })
})
