import { Tag, Typography } from 'antd'
import { FIELD_META, permissionTree } from '@nova/authz'
import { ROLE_FIELD_KEYS, ROLE_FIELD_TIER_LABEL, type RoleFields, type RoleSummary } from '@nova/api-contracts'
import { Muted } from '../inventory/inventory-ui'

// 角色相关的共用小件：权限摘要（按模块与页面归并）、字段权限摘要。成员详情与角色页都用。

/** “成本：可见；利润：仅负责人可见……”：一句话写清三类敏感字段的等级。 */
export function FieldTierText({ fields }: { fields: RoleFields }) {
  return <span>{ROLE_FIELD_KEYS.map(key => `${FIELD_META[key].label}：${ROLE_FIELD_TIER_LABEL[fields[key]]}`).join('；')}</span>
}

/** 角色拥有的权限，按模块与页面归并成一行行文字；所有者写“全部权限”。 */
export function PermissionSummary({ role }: { role: Pick<RoleSummary, 'permissions'> }) {
  if (role.permissions.includes('*')) return <Typography.Text>全部权限（企业所有者），包括今后新增的权限点</Typography.Text>
  const granted = new Set(role.permissions)
  const modules = permissionTree()
    .map(module => ({
      module: module.module,
      pages: module.pages.map(page => ({ page: page.page, labels: page.actions.filter(action => granted.has(action.key)).map(action => action.label) })).filter(page => page.labels.length > 0),
    }))
    .filter(module => module.pages.length > 0)
  if (modules.length === 0) return <Muted>没有任何权限点</Muted>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {modules.map(module => (
        <div key={module.module}>
          <Tag bordered={false}>{module.module}</Tag>
          {module.pages.map(page => (
            <span key={page.page} style={{ marginRight: 12 }}>
              <Typography.Text strong>{page.page}</Typography.Text>
              <Typography.Text type="secondary">（{page.labels.join('、')}）</Typography.Text>
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
