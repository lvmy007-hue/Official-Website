import { useMemo, useState } from 'react'
import { Input, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { SYNC_STATES, SYNC_STATE_LABEL, type SyncDataDomain, type SyncJobListResponse, type SyncJobRow, type SyncState } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { SyncDomainCards } from './SyncDomainCards'
import { FailureCell, JobTitle, RetryAction, SyncStateTag, attemptsText, logText, progressText } from './sync-ui'

// 同步任务列表：每行是一个真实的后台任务，显示队列状态、尝试次数、进度、请求编号、日志摘要、失败原因，失败的任务可以重试。
// 各状态条数不受状态筛选影响，数据域概况不受任何筛选影响；有任务在排队或运行时每 5 秒刷新一次。

const IN_FLIGHT = new Set<SyncState>(['QUEUED', 'RETRY_WAIT', 'POLL_WAIT', 'RUNNING'])

const columns = (reload: () => void): ColumnsType<SyncJobRow> => [
  { title: '任务', key: 'job', width: 240, fixed: 'left', render: (_value, row) => <JobTitle row={row} /> },
  { title: '状态', key: 'state', width: 110, render: (_value, row) => <SyncStateTag row={row} /> },
  { title: '尝试次数', key: 'attempts', width: 100, render: (_value, row) => attemptsText(row) },
  { title: '进度', key: 'progress', width: 90, render: (_value, row) => progressText(row) },
  {
    title: '请求编号',
    dataIndex: 'requestId',
    width: 200,
    render: (value: string) => (
      <Typography.Text copyable style={{ fontSize: 12 }}>
        {value}
      </Typography.Text>
    ),
  },
  { title: '日志摘要', key: 'log', width: 240, render: (_value, row) => logText(row) },
  {
    title: '失败原因',
    key: 'failure',
    width: 260,
    render: (_value, row) => (
      <div>
        <FailureCell row={row} />
        {row.deadLettered ? (
          <div>
            <Tag color="error" bordered={false}>
              已进入失败任务
            </Tag>
          </div>
        ) : null}
      </div>
    ),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 150,
    render: (_value, row) => (
      <div>
        {timeText(row.createdAt)}
        <div style={{ fontSize: 12 }}>{row.finishedAt ? <Muted>结束 {timeText(row.finishedAt)}</Muted> : null}</div>
      </div>
    ),
  },
  { title: '操作', key: 'actions', width: 90, fixed: 'right', render: (_value, row) => <RetryAction row={row} onDone={reload} /> },
]

export function SyncJobsTab() {
  const [domain, setDomain] = useState<SyncDataDomain>()
  const [state, setState] = useState<SyncState>()
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const list = useApiQuery<SyncJobListResponse>({
    domain: 'list',
    path: '/sync/jobs',
    params: { domain, state, q, pageSize, cursor: stack[stack.length - 1] },
    refetchIntervalMs: data => (data?.items.some(item => IN_FLIGHT.has(item.state)) ? 5000 : false),
  })
  const data = list.data
  const refetch = list.refetch
  const gridColumns = useMemo(() => columns(() => void refetch()), [refetch])
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null

  return (
    <div>
      {data ? (
        <SyncDomainCards
          domains={data.domains}
          active={domain}
          truncated={data.summaryTruncated}
          onPick={value => {
            setDomain(value)
            reset()
          }}
        />
      ) : null}
      <Space wrap style={{ margin: '4px 0 8px' }} data-testid="state-chips">
        <Tag.CheckableTag
          checked={!state}
          onChange={() => {
            setState(undefined)
            reset()
          }}
        >
          全部状态
        </Tag.CheckableTag>
        {SYNC_STATES.map(key => (
          <Tag.CheckableTag
            key={key}
            checked={state === key}
            onChange={checked => {
              setState(checked ? key : undefined)
              reset()
            }}
          >
            {SYNC_STATE_LABEL[key]}
            {data ? `（${data.counts[key]}）` : ''}
          </Tag.CheckableTag>
        ))}
      </Space>
      <Space wrap style={{ marginBottom: 8 }}>
        <Input.Search
          allowClear
          aria-label="搜索任务"
          placeholder="搜索请求编号、任务编号或任务类型"
          style={{ width: 300 }}
          value={keyword}
          onChange={event => setKeyword(event.target.value)}
          onSearch={value => {
            setQ(value.trim() || undefined)
            reset()
          }}
        />
        <Pick
          label="每页条数"
          value={String(pageSize)}
          options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
          onChange={value => {
            setPageSize(Number(value ?? PAGE_SIZES[0]))
            reset()
          }}
        />
        {domain ? (
          <Tag closable onClose={() => setDomain(undefined)}>
            数据域：{data?.domains.find(item => item.domain === domain)?.label ?? domain}
          </Tag>
        ) : null}
      </Space>
      <SimpleGrid<SyncJobRow>
        gridId="sync.jobs"
        columns={gridColumns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{ kind: 'empty', domain: '同步任务', prerequisite: data?.note ?? '尚无记录：还没有同步任务' }}
      />
      <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
    </div>
  )
}
