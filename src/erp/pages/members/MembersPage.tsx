import { useCallback, useState } from 'react'
import { Alert, Card, Form, Input, Modal, Select, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { INVITATION_TTL_HOURS, memberStatusLabel, type InviteResult, type MemberInvitationRow, type MemberListResponse, type MemberRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { FormAction, PageHeader, SimpleGrid, SimplePagedGrid, type PageFetcher } from '../../components'
import { formatDate, formatDateTime } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { buildPath, useApiMutation } from '../../query/api-query'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'
import { MemberStatusTag, ScopeFields, lastLoginText, roleOptionsOf, scopeBody } from './members-ui'

// 成员列表（P5-08，09 章 9.10；骨架：列表页）：姓名、邮箱、状态、角色、数据范围、最近登录；另列待接受的邀请。
// 能不能邀请、能不能管理都由服务端返回（含原因），页面只负责置灰与说明；邀请需要“全部店铺”数据范围，因为成员会影响企业全部数据。

const columns: ColumnsType<MemberRow> = [
  {
    title: '姓名',
    dataIndex: 'name',
    width: 160,
    render: (value: string, row) => (
      <Space size={4}>
        <AppLink to={`/app/members/${encodeURIComponent(row.id)}`}>{value}</AppLink>
        {row.isSelf ? <Muted>（我）</Muted> : null}
      </Space>
    ),
  },
  { title: '邮箱', dataIndex: 'email', width: 230 },
  { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => <MemberStatusTag status={value} /> },
  { title: '角色', dataIndex: 'roleName', width: 130 },
  { title: '数据范围', key: 'scope', width: 260, render: (_value, row) => row.scope.label },
  { title: '最近登录', dataIndex: 'lastLoginAt', width: 160, render: (value: string | null) => lastLoginText(value) },
  { title: '加入时间', dataIndex: 'createdAt', width: 110, render: (value: string) => formatDate(value) },
]

const invitationColumns: ColumnsType<MemberInvitationRow> = [
  { title: '邮箱', dataIndex: 'email', width: 240 },
  { title: '角色', dataIndex: 'roleName', width: 130 },
  { title: '数据范围', dataIndex: 'scopeLabel', width: 260 },
  { title: '邀请人', dataIndex: 'invitedByName', width: 130, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '有效期至', dataIndex: 'expiresAt', width: 160, render: (value: string) => formatDateTime(value) },
]

function InviteResultDialog({ result, onClose }: { result: InviteResult | null; onClose: () => void }) {
  return (
    <Modal open={result !== null} title="邀请已创建" onCancel={onClose} onOk={onClose} okText="知道了" cancelButtonProps={{ style: { display: 'none' } }} maskClosable={false}>
      {result ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {result.emailed ? (
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              邀请邮件已发送到 {result.email}，{INVITATION_TTL_HOURS} 小时内有效。
            </Typography.Paragraph>
          ) : (
            <>
              <Alert
                type="warning"
                showIcon
                message="邮件通道尚未配置，邀请邮件没有发出"
                description="请复制下面的链接发给对方。链接只在这里显示一次，关闭后无法再查看；需要时重新邀请即可（旧链接会作废）。"
              />
              <Typography.Paragraph copyable={{ text: result.link ?? '' }} code style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                {result.link}
              </Typography.Paragraph>
            </>
          )}
          {result.replacedPrevious > 0 ? <Typography.Text type="secondary">同一邮箱之前未接受的 {result.replacedPrevious} 封邀请已作废。</Typography.Text> : null}
          {result.warnings.map(text => (
            <Alert key={text} type="warning" showIcon message={text} />
          ))}
        </Space>
      ) : null}
    </Modal>
  )
}

export default function MembersPage() {
  const { canPermission } = useSession()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [roleId, setRoleId] = useState<string | undefined>()
  const [version, setVersion] = useState(0)
  const [data, setData] = useState<MemberListResponse | null>(null)
  const [invited, setInvited] = useState<InviteResult | null>(null)
  const fetchPage = useCallback<PageFetcher<MemberRow>>(
    async ({ page, pageSize, signal }) => {
      const response = await apiFetch<MemberListResponse>(buildPath('/members', { q: q || undefined, status, roleId, page, pageSize }), { signal })
      setData(response)
      return { items: response.items, total: response.total }
    },
    [q, status, roleId],
  )
  const invite = useApiMutation<Record<string, unknown>, InviteResult>({ method: 'POST', path: '/members/invite', invalidate: ['list', 'reference'], silent: true })
  const filtered = Boolean(q || status || roleId)

  return (
    <div>
      <PageHeader
        title="成员"
        description="企业里的账号：角色决定能做什么，数据范围决定能看哪些主体与店铺。停用、改角色、改范围都会写入审计。"
        actions={canPermission('role.manage') ? <AppLink to="/app/roles">管理角色与权限</AppLink> : undefined}
      />
      <Card size="small">
        <Space wrap style={{ marginBottom: 8 }}>
          <FormAction
            label="邀请成员"
            guard={{ permission: 'member.invite', condition: data ? { ok: data.canInvite, reason: data.inviteBlockedReason ?? undefined } : { ok: false, reason: '正在加载成员列表' } }}
            title="邀请成员"
            description={`对方会收到一次性邀请链接（${INVITATION_TTL_HOURS} 小时内有效），设置姓名与密码后即可使用。`}
            okText="发送邀请"
            buttonProps={{ type: 'primary' }}
            initialValues={{ scopeMode: 'ALL' }}
            onSubmit={async values => {
              setInvited(await invite.mutateAsync({ email: String(values.email ?? '').trim(), roleId: values.roleId, scope: scopeBody(values) }))
              setVersion(current => current + 1)
            }}
          >
            <Form.Item
              label="邮箱"
              name="email"
              rules={[
                { required: true, whitespace: true, message: '请填写邮箱' },
                { type: 'email', message: '请填写正确的邮箱' },
              ]}
            >
              <Input aria-label="邮箱" maxLength={254} placeholder="name@company.com" />
            </Form.Item>
            <Form.Item label="角色" name="roleId" rules={[{ required: true, message: '请选择角色' }]} extra="只能授予你自己拥有的权限；所有者角色只有所有者能授予。">
              <Select aria-label="角色" placeholder="选择角色" options={roleOptionsOf(data?.roles)} optionFilterProp="label" />
            </Form.Item>
            <ScopeFields />
          </FormAction>
          <Input.Search
            allowClear
            style={{ width: 260 }}
            placeholder="搜索姓名或邮箱"
            aria-label="搜索"
            onSearch={value => {
              setQ(value.trim())
            }}
          />
          <Select
            allowClear
            style={{ width: 130 }}
            placeholder="全部状态"
            aria-label="状态筛选"
            value={status}
            options={['ACTIVE', 'DISABLED'].map(value => ({ value, label: memberStatusLabel(value) }))}
            onChange={value => {
              setStatus(value)
            }}
          />
          <Select
            allowClear
            style={{ width: 160 }}
            placeholder="全部角色"
            aria-label="角色筛选"
            value={roleId}
            options={roleOptionsOf(data?.roles)}
            onChange={value => {
              setRoleId(value)
            }}
          />
          {data ? (
            <Typography.Text type="secondary">
              共 {data.summary.total} 人：使用中 {data.summary.active}，已停用 {data.summary.disabled}；待接受的邀请 {data.summary.pendingInvitations}
            </Typography.Text>
          ) : null}
        </Space>
        {data && !data.canManage && data.manageBlockedReason ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            当前账号只能查看成员：{data.manageBlockedReason}
          </Typography.Paragraph>
        ) : null}
        <SimplePagedGrid<MemberRow>
          gridId="members.list"
          columns={columns}
          fetchPage={fetchPage}
          rowKey={row => row.id}
          resetKey={JSON.stringify([q, status, roleId, version])}
          emptyState={{
            kind: 'empty',
            domain: '成员',
            prerequisite: filtered ? '没有符合条件的成员，调整搜索词、状态或角色后再试。' : '企业里还没有成员。点“邀请成员”发出邀请。',
          }}
        />
      </Card>
      {data && data.invitations.length > 0 ? (
        <Card size="small" title={`待接受的邀请（${data.summary.pendingInvitations}）`} style={{ marginTop: 12 }}>
          <SimpleGrid<MemberInvitationRow>
            gridId="members.members-page"
            columns={invitationColumns}
            rows={data.invitations}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '待接受的邀请', prerequisite: '没有待接受的邀请。' }}
          />
          {data.summary.pendingInvitations > data.invitations.length ? <Typography.Text type="secondary">只显示最近 {data.invitations.length} 条。</Typography.Text> : null}
        </Card>
      ) : null}
      <InviteResultDialog result={invited} onClose={() => setInvited(null)} />
    </div>
  )
}
