import { useState } from 'react'
import { Alert, Button, Card, Descriptions, Space, Steps, Tag, Timeline, Tooltip } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useParams, useRouter } from '@tanstack/react-router'
import { TENANT_STATUS_LABELS, canTransition } from '@nova/api-contracts'
import { DataState } from '../components/data-state/DataState'
import { stateFromError } from '../components/data-state/from-error'
import { PageHeader } from '../components/page/PageHeader'
import { formatDateTime, formatNumber } from '../format'
import { describeError } from '../query/errors'
import { InvitationDialog } from './InvitationDialog'
import { hasPlatformPermission, platformMeQuery, tenantDetailQuery, tenantUsageQuery, type InvitationDelivery, type TenantDetail } from './platform-queries'
import { STATUS_COLOR } from './PlatformTenantsPage'
import { TenantActionDialog, type TenantAction } from './TenantActionDialog'
import { TenantCloseProgress } from './TenantCloseProgress'
import { SimpleGrid } from '../components'

// 租户详情（P1-19）：状态与操作、配额与用量、初始化进度、邀请记录、状态变更记录、支持访问授权记录。
// 操作按钮按“当前状态允许的流转 + 平台权限”显示；不可用的显示为禁用并说明原因，不隐藏也不假成功。

const INVITE_STATUS = { PENDING: ['待使用', 'blue'], ACCEPTED: ['已激活', 'green'], REVOKED: ['已作废', 'default'], EXPIRED: ['已过期', 'default'] } as const
const STEP_STATE = { PENDING: 'wait', COMPLETED: 'finish', SKIPPED: 'finish' } as const

function ActionButtons({ tenant, canManage, canQuota, open }: { tenant: TenantDetail; canManage: boolean; canQuota: boolean; open: (action: TenantAction) => void }) {
  const status = tenant.status
  const adminActivated = tenant.invitations.some(item => item.status === 'ACCEPTED')
  const closeFailed = status === 'CLOSING' && Boolean(tenant.closeProgress?.failed)
  const deny = (reason: string | null, label: string, action: TenantAction, options: { danger?: boolean } = {}) => {
    const button = (
      <Button key={action} danger={options.danger} disabled={Boolean(reason)} onClick={() => open(action)}>
        {label}
      </Button>
    )
    return reason ? (
      <Tooltip key={action} title={reason}>
        <span>{button}</span>
      </Tooltip>
    ) : (
      button
    )
  }
  const manage = (allowed: boolean, why: string) => (!canManage ? '需要“租户管理”权限' : allowed ? null : why)
  return (
    <Space wrap>
      {deny(manage(!adminActivated && ['TRIAL', 'ACTIVE', 'SUSPENDED'].includes(status), adminActivated ? '首个管理员已经激活，无需重发邀请' : '企业已停用或注销，不能重发邀请'), '重发邀请', 'invite')}
      {deny(manage(canTransition(status, 'SUSPENDED'), `${TENANT_STATUS_LABELS[status]}状态的企业不能暂停`), '暂停', 'suspend')}
      {deny(manage(canTransition(status, 'ACTIVE'), `${TENANT_STATUS_LABELS[status]}状态的企业不需要恢复`), '恢复', 'resume')}
      {deny(manage(canTransition(status, 'DEACTIVATED'), `${TENANT_STATUS_LABELS[status]}状态的企业不能停用`), '停用', 'deactivate', { danger: true })}
      {deny(
        manage(canTransition(status, 'CLOSING') || closeFailed, status === 'CLOSING' ? '企业正在注销中，请等待完成' : '只有已暂停或已停用的企业才能注销'),
        closeFailed ? '继续注销' : '注销',
        'close',
        { danger: true },
      )}
      {deny(!canQuota ? '需要“配额管理”权限' : status === 'CLOSED' ? '企业已注销' : null, '调整配额', 'quota')}
    </Space>
  )
}

