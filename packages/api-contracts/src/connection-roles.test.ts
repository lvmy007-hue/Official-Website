import { describe, expect, it } from 'vitest'
import {
  BRAND_EVIDENCE_SOURCES,
  ROLE_COMPARISON_BASIS,
  ROLE_MODULES,
  SP_ROLES,
  combineEvidence,
  emptyCounts,
  evaluateRoleModules,
  evaluateRoles,
  evidenceOf,
  isRoleFailureCode,
  moduleStateOf,
  type EvidenceRow,
} from './connection-roles'

const NOW = '2026-10-20T00:00:00.000Z'
const row = (sourceKey: string, over: Partial<EvidenceRow> = {}, store = 's1'): EvidenceRow => ({
  sellerAccountId: store,
  sourceKey,
  status: 'NORMAL',
  lastSuccessAt: NOW,
  lastErrorCode: null,
  ...over,
})

describe('角色清单与板块表', () => {
  it('每个板块的所需角色都在角色清单里，页面路径互不为空，来源键不为空', () => {
    const names = new Set<string>(SP_ROLES.map(role => role.name))
    for (const module of ROLE_MODULES) {
      expect(module.roles.length, module.key).toBeGreaterThan(0)
      for (const role of module.roles) expect(names.has(role), `${module.key}:${role}`).toBe(true)
      expect(module.sourceKeys.length, module.key).toBeGreaterThan(0)
      expect(module.pages.length, module.key).toBeGreaterThan(0)
      for (const page of module.pages) expect(page.path.startsWith('/app/'), page.path).toBe(true)
    }
    expect(new Set(ROLE_MODULES.map(module => module.key)).size).toBe(ROLE_MODULES.length)
  })

  it('受限角色标记与 importers.md 一致：五个受限角色', () => {
    expect(SP_ROLES.filter(role => role.restricted).map(role => role.name)).toEqual([
      'Direct to Consumer Shipping (Restricted)',
      'Tax Remittance (Restricted)',
      'Tax Invoicing (Restricted)',
      'Selling Partner Support (Restricted)',
      'Professional Services (Restricted)',
    ])
  })

  it('品牌分析资格要看的来源是品牌分析报告、销售与流量、评论主题三个板块的来源', () => {
    expect(BRAND_EVIDENCE_SOURCES).toEqual(expect.arrayContaining(['rpt.ba.search-query', 'dk.sales-traffic.date', 'feedback.api']))
    expect(BRAND_EVIDENCE_SOURCES).not.toContain('orders.api')
  })
})

describe('证据判断', () => {
  it('没有记录：尚未验证', () => {
    expect(evidenceOf(undefined)).toBe('UNVERIFIED')
  })
  it('缺角色类失败码都算缺失，包括各来源专用码与品牌资格码', () => {
    for (const code of ['ROLE_MISSING', 'SUP_ROLE_PENDING', 'TAX_ROLE_PENDING', 'APL_ROLE_MISSING', 'FEES_ROLE_PENDING', 'DK_NO_BRAND', 'FBK_NO_BRAND_ACCESS']) {
      expect(isRoleFailureCode(code), code).toBe(true)
      expect(evidenceOf(row('x', { status: 'UNAUTHORIZED', lastErrorCode: code })), code).toBe('MISSING')
    }
    expect(isRoleFailureCode('AUTH_EXPIRED')).toBe(false)
    expect(isRoleFailureCode(null)).toBe(false)
  })
  it('授权失效单独成类，不算缺角色', () => {
    expect(evidenceOf(row('x', { status: 'UNAUTHORIZED', lastErrorCode: 'AUTH_EXPIRED', lastSuccessAt: null }))).toBe('AUTH_EXPIRED')
  })
  it('未批的状态但失败码不认识：仍按缺失（状态是 UNAUTHORIZED）', () => {
    expect(evidenceOf(row('x', { status: 'UNAUTHORIZED', lastErrorCode: 'SOMETHING', lastSuccessAt: NOW }))).toBe('MISSING')
  })
  it('没有品牌备案与前提不满足算不适用，不是故障也不是缺角色', () => {
    expect(evidenceOf(row('x', { status: 'FAILED', lastErrorCode: 'BA_NO_BRAND', lastSuccessAt: null }))).toBe('NOT_APPLICABLE')
    expect(evidenceOf(row('x', { status: 'NOT_APPLICABLE', lastErrorCode: 'SCOPE_UNAVAILABLE', lastSuccessAt: null }))).toBe('NOT_APPLICABLE')
  })
  it('成功过且最近没有以失败收场：具备；限流延迟也不否定', () => {
    expect(evidenceOf(row('x'))).toBe('OK')
    expect(evidenceOf(row('x', { status: 'DELAYED', lastErrorCode: 'THROTTLE_EXHAUSTED' }))).toBe('OK')
  })
  it('只有失败从未成功：故障；记录是正常却从没成功过：尚未验证', () => {
    expect(evidenceOf(row('x', { status: 'FAILED', lastErrorCode: 'REPORT_FATAL', lastSuccessAt: null }))).toBe('FAILED')
    expect(evidenceOf(row('x', { lastSuccessAt: null }))).toBe('UNVERIFIED')
  })
  it('同一板块多个来源：任一成功就算成功；都没成功时缺失优先于不适用优先于授权失效优先于故障', () => {
    expect(combineEvidence(['MISSING', 'OK'])).toBe('OK')
    expect(combineEvidence(['FAILED', 'MISSING', 'AUTH_EXPIRED'])).toBe('MISSING')
    expect(combineEvidence(['FAILED', 'NOT_APPLICABLE'])).toBe('NOT_APPLICABLE')
    expect(combineEvidence(['FAILED', 'AUTH_EXPIRED'])).toBe('AUTH_EXPIRED')
    expect(combineEvidence(['UNVERIFIED', 'UNVERIFIED'])).toBe('UNVERIFIED')
  })
  it('板块状态：成功与缺失并存是部分；只有缺失是缺失', () => {
    expect(moduleStateOf({ ...emptyCounts(), ok: 2 })).toBe('GRANTED')
    expect(moduleStateOf({ ...emptyCounts(), ok: 1, missing: 1 })).toBe('PARTIAL')
    expect(moduleStateOf({ ...emptyCounts(), missing: 1, notApplicable: 1 })).toBe('MISSING')
    expect(moduleStateOf({ ...emptyCounts(), notApplicable: 1 })).toBe('NOT_APPLICABLE')
    expect(moduleStateOf(emptyCounts())).toBe('UNVERIFIED')
  })
})

