import { ALERT_RULE_DEFS } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { AlertEvaluatorRegistry } from '../platform/alert-evaluate'
import { numberParam, optionalNumberParam, scopeFilter } from './params'
import { ensureDefaultRules } from './provision'
import { registerPhase2aAlertEvaluators } from './register'

// 预置规则的补齐（P2a-15）与评估器注册的一致性。

function makeDb(existing: string[] = [], options: { raceOn?: string } = {}) {
  const rules: Array<Record<string, unknown>> = []
  const versions: Array<Record<string, unknown>> = []
  const tx = {
    alertRule: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.code === options.raceOn) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const row = { id: `id-${rules.length + 1}`, currentVersion: 1, ...data }
        rules.push(row)
        return row
      }),
    },
    alertRuleVersion: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => versions.push(data)) },
  }
  const db = {
    alertRule: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => existing.map(code => ({ code }))) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  }
  return { db: db as never, raw: db, rules, versions }
}

describe('补齐预置规则', () => {
  it('没有规则的企业：全部建出来，每条带第 1 版记录，默认启用、阈值取预置值', async () => {
    const { db, rules, versions } = makeDb()
    const created = await ensureDefaultRules(db, 't1')
    expect(created).toEqual(ALERT_RULE_DEFS.map(def => def.code))
    expect(rules).toHaveLength(ALERT_RULE_DEFS.length)
    const stockout = rules.find(rule => rule.code === 'INV_STOCKOUT_RISK')
    expect(stockout).toMatchObject({
      tenantId: 't1',
      domain: 'INVENTORY',
      name: '断货风险',
      severity: 'CRITICAL',
      enabled: true,
      scopeJson: {},
      conditionJson: { type: 'inventory.stockout-risk', params: { levels: ['HIGH'] } },
    })
    expect(versions[0]).toMatchObject({ tenantId: 't1', versionNo: 1, changedBy: 'system', changeReason: '系统预置规则' })
    expect(versions).toHaveLength(ALERT_RULE_DEFS.length)
  })

  it('已有的规则一律不动（企业改过的阈值与启停不会被冲掉），只补缺的', async () => {
    const { db, rules } = makeDb(['INV_STOCKOUT_RISK', 'SYS_SYNC_FAILED'])
    const created = await ensureDefaultRules(db, 't1')
    expect(created).toHaveLength(ALERT_RULE_DEFS.length - 2)
    expect(rules.map(rule => rule.code)).not.toContain('INV_STOCKOUT_RISK')
  })

  it('全都有了：不写任何东西；并发时另一个进程刚建好的（唯一冲突）视为已存在', async () => {
    const full = makeDb(ALERT_RULE_DEFS.map(def => def.code))
    expect(await ensureDefaultRules(full.db, 't1')).toEqual([])
    expect(full.raw.$transaction).not.toHaveBeenCalled()
    const raced = makeDb([], { raceOn: 'INV_EXCESS' })
    expect(await ensureDefaultRules(raced.db, 't1')).not.toContain('INV_EXCESS')
  })

  it('其他错误原样抛出', async () => {
    const { db, raw } = makeDb()
    raw.$transaction.mockRejectedValueOnce(new Error('db down'))
    await expect(ensureDefaultRules(db, 't1')).rejects.toThrow('db down')
  })
})

