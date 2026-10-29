import { describe, expect, it } from 'vitest'
import { describeParams, paramValueText, readCondition, readSnapshot } from './alert-rule-format'
import { formatEvidence } from './alert-evidence'

describe('预警证据展示', () => {
  it('只显示登记过中文名的键；未登记的内部字段不出现', () => {
    const rows = formatEvidence({ spend: 45.5, clicks: 80, internalToken: 'secret', buyerEmail: 'a@b.c', campaignName: '春季促销' })
    expect(rows).toEqual([
      { label: '花费', value: 'USD 45.50' },
      { label: '点击', value: '80' },
      { label: '广告活动', value: '春季促销' },
    ])
    expect(JSON.stringify(rows)).not.toContain('secret')
  })

  it('按含义格式化：币种取自证据、比例转百分比、倍数、日期时间、布尔、枚举', () => {
    const rows = formatEvidence({ currency: 'EUR', spend: 3, acos: 1.456, ratio: 2.5, lastSuccessAt: '2026-10-20T08:30:00Z', noDemand: true, risk: 'HIGH' })
    const map = Object.fromEntries(rows.map(row => [row.label, row.value]))
    expect(map).toMatchObject({ 花费: 'EUR 3.00', 广告成本销售比: '145.6%', 突增倍数: '2.5 倍', 最近成功: '2026-10-20 08:30 UTC', 近期没有销量: '是', 风险等级: '高风险' })
  })

  it('阈值的含义随规则变化：有退货率时按百分比，有突增倍数时按倍数', () => {
    expect(formatEvidence({ rate: 0.2, threshold: 0.15 })).toContainEqual({ label: '阈值', value: '15%' })
    expect(formatEvidence({ ratio: 3, threshold: 2 })).toContainEqual({ label: '阈值', value: '2 倍' })
  })

  it('嵌套证据每项一行、最多 8 项；空值与非法值被跳过而不是显示成 0', () => {
    const topics = Array.from({ length: 10 }, (_, index) => ({ topic: `主题${index}`, kindLabel: '新进入' }))
    const [row] = formatEvidence({ topics })
    expect(row.label).toBe('上升的主题')
    expect(row.value.split('；')).toHaveLength(8)
    expect(formatEvidence({ spend: null, clicks: 'abc', lastSuccessAt: 'not a date', title: '  ' })).toEqual([])
  })

  it('证据不是对象时返回空', () => {
    expect(formatEvidence(null)).toEqual([])
    expect(formatEvidence([1, 2])).toEqual([])
    expect(formatEvidence('x')).toEqual([])
  })
})

describe('规则阈值描述', () => {
  it('按登记的中文名、单位、百分比、多选标签展示，可空项为空时显示“不启用”', () => {
    expect(describeParams('returns.abnormal-rate', { windowDays: 30, rateThreshold: 0.15, minReturnedUnits: 5, minSoldUnits: 20 })).toEqual([
      { label: '回看天数', value: '30 天' },
      { label: '退货率阈值', value: '15%' },
      { label: '最小退货件数', value: '5 件' },
      { label: '最小销售件数', value: '20 件' },
    ])
    expect(describeParams('system.auth-expiring', { tokenMaxAgeDays: null, warnBeforeDays: 14 })[0]).toEqual({ label: '授权最长年龄', value: '不启用' })
    expect(describeParams('inventory.stockout-risk', { levels: ['HIGH'] })).toEqual([{ label: '提醒的风险等级', value: '高风险' }])
  })

  it('缺失的阈值显示“未设置”；旧数据里多余的键忽略；未知类型没有可调项', () => {
    expect(describeParams('inventory.aging-tier', {})).toEqual([{ label: '提前预警天数', value: '未设置' }])
    expect(describeParams('inventory.aging-tier', { warnDays: 30, legacy: 1 })).toEqual([{ label: '提前预警天数', value: '30 天' }])
    expect(describeParams('made.up', { a: 1 })).toEqual([])
    expect(paramValueText({ kind: 'number', key: 'k', label: 'k', min: 0, max: 1 }, 'x')).toBe('未设置')
  })

  it('规则行与版本快照的读取：格式不对返回空对象，新旧快照都能读', () => {
    expect(readCondition(null)).toEqual({ type: '', params: {} })
    expect(readCondition({ type: 'a', params: [] })).toEqual({ type: 'a', params: {} })
    expect(readSnapshot({ type: 'a', params: { x: 1 } })).toMatchObject({ type: 'a', severity: null, cooldownMinutes: null, enabled: null, scope: null })
    expect(readSnapshot({ type: 'a', params: {}, severity: 'CRITICAL', cooldownMinutes: 30, enabled: false, scope: { skus: ['A'] } })).toMatchObject({
      severity: 'CRITICAL',
      cooldownMinutes: 30,
      enabled: false,
      scope: { skus: ['A'] },
    })
    expect(readSnapshot('bad')).toMatchObject({ type: '', params: {}, scope: null })
  })
})
