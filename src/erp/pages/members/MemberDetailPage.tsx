import { useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Form, Select } from 'antd'
import { MEMBER_STEP_UP, type MemberChangeResult, type MemberDetail } from '@nova/api-contracts'
import { DataState, DetailLayout, FormAction, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { formatDate } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { AuditTab, RoleTab, ScopeTab, SessionTab } from './members-tabs'
import { ScopeFields, lastLoginText, roleOptionsOf, scopeBody, scopeInitialOf } from './members-ui'

// 成员详情（P5-08，09 章 9.10；骨架：整页详情）：角色与权限、数据范围、登录与会话、操作审计。
// 停用、恢复、改角色、改数据范围都由服务端给出能不能做及原因，页面只负责置灰与说明；这几项都需要再次验证身份，并写入审计。

const TABS = [
  ['role', '角色与权限'],
  ['scope', '数据范围'],
  ['session', '登录与会话'],
  ['audit', '操作审计'],
] as const

export default function MemberDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const [tab, setTab] = useState<string>('role')
  const path = `/members/${encodeURIComponent(id)}`
  const query = useApiQuery<MemberDetail>({ domain: 'list', path, scoped: false })
  const change = useApiMutation<{ action: string; body: Record<string, unknown> }, MemberChangeResult>({
    method: 'POST',
    path: variables => `${path}/${variables.action}`,
    body: variables => variables.body,
    invalidate: ['list', 'reference'],
    silent: true,
  })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'member.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />
  const detail = query.data
  const { member } = detail
  const active = member.status === 'ACTIVE'
  const manage = (reason: string | null) => ({ permission: 'member.manage', condition: { ok: reason === null, reason: reason ?? undefined } })
  const send = (action: string, body: Record<string, unknown>) => change.mutateAsync({ action, body })
  const metrics: IdentityMetric[] = [
    { label: '角色', value: member.roleName },
    { label: '数据范围', value: member.scope.label },
    { label: '最近登录', value: lastLoginText(member.lastLoginAt) },
    { label: '加入时间', value: formatDate(member.createdAt) },
  ]
  const body: Record<string, JSX.Element> = {
    role: <RoleTab detail={detail} />,
    scope: <ScopeTab detail={detail} />,
    session: <SessionTab detail={detail} />,
    audit: <AuditTab detail={detail} />,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AppLink to="/app/members">返回成员</AppLink>
      <DetailLayout
        title={member.name}
        subtitle={member.email}
        statuses={[{ text: active ? '使用中' : '已停用', color: active ? 'success' : 'default' }, ...(member.isSelf ? [{ text: '我自己', color: 'processing' as const }] : [])]}
        metrics={metrics}
        primaryActions={
          <>
            <FormAction
              label="修改角色"
              guard={manage(detail.actions.role)}
              title="修改角色"
              description="改后立即生效：成员的菜单、按钮和数据字段按新角色重新判断。"
              initialValues={{ roleId: member.roleId }}
              reason={{ label: '修改原因', placeholder: '例如：转岗到财务' }}
              stepUp={MEMBER_STEP_UP}
              okText="保存"
              successText="角色已修改"
              onSubmit={values => send('role', { roleId: values.roleId, reason: values.reason })}
            >
              <Form.Item label="角色" name="roleId" rules={[{ required: true, message: '请选择角色' }]} extra="只能授予你自己拥有的权限；所有者角色只有所有者能授予。">
                <Select aria-label="角色" options={roleOptionsOf(detail.roles)} optionFilterProp="label" />
              </Form.Item>
            </FormAction>
            <FormAction
              label="修改数据范围"
              guard={manage(detail.actions.scopes)}
              title="修改数据范围"
              description="决定成员能看哪些主体与店铺；所有者必须是“全部主体与店铺”。"
              initialValues={scopeInitialOf(detail.grants)}
              reason={{ label: '修改原因', placeholder: '例如：只负责德国站店铺' }}
              stepUp={MEMBER_STEP_UP}
              okText="保存"
              successText="数据范围已修改"
              onSubmit={values => send('scopes', { scope: scopeBody(values), reason: values.reason })}
            >
              <ScopeFields />
            </FormAction>
            {active ? (
              <FormAction
                label="停用"
                danger
                guard={manage(detail.actions.disable)}
                title="停用成员"
                description="停用后该成员不能再使用本企业，列表里保留历史与审计；之后可以恢复。"
                reason={{ label: '停用原因', placeholder: '例如：已离职' }}
                stepUp={MEMBER_STEP_UP}
                okText="停用"
                successText="已停用"
                onSubmit={values => send('disable', { reason: values.reason })}
              />
            ) : (
              <FormAction
                label="恢复"
                guard={manage(detail.actions.enable)}
                title="恢复成员"
                description="恢复后该成员可以重新使用本企业，角色与数据范围保持停用前的设置。"
                stepUp={MEMBER_STEP_UP}
                okText="恢复"
                successText="已恢复"
                onSubmit={() => send('enable', {})}
              />
            )}
          </>
        }
        tabs={TABS.map(([key, label]) => ({ key, label, children: body[key] }))}
        activeTab={tab}
        onTabChange={setTab}
      />
    </div>
  )
}