describe('预置规则目录与评估器', () => {
  it('规则代码与评估器类型都不重复；冷却时间在数据库允许的范围内；严重度合法', () => {
    expect(new Set(ALERT_RULE_DEFS.map(def => def.code)).size).toBe(ALERT_RULE_DEFS.length)
    expect(new Set(ALERT_RULE_DEFS.map(def => def.type)).size).toBe(ALERT_RULE_DEFS.length)
    for (const def of ALERT_RULE_DEFS) {
      expect(def.cooldownMinutes, def.code).toBeGreaterThanOrEqual(0)
      expect(def.cooldownMinutes, def.code).toBeLessThanOrEqual(10_080)
      expect(['INFO', 'WARNING', 'CRITICAL']).toContain(def.severity)
      expect(def.description.length, def.code).toBeGreaterThan(10)
    }
  })

  it('每条预置规则都有对应的评估器（否则规则永远不会触发），反过来每个评估器都有预置规则', () => {
    const registry = registerPhase2aAlertEvaluators(new AlertEvaluatorRegistry())
    for (const def of ALERT_RULE_DEFS) expect(registry.find(def.type), def.code).toBeDefined()
    // 多出来的一个是自定义指标评估器（P6-16）：它没有预置规则，规则由用户新建
    expect(registry.find('CUSTOM_METRIC')).toBeDefined()
    expect(registry.size).toBe(ALERT_RULE_DEFS.length + 1)
  })

  it('已交付的 30 项预警都在：库存 5 项、入仓差异、尺寸分段变化、结算差异、费用多收、赔付机会即将到期、异常退货率、广告 4 项、商品 5 项、跟卖、促销叠加、负面评论主题上升、同步失败、授权失效、汇率获取失败、写入开关被自动关闭、账户状态变化、账户健康指标未达标、大量查看买家信息明文；没有实时断货', () => {
    expect(ALERT_RULE_DEFS.map(def => def.name)).toEqual([
      '断货风险',
      '库存冗余',
      '库龄附加费即将跨档',
      '低库存水平费风险',
      '滞留库存',
      '入仓差异',
      '尺寸分段变化',
      '结算差异',
      '费用多收',
      '赔付机会即将到期',
      '异常退货率',
      '广告高花费低产出',
      '断货商品仍在投放',
      '广告超预算',
      '单次点击成本突增',
      '刊登问题新增',
      '被搜索抑制',
      '详情页被他人修改',
      '失去推荐报价资格',
      '价格健康异常',
      '我方 Listing 出现其他报价方（跟卖）',
      '促销叠加或折扣过深',
      '负面评论主题上升',
      '数据同步失败',
      '亚马逊授权失效或即将失效',
      '汇率获取失败',
      '写入开关被自动关闭',
      '账户状态变化',
      '账户健康指标未达标',
      '大量查看买家信息明文',
    ])
  })
})

describe('阈值读取', () => {
  const rule = (params: Record<string, unknown> | undefined, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'X',
    domain: 'D',
    name: 'n',
    severity: 'WARNING',
    cooldownMinutes: 1,
    currentVersion: 1,
    condition: { type: 't', params },
    scope,
  })

  it('数字阈值：不合法用默认值，越界夹到边界', () => {
    expect(numberParam(rule({ a: 5 }), 'a', 30)).toBe(5)
    expect(numberParam(rule({ a: '5' }), 'a', 30)).toBe(30)
    expect(numberParam(rule({ a: Number.NaN }), 'a', 30)).toBe(30)
    expect(numberParam(rule(undefined), 'a', 30)).toBe(30)
    expect(numberParam(rule({ a: 0 }), 'a', 30, { min: 1, max: 365 })).toBe(1)
    expect(numberParam(rule({ a: 9999 }), 'a', 30, { min: 1, max: 365 })).toBe(365)
    expect(optionalNumberParam(rule({ a: null }), 'a')).toBeNull()
    expect(optionalNumberParam(rule({}), 'a')).toBeNull()
    expect(optionalNumberParam(rule({ a: 1 }), 'a', { min: 30 })).toBe(30)
  })

  it('范围：店铺与 SKU 列表；不带 SKU 的对象不受 SKU 范围限制', () => {
    const open = scopeFilter(rule({}))
    expect(open.allows({ sellerAccountId: 's1', sku: 'A' })).toBe(true)
    const limited = scopeFilter(rule({}, { sellerAccountIds: ['s1'], skus: ['A'] }))
    expect(limited.allows({ sellerAccountId: 's1', sku: 'A' })).toBe(true)
    expect(limited.allows({ sellerAccountId: 's1', sku: 'B' })).toBe(false)
    expect(limited.allows({ sellerAccountId: 's2', sku: 'A' })).toBe(false)
    expect(limited.allows({ sellerAccountId: 's1' })).toBe(true)
    expect(limited.allows({ sellerAccountId: null })).toBe(false)
    expect(scopeFilter(rule({}, { sellerAccountIds: [] })).allows({ sellerAccountId: 'x' })).toBe(true)
  })
})
