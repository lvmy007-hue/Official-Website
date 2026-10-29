import { Alert } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { SyncQueueRow, SyncQueuesResponse } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'

// 队列监控：每个队列的积压（等待、执行、延后、队列内失败）与本企业的占用、近一小时的吞吐。
// 积压是整个平台的合计，队列本身不区分企业；本企业一列来自本企业的同步任务记录。队列读不到时如实说明，不拿 0 冒充。

const num = (value: number) => <span className="erp-num">{value.toLocaleString('zh-CN')}</span>
const mine = (row: SyncQueueRow, pick: (tenant: NonNullable<SyncQueueRow['tenant']>) => number) => (row.tenant ? num(pick(row.tenant)) : <Muted>不适用</Muted>)

const columns: ColumnsType<SyncQueueRow> = [
  {
    title: '队列',
    key: 'queue',
    width: 260,
    render: (_value, row) => (
      <div>
        {row.label}
        <div style={{ fontSize: 12 }}>
          <Muted>{row.queue}</Muted>
        </div>
      </div>
    ),
  },
  { title: '等待', dataIndex: 'waiting', width: 80, align: 'right', render: num },
  { title: '执行中', dataIndex: 'active', width: 80, align: 'right', render: num },
  { title: '延后', dataIndex: 'delayed', width: 80, align: 'right', render: num },
  { title: '队列内失败', dataIndex: 'failed', width: 100, align: 'right', render: num },
  { title: '本企业等待', key: 'tw', width: 100, align: 'right', render: (_value, row) => mine(row, tenant => tenant.waiting) },
  { title: '本企业执行中', key: 'ta', width: 110, align: 'right', render: (_value, row) => mine(row, tenant => tenant.active) },
  { title: '近 1 小时完成', key: 'tc', width: 110, align: 'right', render: (_value, row) => mine(row, tenant => tenant.completedLastHour) },
  { title: '近 1 小时失败', key: 'tf', width: 110, align: 'right', render: (_value, row) => mine(row, tenant => tenant.failedLastHour) },
  {
    title: '本企业占比',
    key: 'share',
    width: 100,
    align: 'right',
    render: (_value, row) => (row.tenantShare === null ? <Muted>—</Muted> : <span className="erp-num">{Math.round(row.tenantShare * 100)}%</span>),
  },
]

export function SyncQueuesTab() {
  const query = useApiQuery<SyncQueuesResponse>({ domain: 'realtime', path: '/sync/queues', scoped: false, refetchIntervalMs: 10_000 })
  const data = query.data
  return (
    <div>
      {data?.state === 'UNAVAILABLE' ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data.note ?? '队列服务暂时读不到'} data-testid="queues-unavailable" /> : null}
      {data?.concurrency ? (
        <Alert
          type={data.concurrency.active >= data.concurrency.limit ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 8 }}
          message={`本企业此刻占用 ${data.concurrency.active} / ${data.concurrency.limit} 个并发槽位${data.concurrency.active >= data.concurrency.limit ? '：已满，新任务会延后，等槽位释放后自动执行（不算失败）' : ''}`}
          data-testid="concurrency"
        />
      ) : null}
      {data?.notes.map(note => (
        <div key={note} style={{ fontSize: 12, marginBottom: 4 }}>
          <Muted>{note}</Muted>
        </div>
      ))}
      <SimpleGrid<SyncQueueRow>
        gridId="sync.queues"
        columns={columns}
        rows={data?.state === 'OK' ? data.queues : data ? [] : undefined}
        rowKey={row => row.queue}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '队列', prerequisite: data?.note ?? '尚无记录' }}
      />
    </div>
  )
}