describe('角色对照', () => {
  const find = <T extends { key?: string; name?: string }>(list: T[], key: string) => list.find(item => item.key === key || item.name === key)!

  it('支持案件缺“卖家支持（受限）”：板块缺失，影响的页面点名；该角色单独验证为缺失', () => {
    const modules = evaluateRoleModules(['s1'], [row('support.api', { status: 'UNAUTHORIZED', lastErrorCode: 'SUP_ROLE_PENDING', lastSuccessAt: null })])
    const support = find(modules, 'support')
    expect(support.state).toBe('MISSING')
    expect(support.impact).toContain('“支持案件”')
    expect(support.impact).toContain('卖家支持（受限）')
    const roles = evaluateRoles(modules)
    expect(find(roles, 'Selling Partner Support (Restricted)').state).toBe('MISSING')
  })

  it('两个店铺一个成功一个缺失：部分店铺缺失，说明“部分店铺”', () => {
    const modules = evaluateRoleModules(['s1', 's2'], [row('support.api'), row('support.api', { status: 'UNAUTHORIZED', lastErrorCode: 'SUP_ROLE_PENDING', lastSuccessAt: null }, 's2')])
    const support = find(modules, 'support')
    expect(support.state).toBe('PARTIAL')
    expect(support.counts).toMatchObject({ ok: 1, missing: 1 })
    expect(support.impact).toContain('部分店铺')
    expect(find(evaluateRoles(modules), 'Selling Partner Support (Restricted)').state).toBe('PARTIAL')
  })

  it('与别的角色并列的角色（任一即可）无法单独验证，即使板块已打通', () => {
    const modules = evaluateRoleModules(['s1'], [row('orders.api')])
    expect(find(modules, 'orders').state).toBe('GRANTED')
    // 订单所需角色有十二个，任何一个都无法由订单同步成功单独证明
    expect(find(evaluateRoles(modules), 'Inventory and Order Tracking').state).toBe('NOT_DIRECTLY_VERIFIABLE')
    expect(find(evaluateRoles(modules), 'Pricing').state).toBe('UNVERIFIED') // 定价板块只依赖它，但没有它的同步记录
  })

  it('没有任何记录：全部尚未验证；没有已授权店铺：板块店铺数为 0，不报缺失', () => {
    const none = evaluateRoleModules(['s1'], [])
    for (const module of none) {
      expect(module.state, module.key).toBe('UNVERIFIED')
      expect(module.impact, module.key).toBeNull()
    }
    const empty = evaluateRoleModules([], [row('support.api')])
    expect(empty.every(module => module.storeCount === 0 && module.state === 'UNVERIFIED')).toBe(true)
  })

  it('别的店铺的记录不会算进来', () => {
    const modules = evaluateRoleModules(['s1'], [row('support.api', {}, 'other-store')])
    expect(find(modules, 'support').state).toBe('UNVERIFIED')
  })

  it('说明文字交代了推断的依据与限制', () => {
    expect(ROLE_COMPARISON_BASIS).toContain('没有提供列出应用已获得角色的接口')
    expect(ROLE_COMPARISON_BASIS).toContain('尚未验证')
  })
})
