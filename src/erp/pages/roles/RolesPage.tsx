import { Card, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ROLE_STEP_UP, type RoleEditorView, type RoleSaveResult, type RolesResponse } from '@nova/api-contracts'
import { FormAction, PageHeader, RowDetailDrawer, SimpleGrid, useRowDetail } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { FieldTierText, PermissionSummary } from './roles-ui'
import { RoleFormFields, blankRoleInitial, roleCreateBody, roleInitialOf, roleUpdateBody } from './roles-editor'

// 角色与权限（P5-08，09 章 9.10 与 CR-096；骨架：列表页 + 编辑弹窗）：角色列表、权限矩阵、字段权限三档。
// 预设角色只读，复制后再改；自定义角色带着看到的版本号修改，别人先改过会提示刷新；创建与修改都要再次验证身份并写入审计。

const countText = (role: RoleEditorView) => (role.permissions.includes('*') ? '全部' : `${role.permissions.length} 个`)

export default function RolesPage() {
  const list = useApiQuery<RolesResponse>({ domain: 'list', path: '/roles', scoped: false })
  const create = useApiMutation<Record<string, unknown>, RoleSaveResult>({ method: 'POST', path: '/roles', invalidate: ['list', 'reference'], silent: true })
  const update = useApiMutation<{ id: string; body: Record<string, unknown> }, RoleSaveResult>({
    method: 'PATCH',
    path: variables => `/roles/${encodeURIComponent(variables.id)}`,
    body: variables => variables.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })
  const data = list.data
  const detail = useRowDetail()
  const full = data ? data.customCount >= data.customLimit : false
  const createGuard = {
    permission: 'role.manage',
    condition: data
      ? { ok: data.canManage && !full, reason: data.manageBlockedReason ?? (full ? `自定义角色已达上限 ${data.customLimit} 个，请先整理不用的角色` : undefined) }
      : { ok: false, reason: '正在加载角色列表' },
  }

  const columns: ColumnsType<RoleEditorView> = [
    {
      title: '角色',
      dataIndex: 'name',
      width: 200,
      render: (value: string, row) => (
        <Space size={4}>
          <Typography.Text strong>{value}</Typography.Text>
          <Tag bordered={false}>{row.system ? '预设' : '自定义'}</Tag>
        </Space>
      ),
    },
    { title: '说明', dataIndex: 'description', width: 260, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
    { title: '权限点', key: 'count', width: 90, align: 'right', render: (_value, row) => countText(row) },
    { title: '字段权限', key: 'fields', width: 320, render: (_value, row) => <FieldTierText fields={row.fields} /> },
    { title: '使用中成员', dataIndex: 'memberCount', width: 110, align: 'right' },
    { title: '待接受邀请', dataIndex: 'invitationCount', width: 110, align: 'right' },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      fixed: 'right',
      render: (_value, row) => (
        <Space size={4}>
          <FormAction
            label="复制为自定义角色"
            guard={createGuard}
            title={`复制“${row.name}”为自定义角色`}
            description="新角色先带着原角色的全部权限，你可以在下面删减；创建后不影响原角色。"
            initialValues={roleInitialOf(row, true)}
            width={760}
            stepUp={ROLE_STEP_UP}
            okText="创建"
            successText="角色已创建"
            buttonProps={{ type: 'link', size: 'small' }}
            onSubmit={values => create.mutateAsync(roleCreateBody(values, row.id))}
          >
            <RoleFormFields />
          </FormAction>
          <FormAction
            label="编辑"
            guard={{ permission: 'role.manage', condition: { ok: row.canEdit, reason: row.editBlockedReason ?? undefined } }}
            title={`编辑角色“${row.name}”`}
            description={`保存后立即生效，会影响使用中的 ${row.memberCount} 位成员和 ${row.invitationCount} 个待接受的邀请。`}
            initialValues={roleInitialOf(row, false)}
            width={760}
            reason={{ label: '修改原因', placeholder: '例如：财务不再需要审批采购单' }}
            stepUp={ROLE_STEP_UP}
            okText="保存"
            successText="角色已保存"
            buttonProps={{ type: 'link', size: 'small' }}
            onSubmit={values => update.mutateAsync({ id: row.id, body: roleUpdateBody(values, row.version) })}
          >
            <RoleFormFields />
          </FormAction>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="角色与权限" description="角色决定成员能做什么：权限点按模块、页面、动作分组；成本、利润、买家信息另有字段权限。" actions={<AppLink to="/app/members">返回成员</AppLink>} />
      <Card size="small">
        <Space wrap style={{ marginBottom: 8 }}>
          <FormAction
            label="新建角色"
            guard={createGuard}
            title="新建角色"
            description="从空白开始勾选权限；想在现有角色基础上改，请在列表里点“复制为自定义角色”。"
            initialValues={blankRoleInitial}
            width={760}
            stepUp={ROLE_STEP_UP}
            okText="创建"
            successText="角色已创建"
            buttonProps={{ type: 'primary' }}
            onSubmit={values => create.mutateAsync(roleCreateBody(values))}
          >
            <RoleFormFields />
          </FormAction>
          {data ? (
            <Typography.Text type="secondary">
              共 {data.items.length} 个角色，自定义 {data.customCount} / {data.customLimit}
            </Typography.Text>
          ) : null}
        </Space>
        {data && !data.canManage && data.manageBlockedReason ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            当前账号只能查看角色：{data.manageBlockedReason}
          </Typography.Paragraph>
        ) : null}
        <SimpleGrid<RoleEditorView>
          gridId="roles.list"
          columns={columns}
          rows={data?.items}
          rowKey={row => row.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowOpen={row => detail.open(row.id)}
          emptyState={{ kind: 'empty', domain: '角色', prerequisite: '企业里还没有角色。预设角色会在企业创建时自动生成；如果这里为空请联系支持。' }}
        />
        <RowDetailDrawer rows={data?.items} rowKey={row => row.id} openKey={detail.openKey} onClose={detail.close} title={row => `权限概览：${row.name}`}>
          {row => <PermissionSummary role={row} />}
        </RowDetailDrawer>
      </Card>
    </div>
  )
}
