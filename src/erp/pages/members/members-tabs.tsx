import { Descriptions, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { MEMBER_AUDIT_LIMIT, MEMBER_SESSION_LIMIT, permissionDeniedMessage, type MemberAuditView, type MemberDetail, type MemberGrantView, type MemberSessionView } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { Muted } from '../inventory/inventory-ui'
import { FieldTierText, PermissionSummary } from '../roles/roles-ui'
import { MemberStatusTag, lastLoginText } from './members-ui'

// 成员详情的四个页签：角色与权限、数据范围、登录与会话、操作审计。没有数据的位置写“尚无记录”，没有权限的位置写缺哪个权限点。

const truncatedNote = (limit: number) => <Typography.Text type="secondary">只显示最近 {limit} 条。</Typography.Text>

const SESSION_STATE_LABEL: Record<MemberSessionView['state'], string> = { ACTIVE: '使用中', EXPIRED: '已过期', REVOKED: '已退出或被收回' }
const GRANT_KIND_LABEL: Record<MemberGrantView['kind'], string> = { ALL: '全部', ENTITY: '主体', STORE: '店铺' }

const grantColumns: ColumnsType<MemberGrantView> = [
  { title: '类型', dataIndex: 'kind', width: 90, render: (value: MemberGrantView['kind']) => GRANT_KIND_LABEL[value] },
  { title: '主体或店铺', dataIndex: 'name', width: 260 },
  { title: '授权时间', dataIndex: 'grantedAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '备注', dataIndex: 'note', render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
]

const sessionColumns: ColumnsType<MemberSessionView> = [
  { title: '登录时间', dataIndex: 'loginAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '最近活动', dataIndex: 'lastSeenAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '来源地址', dataIndex: 'ipMasked', width: 150, render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '设备', dataIndex: 'device', render: (value: string | null) => value ?? <Muted>尚无记录</Muted> },
  { title: '状态', dataIndex: 'state', width: 130, render: (value: MemberSessionView['state']) => SESSION_STATE_LABEL[value] },
]

const auditColumns: ColumnsType<MemberAuditView> = [
  { title: '时间', dataIndex: 'occurredAt', width: 170, render: (value: string) => formatDateTime(value) },
  { title: '操作人', dataIndex: 'operator', width: 150 },
  { title: '动作', dataIndex: 'actionLabel', width: 150, render: (value: string, row) => (row.asActor ? `${value}（由该成员发起）` : value) },
  { title: '结果', dataIndex: 'result', width: 90 },
  { title: '原因', dataIndex: 'reason', render: (value: string | null) => value ?? <Muted>未填写</Muted> },
]

export function RoleTab({ detail }: { detail: MemberDetail }) {
  const { member, role } = detail
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="角色">
          {role.name}
          {role.system ? <Muted>（预设角色）</Muted> : null}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <MemberStatusTag status={member.status} />
        </Descriptions.Item>
        <Descriptions.Item label="角色说明" span={2}>
          {role.description ?? <Muted>尚无记录</Muted>}
        </Descriptions.Item>
        <Descriptions.Item label="字段权限" span={2}>
          <FieldTierText fields={role.fields} />
        </Descriptions.Item>
      </Descriptions>
      <div>
        <Typography.Title level={5}>拥有的权限</Typography.Title>
        <PermissionSummary role={role} />
      </div>
    </div>
  )
}

export function ScopeTab({ detail }: { detail: MemberDetail }) {
  return (
    <>
      <Typography.Paragraph>{detail.member.scope.label}</Typography.Paragraph>
      <SimpleGrid<MemberGrantView>
        gridId="members.members-tabs"
        columns={grantColumns}
        rows={detail.grants}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '数据范围', prerequisite: '这个成员还没有任何授权，看不到任何主体与店铺的数据。点“修改数据范围”授权。' }}
      />
    </>
  )
}

export function SessionTab({ detail }: { detail: MemberDetail }) {
  return (
    <>
      <Typography.Paragraph type="secondary">最近登录：{lastLoginText(detail.member.lastLoginAt)}。记录的是账号的登录，不区分企业。</Typography.Paragraph>
      <SimpleGrid<MemberSessionView>
        gridId="members.members-tabs-2"
        columns={sessionColumns}
        rows={detail.sessions}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '登录记录', prerequisite: '这个账号还没有登录过。' }}
      />
      {detail.sessionsTruncated ? truncatedNote(MEMBER_SESSION_LIMIT) : null}
    </>
  )
}

export function AuditTab({ detail }: { detail: MemberDetail }) {
  if (detail.audit.state === 'RESTRICTED') return <Muted>无权查看：{permissionDeniedMessage('audit.read')}</Muted>
  return (
    <>
      <SimpleGrid<MemberAuditView>
        gridId="members.members-tabs-3"
        columns={auditColumns}
        rows={detail.audit.items}
        rowKey={row => row.id}
        emptyState={{ kind: 'empty', domain: '操作审计', prerequisite: '这个成员还没有相关的操作记录。邀请、停用、改角色、改范围都会记在这里。' }}
      />
      {detail.audit.truncated ? truncatedNote(MEMBER_AUDIT_LIMIT) : null}
    </>
  )
}