export function PlatformTenantDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const router = useRouter()
  const me = useQuery(platformMeQuery).data
  const detail = useQuery(tenantDetailQuery(id))
  const usage = useQuery({ ...tenantUsageQuery(id), enabled: detail.isSuccess })
  const [action, setAction] = useState<TenantAction | null>(null)
  const [delivery, setDelivery] = useState<InvitationDelivery | null>(null)
  const canManage = hasPlatformPermission(me, 'platform.tenant.manage')
  const canQuota = hasPlatformPermission(me, 'platform.quota.manage')

  if (detail.isError) return <DataState {...stateFromError(describeError(detail.error), { permission: 'platform.tenant.manage', onRetry: () => void detail.refetch() })} />
  if (!detail.data) return <DataState kind="skeleton" />
  const tenant = detail.data
  const stats = usage.data

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader
        title={tenant.name}
        description={`${tenant.slug} · 开通于 ${formatDateTime(tenant.createdAt)}`}
        actions={<Button onClick={() => void router.navigate({ to: '/platform/tenants' })}>返回租户列表</Button>}
      />
      <Card size="small">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space>
            <Tag color={STATUS_COLOR[tenant.status]}>{tenant.statusLabel}</Tag>
            {tenant.statusChangedAt ? <span style={{ color: 'var(--ant-color-text-tertiary)' }}>{formatDateTime(tenant.statusChangedAt)} 起</span> : null}
          </Space>
          {tenant.status === 'DEACTIVATED' && tenant.retentionUntil ? (
            <Alert type="warning" showIcon message={`数据保留至 ${formatDateTime(tenant.retentionUntil)}`} description="保留期到期不会自动删除数据；需要彻底清除时请发起注销。" />
          ) : null}
          {tenant.status === 'CLOSED' ? <Alert type="info" showIcon message={`企业已于 ${formatDateTime(tenant.closedAt)} 注销`} description="业务数据已删除，仅保留审计记录与注销证明。" /> : null}
          <ActionButtons tenant={tenant} canManage={canManage} canQuota={canQuota} open={setAction} />
        </Space>
      </Card>

      {tenant.closeProgress ? <TenantCloseProgress tenant={tenant} canManage={canManage} /> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
        <Card size="small" title="基本信息">
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="数据口径时区">{tenant.timezone}</Descriptions.Item>
            <Descriptions.Item label="企业本地时区">{tenant.localTimezone}</Descriptions.Item>
            <Descriptions.Item label="显示币种">{tenant.defaultCurrency}</Descriptions.Item>
            <Descriptions.Item label="停用后保留">{tenant.retentionDays} 天</Descriptions.Item>
          </Descriptions>
        </Card>
        <Card size="small" title="配额与用量">
          <SimpleGrid
            gridId="platform.platform-tenant-detail-page"
            columns={[
              { title: '项目', dataIndex: 'label' },
              { title: '已用', dataIndex: 'used', align: 'right', render: (value: number) => formatNumber(value) },
              { title: '上限', dataIndex: 'limit', align: 'right', render: (value: number | null) => (value === null ? '不限' : formatNumber(value)) },
              { title: '状态', dataIndex: 'exceeded', width: 80, render: (exceeded: boolean) => (exceeded ? <Tag color="red">超额</Tag> : <Tag color="green">正常</Tag>) },
            ]}
            rows={tenant.quotas}
            rowKey={row => row.key}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
          {stats ? (
            <Descriptions size="small" column={2} style={{ marginTop: 12 }}>
              <Descriptions.Item label="已授权连接">{formatNumber(stats.connections)}</Descriptions.Item>
              <Descriptions.Item label="订单数">{formatNumber(stats.orders)}</Descriptions.Item>
              <Descriptions.Item label="近 24 小时同步">
                {formatNumber(stats.syncJobs24h)} 次（失败 {formatNumber(stats.syncFailed24h)}）
              </Descriptions.Item>
              <Descriptions.Item label="最近成功同步">{stats.lastSyncAt ? formatDateTime(stats.lastSyncAt) : '暂无'}</Descriptions.Item>
            </Descriptions>
          ) : null}
        </Card>
      </div>

      <Card size="small" title="初始化进度" extra={tenant.onboarding?.completed ? <Tag color="green">已完成</Tag> : <Tag color="gold">进行中</Tag>}>
        {tenant.onboarding ? (
          <>
            <Steps
              size="small"
              items={tenant.onboarding.steps.map(step => ({ title: step.title, status: STEP_STATE[step.state], description: step.state === 'SKIPPED' ? '已跳过' : step.required ? '必填' : '选填' }))}
              current={tenant.onboarding.steps.findIndex(step => step.state === 'PENDING')}
            />
            {tenant.onboarding.firstSync ? (
              <p style={{ marginBottom: 0, marginTop: 12 }}>
                首次同步已于 {formatDateTime(tenant.onboarding.firstSync.startedAt)} 启动：{tenant.onboarding.firstSync.jobs} 个任务，历史回补共 {tenant.onboarding.firstSync.segments} 段。
              </p>
            ) : null}
          </>
        ) : (
          <span>该企业早于初始化向导开通，无向导记录。</span>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
        <Card size="small" title="邀请记录">
          <SimpleGrid
            gridId="platform.platform-tenant-detail-page-2"
            columns={[
              { title: '受邀邮箱', dataIndex: 'email' },
              { title: '状态', dataIndex: 'status', width: 90, render: (status: keyof typeof INVITE_STATUS) => <Tag color={INVITE_STATUS[status][1]}>{INVITE_STATUS[status][0]}</Tag> },
              { title: '有效期至', dataIndex: 'expiresAt', render: (value: string) => formatDateTime(value) },
            ]}
            rows={tenant.invitations}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '暂无邀请记录' }}
          />
        </Card>
        <Card size="small" title="支持访问授权记录">
          <SimpleGrid
            gridId="platform.platform-tenant-detail-page-3"
            columns={[
              { title: '原因', dataIndex: 'reason', ellipsis: true },
              { title: '到期', dataIndex: 'expiresAt', width: 160, render: (value: string) => formatDateTime(value) },
              {
                title: '状态',
                key: 'state',
                width: 90,
                render: (_, row) =>
                  row.revoked ? <Tag>已撤销</Tag> : new Date(row.expiresAt) <= new Date() ? <Tag>已过期</Tag> : row.claimed ? <Tag color="blue">已领取</Tag> : <Tag color="green">待领取</Tag>,
              },
            ]}
            rows={tenant.supportAccesses}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '企业尚未授权过支持访问' }}
          />
        </Card>
      </div>

      <Card size="small" title="状态变更记录">
        {tenant.events.length === 0 ? (
          <span>暂无记录</span>
        ) : (
          <Timeline
            items={tenant.events.map(event => ({
              children: (
                <div>
                  <b>{event.from === event.to ? `${TENANT_STATUS_LABELS[event.to]}（开通）` : `${TENANT_STATUS_LABELS[event.from]} → ${TENANT_STATUS_LABELS[event.to]}`}</b>
                  <span style={{ marginLeft: 8, color: 'var(--ant-color-text-tertiary)' }}>{formatDateTime(event.at)}</span>
                  {event.reason ? <div>{event.reason}</div> : null}
                </div>
              ),
            }))}
          />
        )}
      </Card>

      <TenantActionDialog action={action} tenant={tenant} onClose={() => setAction(null)} onInvitation={setDelivery} />
      <InvitationDialog delivery={delivery} tenantName={tenant.name} onClose={() => setDelivery(null)} />
    </div>
  )
}
