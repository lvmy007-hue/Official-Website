import { useState } from 'react'
import { Button, Input, Select, Space, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { TENANT_LIFECYCLE_STATUSES, TENANT_STATUS_LABELS, type TenantLifecycleStatus } from '@nova/api-contracts'
import { DataState } from '../components/data-state/DataState'
import { stateFromError } from '../components/data-state/from-error'
import { PageHeader } from '../components/page/PageHeader'
import { formatDateTime } from '../format'
import { describeError } from '../query/errors'
import { InvitationDialog } from './InvitationDialog'
import { platformFetch } from './platform-api'
import { hasPlatformPermission, platformMeQuery, tenantListPath, type InvitationDelivery, type TenantListItem, type TenantListPage, type TenantListParams } from './platform-queries'
import { TenantCreateModal } from './TenantCreateModal'
import { SimpleGrid } from '../components'

// 租户列表与开通（P1-19）：按名称/标识、状态筛选；游标分页（加载更多）。企业数据本身不在这里出现——这里只有企业的开通状态与规模。

export const STATUS_COLOR: Record<TenantLifecycleStatus, string> = { TRIAL: 'blue', ACTIVE: 'green', SUSPENDED: 'orange', DEACTIVATED: 'default', CLOSING: 'purple', CLOSED: 'default' }

export function PlatformTenantsPage() {
  const router = useRouter()
  const me = useQuery(platformMeQuery).data
  const canManage = hasPlatformPermission(me, 'platform.tenant.manage')
  const [params, setParams] = useState<TenantListParams>({})
  const [creating, setCreating] = useState(false)
  const [delivery, setDelivery] = useState<{ invitation: InvitationDelivery; tenantName: string } | null>(null)

  const list = useInfiniteQuery({
    queryKey: ['platform', 'tenants', params],
    queryFn: ({ pageParam }) => platformFetch<TenantListPage>(tenantListPath(params, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: last => (last.pageInfo.hasMore ? last.pageInfo.nextCursor : undefined),
    retry: false,
  })
  const rows = list.data?.pages.flatMap(page => page.items)

  const columns: ColumnsType<TenantListItem> = [
    {
      title: '企业',
      key: 'name',
      render: (_, row) => (
        <div>
          <div>{row.name}</div>
          <div style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}>{row.slug}</div>
        </div>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (status: TenantLifecycleStatus) => <Tag color={STATUS_COLOR[status]}>{TENANT_STATUS_LABELS[status]}</Tag> },
    { title: '店铺', dataIndex: 'stores', width: 70, align: 'right' },
    { title: '成员', dataIndex: 'members', width: 70, align: 'right' },
    { title: '初始化', dataIndex: 'onboardingCompleted', width: 90, render: (done: boolean) => (done ? <Tag color="green">已完成</Tag> : <Tag color="gold">进行中</Tag>) },
    { title: '开通时间', dataIndex: 'createdAt', width: 170, render: (value: string) => formatDateTime(value) },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, row) =>
        canManage ? (
          <Button type="link" size="small" onClick={() => void router.navigate({ to: `/platform/tenants/${row.id}` })}>
            查看详情
          </Button>
        ) : (
          <Tooltip title="需要“租户管理”权限才能查看详情">
            <Button type="link" size="small" disabled>
              查看详情
            </Button>
          </Tooltip>
        ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="租户"
        description="企业的开通、邀请、暂停、停用与注销。这里只显示企业的开通状态与规模，不显示企业的业务数据。"
        actions={
          canManage ? (
            <Button type="primary" onClick={() => setCreating(true)}>
              开通企业
            </Button>
          ) : (
            <Tooltip title="需要“租户管理”权限才能开通企业">
              <Button type="primary" disabled>
                开通企业
              </Button>
            </Tooltip>
          )
        }
      />
      <Space style={{ margin: '8px 0 12px' }} wrap>
        <Input.Search allowClear placeholder="搜索企业名称或标识" style={{ width: 260 }} onSearch={value => setParams(prev => ({ ...prev, q: value.trim() || undefined }))} />
        <Select<TenantLifecycleStatus>
          allowClear
          placeholder="全部状态"
          style={{ width: 140 }}
          options={TENANT_LIFECYCLE_STATUSES.map(status => ({ value: status, label: TENANT_STATUS_LABELS[status] }))}
          onChange={status => setParams(prev => ({ ...prev, status: status ?? undefined }))}
        />
      </Space>
      {list.isError ? (
        <DataState {...stateFromError(describeError(list.error), { permission: 'platform.tenant.read', onRetry: () => void list.refetch() })} />
      ) : list.isPending ? (
        <DataState kind="skeleton" rows={5} />
      ) : rows && rows.length === 0 ? (
        <DataState kind="empty" domain="企业列表" prerequisite={params.q || params.status ? '没有符合筛选条件的企业，请调整筛选。' : '还没有开通任何企业。点击右上角“开通企业”创建第一个。'} />
      ) : (
        <>
          <SimpleGrid<TenantListItem>
            gridId="platform.platform-tenants-page"
            columns={columns}
            rows={rows}
            rowKey={row => row.id}
            emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
          />
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            {list.hasNextPage ? (
              <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                加载更多
              </Button>
            ) : (
              <span style={{ color: 'var(--ant-color-text-tertiary)' }}>已显示全部 {rows?.length ?? 0} 家企业</span>
            )}
          </div>
        </>
      )}
      <TenantCreateModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={result => {
          setCreating(false)
          setDelivery({ invitation: result.invitation, tenantName: result.tenant.name })
        }}
      />
      <InvitationDialog delivery={delivery?.invitation ?? null} tenantName={delivery?.tenantName ?? ''} onClose={() => setDelivery(null)} />
    </div>
  )
}
