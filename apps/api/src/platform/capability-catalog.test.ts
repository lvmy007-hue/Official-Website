import { describe, expect, it } from 'vitest'
import { ENTITY_READ_PERMISSION, EXPORT_KINDS, SWITCH_CATALOG } from '@nova/api-contracts'
import { PERMISSION_CATALOG } from '@nova/authz'

const permissionKeys = new Set(PERMISSION_CATALOG.map(item => item.key))

describe('目录里引用的权限点必须都存在于权限目录', () => {
  it('写入开关要求的权限点', () => {
    for (const item of SWITCH_CATALOG) expect(permissionKeys.has(item.permission), `${item.key} → ${item.permission}`).toBe(true)
  })
  it('对象类型的读取权限点', () => {
    for (const [type, permission] of Object.entries(ENTITY_READ_PERMISSION)) if (permission) expect(permissionKeys.has(permission), `${type} → ${permission}`).toBe(true)
  })
  it('导出目录的读取权限点', () => {
    for (const kind of EXPORT_KINDS) expect(permissionKeys.has(kind.permission), `${kind.kind} → ${kind.permission}`).toBe(true)
  })
})
