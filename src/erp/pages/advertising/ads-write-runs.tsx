import { Card, Tag } from 'antd'
import { ADS_WRITE_SOURCE_LABEL, ADS_WRITE_STATUS_LABEL, type AdsWriteRunRow, type AdsWriteStatusResponse } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'

// 写入记录（P3-17）：最近提交的广告写入（手动、自动规则、分时策略）和它们的结果。提交只表示“已排队”，亚马逊的确认以这里的状态为准；失败写明原因，没有就写“尚无记录”。

const COLOR: Record<AdsWriteRunRow['status'], string> = { PENDING: 'default', RUNNING: 'processing', SUCCEEDED: 'success', FAILED: 'error' }

export function WriteRunsCard() {
  const query = useApiQuery<AdsWriteStatusResponse>({
    domain: 'analytics',
    path: '/ads/writes',
    refetchIntervalMs: data => (data?.runs.some(run => run.status === 'PENDING' || run.status === 'RUNNING') ? 5000 : false),
  })
  return (
    <Card size="small" title="写入记录（最近 50 条）" style={{ marginTop: 12 }} data-testid="ads-write-runs">
      <SimpleGrid<AdsWriteRunRow>
        gridId="advertising.ads-write-runs"
        columns={[
          { title: '提交时间', render: (_: unknown, run) => formatDateTime(run.createdAt) },
          { title: '来源', render: (_: unknown, run) => ADS_WRITE_SOURCE_LABEL[run.source] },
          { title: '对象', render: (_: unknown, run) => run.entityLabel ?? run.entityId },
          { title: '修改', dataIndex: 'kindLabel' },
          { title: '修改前', render: (_: unknown, run) => run.before ?? '尚未同步' },
          { title: '修改后', dataIndex: 'after' },
          { title: '状态', render: (_: unknown, run) => <Tag color={COLOR[run.status]}>{ADS_WRITE_STATUS_LABEL[run.status]}</Tag> },
          { title: '说明', render: (_: unknown, run) => run.failureText ?? '—' },
        ]}
        rows={query.data?.runs}
        rowKey={run => run.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '写入记录', prerequisite: '尚无记录：提交过广告写入之后显示。' }}
      />
    </Card>
  )
}
