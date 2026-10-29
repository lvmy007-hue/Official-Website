import { describe, expect, it } from 'vitest'
import { ALERT_BATCH_MAX, AlertBatchHandleBodySchema, AlertListQuerySchema, AlertReadBodySchema } from './alerts.js'
import { ALERT_RULE_DEFS } from './alert-rules.js'
import { ALERT_TEMPLATE_GROUPS, ALERT_TEMPLATE_GROUP_LABEL, ALERT_TEMPLATE_NAME_MAX, ALERT_TEMPLATE_TEXT, buildAlertTemplates, templateRuleName } from './alert-templates.js'

describe('预警规则模板（P6-15）', () => {
  it('每条预置规则都有一份模板文字，且没有多余的文字', () => {
    expect(Object.keys(ALERT_TEMPLATE_TEXT).sort()).toEqual(ALERT_RULE_DEFS.map(def => def.code).sort())
    for (const [code, text] of Object.entries(ALERT_TEMPLATE_TEXT)) {
      expect(text.condition.length, `${code} 条件太长`).toBeLessThanOrEqual(60)
      expect(text.condition.length).toBeGreaterThan(5)
      expect(text.dimension.length).toBeGreaterThan(1)
    }
  })

  it('按库存、广告、销售、流量、店铺分组，每组都有模板，总数等于预置规则数', () => {
    const templates = buildAlertTemplates()
    expect(templates).toHaveLength(ALERT_RULE_DEFS.length)
    expect(ALERT_TEMPLATE_GROUPS.map(group => ALERT_TEMPLATE_GROUP_LABEL[group])).toEqual(['库存', '广告', '销售', '流量', '店铺'])
    for (const group of ALERT_TEMPLATE_GROUPS)
      expect(
        templates.some(item => item.group === group),
        group,
      ).toBe(true)
    // 分组顺序：同一组的模板连在一起，按分组顺序排列
    const order = templates.map(item => ALERT_TEMPLATE_GROUPS.indexOf(item.group))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('模板与预置规则一致：评估逻辑、严重度、冷却、默认阈值；改模板的阈值不会改到预置规则', () => {
    const templates = buildAlertTemplates()
    const stockout = templates.find(item => item.code === 'INV_STOCKOUT_RISK')!
    const def = ALERT_RULE_DEFS.find(item => item.code === 'INV_STOCKOUT_RISK')!
    expect(stockout).toMatchObject({ type: def.type, severity: def.severity, cooldownMinutes: def.cooldownMinutes, group: 'INVENTORY', groupLabel: '库存' })
    expect(stockout.params).toEqual(def.params)
    expect(stockout.params).not.toBe(def.params)
    expect(templates.find(item => item.code === 'ADS_CPC_SURGE')?.group).toBe('ADS')
    expect(templates.find(item => item.code === 'PRD_PRICE_HEALTH')?.group).toBe('TRAFFIC')
    expect(templates.find(item => item.code === 'SYS_SYNC_FAILED')?.group).toBe('STORE')
    expect(templates.find(item => item.code === 'FIN_FEE_OVERCHARGE')?.group).toBe('SALES')
  })

  it('从模板新建的默认名称不超过规则名称上限', () => {
    expect(templateRuleName('断货风险')).toBe('断货风险（自定义）')
    expect(templateRuleName('长'.repeat(100)).length).toBe(ALERT_TEMPLATE_NAME_MAX)
  })
})

describe('预警已读与批量处理的请求（P6-15）', () => {
  it('批量标记已读：至少一条、最多 ALERT_BATCH_MAX 条', () => {
    expect(AlertReadBodySchema.safeParse({ ids: [] }).success).toBe(false)
    expect(AlertReadBodySchema.safeParse({ ids: ['a'] }).success).toBe(true)
    expect(AlertReadBodySchema.safeParse({ ids: Array.from({ length: ALERT_BATCH_MAX }, (_, index) => `a${index}`) }).success).toBe(true)
    expect(AlertReadBodySchema.safeParse({ ids: Array.from({ length: ALERT_BATCH_MAX + 1 }, (_, index) => `a${index}`) }).success).toBe(false)
  })

  it('批量标记已处理：备注可选，超长被拒绝', () => {
    expect(AlertBatchHandleBodySchema.safeParse({ ids: ['a'], note: '已核实' }).success).toBe(true)
    expect(AlertBatchHandleBodySchema.safeParse({ ids: ['a'], note: 'x'.repeat(1001) }).success).toBe(false)
    expect(AlertBatchHandleBodySchema.safeParse({ ids: [] }).success).toBe(false)
  })

  it('列表接受 handleState 与 readState，值不合法返回错误', () => {
    expect(AlertListQuerySchema.safeParse({ handleState: 'handled', readState: 'unread' }).success).toBe(true)
    expect(AlertListQuerySchema.safeParse({ view: 'open' }).success).toBe(true)
    expect(AlertListQuerySchema.safeParse({ readState: 'maybe' }).success).toBe(false)
    expect(AlertListQuerySchema.safeParse({ handleState: 'nope' }).success).toBe(false)
  })
})
