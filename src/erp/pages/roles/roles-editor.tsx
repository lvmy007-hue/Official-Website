import { useMemo } from 'react'
import { Alert, Checkbox, Form, Input, Select, Tooltip, Typography, theme } from 'antd'
import { FIELD_META, SEPARATION_OF_DUTIES, keysOfModule, keysOfPage, permissionTree } from '@nova/authz'
import {
  ROLE_DESCRIPTION_MAX,
  ROLE_EMPTY_PERMISSIONS,
  ROLE_FIELD_KEYS,
  ROLE_FIELD_TIERS,
  ROLE_FIELD_TIER_LABEL,
  ROLE_FIELD_TIER_NOTE,
  ROLE_NAME_MAX,
  separationConflicts,
  separationMessage,
  type RoleFields,
  type RoleSummary,
} from '@nova/api-contracts'
import { useSession } from '../../session/session'

// 角色编辑器的表单部分（P5-08，CR-096）：名称与说明、权限矩阵（模块 → 页面 → 动作，整组勾选，每个权限点写明影响范围）、字段权限三档。
// 前端只做提示与置灰：自己没有的权限点不能授予、职责分离冲突当场提示；最终以服务端校验为准。

type RoleFormValues = Record<string, unknown> & { name?: string; description?: string; permissions?: string[]; fields?: Partial<RoleFields> }

const allKeys = () => permissionTree().flatMap(keysOfModule)

/** 复制角色时名称加“副本”；所有者的通配权限展开成全部权限点，方便在上面删减。 */
export function roleInitialOf(role: Pick<RoleSummary, 'name' | 'description' | 'permissions' | 'fields'>, copy: boolean): RoleFormValues {
  return { name: copy ? `${role.name} 副本` : role.name, description: role.description ?? '', permissions: role.permissions.includes('*') ? allKeys() : role.permissions, fields: role.fields }
}

export const blankRoleInitial: RoleFormValues = { name: '', description: '', permissions: [], fields: { cost: 'HIDDEN', profit: 'HIDDEN', buyer: 'HIDDEN' } }

export const roleCreateBody = (values: RoleFormValues, copyFromRoleId?: string) => ({
  name: String(values.name ?? '').trim(),
  ...(values.description?.trim() ? { description: values.description.trim() } : {}),
  ...(copyFromRoleId ? { copyFromRoleId } : {}),
  permissions: values.permissions ?? [],
  fields: values.fields,
})

export const roleUpdateBody = (values: RoleFormValues, version: number) => ({
  version,
  name: String(values.name ?? '').trim(),
  description: values.description?.trim() ? values.description.trim() : null,
  permissions: values.permissions ?? [],
  fields: values.fields,
  reason: values.reason,
})

type MatrixProps = { value?: string[]; onChange?: (value: string[]) => void }

