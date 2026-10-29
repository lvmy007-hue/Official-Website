import { describe, expect, it } from 'vitest'
import { canSeeField, effectivePermissions, fieldTierOf, hasPermission, ownerFieldPermission, withOwnedFields } from './index'

// 字段权限的第三档“仅负责人可见”（P5-08）：有效权限里只留 field.X.own 标记，具体商品的负责人才升级成 field.X。

describe('字段权限三档', () => {
  it('档位：不可见、可见、仅负责人可见', () => {
    expect(fieldTierOf(null)).toBe('HIDDEN')
    expect(fieldTierOf({ allowed: false })).toBe('HIDDEN')
    expect(fieldTierOf({ allowed: false, ownerOnly: true })).toBe('HIDDEN')
    expect(fieldTierOf({ allowed: true })).toBe('VISIBLE')
    expect(fieldTierOf({ allowed: true, ownerOnly: false })).toBe('VISIBLE')
    expect(fieldTierOf({ allowed: true, ownerOnly: true })).toBe('OWNER_ONLY')
  })

  it('仅负责人可见：有效权限里没有 field.cost，只有 field.cost.own；没有处理负责人的接口一律看不到（宁可少给）', () => {
    const permissions = effectivePermissions(
      ['costs.read'],
      [
        { fieldKey: 'cost', allowed: true, ownerOnly: true },
        { fieldKey: 'profit', allowed: true },
      ],
      { legacy: false },
    )
    expect(permissions).toContain(ownerFieldPermission('cost'))
    expect(permissions).not.toContain('field.cost')
    expect(permissions).toContain('field.profit')
    expect(canSeeField(permissions, 'cost')).toBe(false)
    expect(canSeeField(permissions, 'profit')).toBe(true)
  })

  it('仅负责人可见：显式设置压过旧映射带出的字段权限', () => {
    const permissions = effectivePermissions(['finance.read'], [{ fieldKey: 'profit', allowed: true, ownerOnly: true }], { legacy: true })
    expect(permissions).not.toContain('field.profit')
    expect(permissions).toContain('field.profit.own')
  })

  it('针对某个商品：负责人升级成完整字段权限，别的权限不变；通配与没有标记的不受影响', () => {
    const base = ['orders.read', 'field.cost.own', 'field.profit']
    const owned = withOwnedFields(base)
    expect(owned).toEqual(expect.arrayContaining(['field.cost', 'field.profit', 'field.cost.own', 'orders.read']))
    expect(owned).not.toContain('field.buyer')
    expect(hasPermission(base, 'field.cost')).toBe(false)
    expect(hasPermission(owned, 'field.cost')).toBe(true)
    expect(withOwnedFields(['*'])).toEqual(['*'])
    expect(withOwnedFields(['orders.read'])).toEqual(['orders.read'])
  })
})
