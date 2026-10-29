import { describe, expect, it } from 'vitest'
import { FIELD_KEYS, effectivePermissions, fieldTierOf, withOwnedFields } from './index'
import { PERMISSION_CATALOG } from './catalog'
import { FIELD_META, PERMISSION_META, keysOfModule, keysOfPage, permissionTree } from './permission-tree'

describe('权限树：模块 → 页面 → 动作', () => {
  it('权限目录里的每个权限点都有页面与影响范围，没有多余的说明', () => {
    const catalogKeys = new Set(PERMISSION_CATALOG.map(entry => entry.key))
    expect(PERMISSION_CATALOG.filter(entry => !PERMISSION_META[entry.key]).map(entry => entry.key)).toEqual([])
    expect(Object.keys(PERMISSION_META).filter(key => !catalogKeys.has(key))).toEqual([])
    for (const [key, meta] of Object.entries(PERMISSION_META)) {
      expect(meta.page.trim(), key).not.toBe('')
      expect(meta.impact.startsWith('能'), `${key} 的影响范围要写“能……”`).toBe(true)
    }
  })

  it('三级分组覆盖目录里的全部权限点，每个点只出现一次', () => {
    const tree = permissionTree()
    const keys = tree.flatMap(keysOfModule)
    expect(keys.length).toBe(PERMISSION_CATALOG.length)
    expect(new Set(keys).size).toBe(keys.length)
    expect(tree.map(node => node.module)).toEqual([...new Set(PERMISSION_CATALOG.map(entry => entry.group))])
    for (const node of tree) for (const page of node.pages) expect(keysOfPage(page).length).toBeGreaterThan(0)
  })

  it('同一页面的动作归在一起：成员页有查看、邀请、管理三个动作', () => {
    const members = permissionTree()
      .flatMap(node => node.pages)
      .find(page => page.page === '成员')
    expect(members?.actions.map(action => action.key)).toEqual(['member.read', 'member.invite', 'member.manage'])
    expect(members?.actions[2]?.impact).toContain('再次验证身份')
  })

  it('只有成本与利润可以设为“仅负责人可见”，买家信息不行', () => {
    expect(FIELD_KEYS.map(field => [field, FIELD_META[field].ownerOnlyAllowed])).toEqual([
      ['cost', true],
      ['profit', true],
      ['buyer', false],
    ])
  })
})

describe('字段权限三档', () => {
  it('档位：没有记录与不允许都是不可见；允许且仅负责人是第二档', () => {
    expect(fieldTierOf(undefined)).toBe('HIDDEN')
    expect(fieldTierOf({ allowed: false, ownerOnly: true })).toBe('HIDDEN')
    expect(fieldTierOf({ allowed: true })).toBe('VISIBLE')
    expect(fieldTierOf({ allowed: true, ownerOnly: true })).toBe('OWNER_ONLY')
  })

  it('仅负责人可见：有效权限里没有 field.cost，只有 field.cost.own 标记；旧映射带出的字段权限也被收回', () => {
    const permissions = effectivePermissions(['finance.read'], [{ fieldKey: 'profit', allowed: true, ownerOnly: true }], { legacy: true })
    expect(permissions).toContain('field.profit.own')
    expect(permissions).not.toContain('field.profit')
    const open = effectivePermissions([], [{ fieldKey: 'cost', allowed: true }])
    expect(open).toContain('field.cost')
    expect(open).not.toContain('field.cost.own')
  })

  it('withOwnedFields：负责人把标记升级成完整字段权限；通配与没有标记的权限集合原样', () => {
    const permissions = effectivePermissions(['profit.read'], [{ fieldKey: 'profit', allowed: true, ownerOnly: true }], { legacy: false })
    expect(withOwnedFields(permissions)).toContain('field.profit')
    expect(withOwnedFields(['costs.read'])).toEqual(['costs.read'])
    expect(withOwnedFields(['*'])).toEqual(['*'])
  })
})