export function PermissionMatrix({ value = [], onChange }: MatrixProps) {
  const { me } = useSession()
  const { token } = theme.useToken()
  const tree = useMemo(() => permissionTree(), [])
  const labels = useMemo(() => new Map(tree.flatMap(module => module.pages.flatMap(page => page.actions.map(action => [action.key, action.label] as const)))), [tree])
  const selected = new Set(value)
  const wildcard = me.permissions.includes('*')
  const canGrant = (key: string) => wildcard || me.permissions.includes(key)
  const conflicts = separationConflicts(value, SEPARATION_OF_DUTIES)

  const apply = (keys: string[], on: boolean) => {
    const next = new Set(value)
    for (const key of keys) {
      if (on && !canGrant(key)) continue
      if (on) next.add(key)
      else next.delete(key)
    }
    onChange?.([...next])
  }
  const group = (keys: string[], name: string, label: string, bold: boolean) => {
    const grantable = keys.filter(canGrant)
    const checked = grantable.length > 0 && grantable.every(key => selected.has(key))
    const some = keys.some(key => selected.has(key))
    return (
      <Checkbox aria-label={`${name} ${label}`} checked={checked} indeterminate={!checked && some} disabled={grantable.length === 0 && !some} onChange={event => apply(keys, event.target.checked)}>
        <Typography.Text strong={bold}>{label}</Typography.Text>
      </Checkbox>
    )
  }

  return (
    <div>
      <div role="group" aria-label="权限矩阵" style={{ maxHeight: 420, overflow: 'auto', border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 6, padding: 12 }}>
        {tree.map(module => (
          <div key={module.module} style={{ marginBottom: 12 }}>
            {group(keysOfModule(module), '模块', module.module, true)}
            {module.pages.map(page => (
              <div key={page.page} style={{ marginLeft: 20, marginTop: 4 }}>
                {group(keysOfPage(page), '页面', page.page, false)}
                {page.actions.map(action => (
                  <div key={action.key} style={{ marginLeft: 22 }}>
                    <Tooltip title={canGrant(action.key) ? undefined : '你自己没有这个权限点，不能授予给别人'}>
                      <Checkbox checked={selected.has(action.key)} disabled={!canGrant(action.key) && !selected.has(action.key)} onChange={event => apply([action.key], event.target.checked)}>
                        {action.label}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {' '}
                          — {action.impact}
                        </Typography.Text>
                      </Checkbox>
                    </Tooltip>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <Typography.Text type="secondary">已选 {value.length} 个权限点</Typography.Text>
      {conflicts.length > 0 ? <Alert style={{ marginTop: 8 }} type="error" showIcon message={separationMessage(conflicts, key => labels.get(key) ?? key)} /> : null}
    </div>
  )
}

/** 角色表单的全部字段：放进 FormAction 的 children。 */
export function RoleFormFields() {
  return (
    <>
      <Form.Item
        label="角色名称"
        name="name"
        rules={[
          { required: true, whitespace: true, message: '请填写角色名称' },
          { min: 2, message: '角色名称至少 2 个字' },
        ]}
      >
        <Input aria-label="角色名称" maxLength={ROLE_NAME_MAX} />
      </Form.Item>
      <Form.Item label="角色说明" name="description">
        <Input.TextArea aria-label="角色说明" rows={2} maxLength={ROLE_DESCRIPTION_MAX} showCount placeholder="这个角色给谁用、能做什么" />
      </Form.Item>
      <Form.Item
        label="权限"
        name="permissions"
        rules={[{ validator: (_rule, value: string[] | undefined) => ((value?.length ?? 0) > 0 ? Promise.resolve() : Promise.reject(new Error(ROLE_EMPTY_PERMISSIONS))) }]}
        extra="勾选模块或页面可整组选择；你自己没有的权限点不能授予。创建与审批类的权限点不能放在同一个角色里。"
      >
        <PermissionMatrix />
      </Form.Item>
      <Typography.Text strong>字段权限</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {ROLE_FIELD_TIERS.map(tier => `${ROLE_FIELD_TIER_LABEL[tier]}：${ROLE_FIELD_TIER_NOTE[tier]}`).join('。')}。
        说明：“仅负责人可见”按商品负责人判断，只对成本与利润有意义；汇总类页面没有负责人，这类字段在那里不显示。买家信息没有负责人，只有可见与不可见两档。
      </Typography.Paragraph>
      {ROLE_FIELD_KEYS.map(key => (
        <Form.Item key={key} label={FIELD_META[key].label} name={['fields', key]} extra={FIELD_META[key].impact} style={{ marginTop: 8 }}>
          <Select
            aria-label={`${FIELD_META[key].label}字段权限`}
            options={ROLE_FIELD_TIERS.filter(tier => tier !== 'OWNER_ONLY' || FIELD_META[key].ownerOnlyAllowed).map(tier => ({ value: tier, label: ROLE_FIELD_TIER_LABEL[tier] }))}
          />
        </Form.Item>
      ))}
    </>
  )
}
