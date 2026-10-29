import { Alert, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { SyncRateBucket, SyncRateLimitsResponse } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'

// 限速状态：每个店铺授权、每个接口族一个令牌桶——剩余令牌、补充速率、是否被冻结、最近一次被亚马逊限速的时间。
// 令牌桶在缓存里一小时没人用就会过期，所以“最近限速”只反映近一小时内仍在使用的桶；没有记录时写“尚无记录”。

const columns: ColumnsType<SyncRateBucket> = [
  { title: '店铺', key: 'store', width: 180, render: (_value, row) => row.storeName ?? <Muted>账户级连接</Muted> },
  { title: '接口', key: 'api', width: 140, render: (_value, row) => row.apiLabel ?? <Muted>尚无记录</Muted> },
  { title: '接口族', dataIndex: 'family', width: 140 },
  { title: '剩余令牌', key: 'tokens', width: 120, align: 'right', render: (_value, row) => <span className="erp-num">{`${row.tokens} / ${row.burst}`}</span> },
  { title: '补充速率', key: 'rate', width: 110, align: 'right', render: (_value, row) => <span className="erp-num">{`${row.ratePerSecond} 次/秒`}</span> },
  {
    title: '状态',
    key: 'blocked',
    width: 190,
    render: (_value, row) =>
      row.blocked ? (
        <Tag color="warning" bordered={false}>
          限速冻结至 {row.blockedUntil ? formatDateTime(row.blockedUntil) : '稍后'}
        </Tag>
      ) : (
        <Tag color="success" bordered={false}>
          正常
        </Tag>
      ),
  },
  { title: '最近一次限速', key: 'limited', width: 170, render: (_value, row) => (row.lastLimitedAt ? formatDateTime(row.lastLimitedAt) : <Muted>尚无记录</Muted>) },
  { title: '更新时间', key: 'updated', width: 170, render: (_value, row) => (row.updatedAt ? formatDateTime(row.updatedAt) : <Muted>尚无记录</Muted>) },
]

export function SyncRateLimitsTab() {
  const query = useApiQuery<SyncRateLimitsResponse>({ domain: 'realtime', path: '/sync/rate-limits', scoped: false, refetchIntervalMs: 10_000 })
  const data = query.data
  return (
    <div>
      {data?.state === 'UNAVAILABLE' ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data.note ?? '限速状态暂时读不到'} data-testid="rate-unavailable" /> : null}
      {data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="令牌桶太多，只显示了前 200 个" /> : null}
      {data?.notes.map(note => (
        <div key={note} style={{ fontSize: 12, marginBottom: 4 }}>
          <Muted>{note}</Muted>
        </div>
      ))}
      <SimpleGrid<SyncRateBucket>
        gridId="sync.rate-limits"
        columns={columns}
        rows={data?.state === 'UNAVAILABLE' ? [] : data?.items}
        rowKey={row => `${row.connectionId}:${row.family}`}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '令牌桶', prerequisite: data?.note ?? '尚无记录' }}
      />
    </div>
  )
}
