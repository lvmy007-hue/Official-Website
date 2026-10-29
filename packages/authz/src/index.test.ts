import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASE_PERMISSIONS,
  LEGACY_PERMISSION_KEYS,
  LEGACY_PERMISSION_MAP,
  PERMISSIONS,
  PERMISSION_CATALOG,
  PRESET_ROLES,
  canSeeField,
  effectivePermissions,
  hasPermission,
  isKnownPermission,
  unknownPermissions,
  visibleFields,
} from './index'

const root = join(__dirname, '../../..')

describe('权限目录与冻结清单', () => {
  it('目录由 permissions.md 生成，二者一致（改清单必须重新生成）', () => {
    const result = spawnSync(process.execPath, [join(root, 'scripts/gen-permission-catalog.mjs'), '--check'], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('共 105 个权限点，按清单统计的十个分组数量一致，且点位不重复、格式为“模块.动作”', () => {
    expect(PERMISSION_CATALOG).toHaveLength(105)
    const counts: Record<string, number> = {}
    for (const entry of PERMISSION_CATALOG) counts[entry.group] = (counts[entry.group] ?? 0) + 1
    expect(counts).toEqual({ 首页与协作: 9, 运营分析: 2, 商品: 17, 库存: 7, 供应链: 17, 订单与售后: 5, 财务: 10, 广告: 11, '风险、数据与报表': 11, 连接与治理: 16 })
    expect(new Set(PERMISSION_CATALOG.map(entry => entry.key)).size).toBe(105)
    for (const entry of PERMISSION_CATALOG) expect(entry.key).toMatch(/^[a-z]+(\.[a-z]+)+$/)
  })
})

describe('预设角色', () => {
  const byKey = Object.fromEntries(PRESET_ROLES.map(role => [role.key, role]))

  it('一共 7 个，编号与名称固定', () => {
    expect(PRESET_ROLES.map(role => role.name)).toEqual(['所有者', '管理员', '运营', '广告', '财务', '供应链', '只读'])
    expect(PRESET_ROLES.map(role => role.id)).toEqual(['preset-owner', 'preset-admin', 'preset-ops', 'preset-ads', 'preset-finance', 'preset-supply', 'preset-readonly'])
  })

  it('所有者通配；管理员拥有清单里全部权限点', () => {
    expect(byKey.owner.permissions).toEqual(['*'])
    expect(byKey.admin.permissions).toHaveLength(105)
  })

  it('只读角色只有查看类权限，没有任何字段权限', () => {
    const kinds = new Set(byKey.readonly.permissions.map(key => PERMISSION_CATALOG.find(entry => entry.key === key)!.kind))
    expect([...kinds]).toEqual(['查看'])
    expect(byKey.readonly.permissions).not.toContain('export.create')
    expect(byKey.readonly.fields).toEqual([])
  })

  it('字段权限默认值与清单一致：成本给所有者/管理员/财务/供应链；利润给所有者/管理员/运营/广告/财务；买家信息只给所有者/管理员', () => {
    const holders = (field: 'cost' | 'profit' | 'buyer') => PRESET_ROLES.filter(role => role.fields.includes(field)).map(role => role.key)
    expect(holders('cost')).toEqual(['owner', 'admin', 'finance', 'supply'])
    expect(holders('profit')).toEqual(['owner', 'admin', 'ops', 'ads', 'finance'])
    expect(holders('buyer')).toEqual(['owner', 'admin'])
  })

  it('关键差异：运营看不到成本权限页；供应链不能付款、不能审批采购；财务不能重新开账；广告有广告全部写权限', () => {
    expect(byKey.ops.permissions).not.toContain('costs.read')
    expect(byKey.supply.permissions).not.toContain('purchase.pay')
    expect(byKey.supply.permissions).not.toContain('purchase.order.approve')
    expect(byKey.finance.permissions).not.toContain('finance.period.reopen')
    expect(byKey.admin.permissions).toContain('finance.period.reopen')
    for (const key of ['ads.campaign.write', 'ads.budget.write', 'ads.bid.write', 'ads.negative.write', 'ads.keyword.write', 'ads.placement.write', 'ads.portfolio.write', 'ads.rule.write']) {
      expect(byKey.ads.permissions).toContain(key)
    }
  })

  it('预设角色里的每个权限点都在目录里', () => {
    for (const role of PRESET_ROLES) expect(unknownPermissions(role.permissions.filter(key => key !== '*'))).toEqual([])
  })
})

describe('旧 16 个权限的映射', () => {
  it('旧权限正好 16 个，映射表覆盖全部旧点位', () => {
    expect(Object.values(PERMISSIONS)).toHaveLength(16)
    expect([...LEGACY_PERMISSION_KEYS].sort()).toEqual([...Object.values(PERMISSIONS)].sort())
  })

  it('映射目标全部是目录里的权限点或字段权限', () => {
    for (const targets of Object.values(LEGACY_PERMISSION_MAP)) expect(unknownPermissions([...targets])).toEqual([])
  })

  it('旧权限只有 finance.read 映射出字段权限（利润），不会放开成本与买家信息', () => {
    const withFields = Object.entries(LEGACY_PERMISSION_MAP).filter(([, targets]) => targets.some(key => key.startsWith('field.')))
    expect(withFields).toEqual([['finance.read', ['finance.read', 'profit.read', 'field.profit']]])
  })

  it('持有 seller.read 的旧角色展开后仍可读取库存、商品、入仓等；旧点位本身仍被识别', () => {
    const effective = effectivePermissions(['seller.read'])
    for (const key of ['products.read', 'inventory.read', 'inbound.read', 'purchase.read', 'supplier.read', 'warehouse.read', 'reports.read', 'connection.read', 'sync.read', 'seller.read']) {
      expect(hasPermission(effective, key)).toBe(true)
    }
    expect(hasPermission(effective, 'inventory.removal.receive')).toBe(false)
  })
})

describe('有效权限与字段权限', () => {
  it('所有登录成员自动具备基础权限', () => {
    const effective = effectivePermissions([])
    for (const key of BASE_PERMISSIONS) expect(effective).toContain(key)
  })

  it('字段权限：显式拒绝优先于旧映射；显式允许可补充；没有授权时看不到字段', () => {
    expect(canSeeField(effectivePermissions(['finance.read']), 'profit')).toBe(true)
    expect(canSeeField(effectivePermissions(['finance.read'], [{ fieldKey: 'profit', allowed: false }]), 'profit')).toBe(false)
    expect(canSeeField(effectivePermissions(['profit.read']), 'profit')).toBe(false)
    expect(canSeeField(effectivePermissions(['costs.read'], [{ fieldKey: 'cost', allowed: true }]), 'cost')).toBe(true)
    expect(visibleFields(effectivePermissions(['finance.read']))).toEqual(['profit'])
    expect(visibleFields(['*'])).toEqual(['cost', 'profit', 'buyer'])
    expect(visibleFields(effectivePermissions([]))).toEqual([])
  })

  it('迁移后的角色（legacy: false）不再按旧映射展开：finance.read 不隐含利润读取与利润字段', () => {
    const migrated = effectivePermissions(['finance.read'], [], { legacy: false })
    expect(migrated).toContain('finance.read')
    expect(migrated).not.toContain('profit.read')
    expect(canSeeField(migrated, 'profit')).toBe(false)
    expect(canSeeField(effectivePermissions(['finance.read'], [{ fieldKey: 'profit', allowed: true }], { legacy: false }), 'profit')).toBe(true)
  })

  it('通配权限视为拥有一切（含字段权限）', () => {
    expect(hasPermission(['*'], 'anything.at.all')).toBe(true)
    expect(canSeeField(effectivePermissions(['*']), 'buyer')).toBe(true)
  })

  it('权限点校验：不认识的点位被识别出来', () => {
    expect(isKnownPermission('orders.read')).toBe(true)
    expect(isKnownPermission('seller.read')).toBe(true)
    expect(unknownPermissions(['orders.read', 'orders.delete', 'nonsense'])).toEqual(['orders.delete', 'nonsense'])
  })
})
