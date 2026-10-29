import { useState } from 'react'
import { Alert, Input, Segmented, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  POLICY_HANDLING_STATUSES,
  POLICY_HANDLING_STATUS_LABEL,
  POLICY_ISSUE_KINDS,
  POLICY_ISSUE_KIND_LABEL,
  type PolicyHandlingStatus,
  type PolicyIssueKind,
  type PolicyIssueListResponse,
  type PolicyIssueRow,
  type PolicyIssueStatus,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { HandlingTag, IssueStatusTag } from './account-health-ui'

// 政策合规问题列表（P5-02，09 章 9.2）：来自每日同步的账户健康报告；默认未解决的在前。负责人与处理状态是内部处理信息。

type StatusFilter = PolicyIssueStatus | ''

function columnsOf(onOpen: (id: string) => void): ColumnsType<PolicyIssueRow> {
  return [
    {
      title: '问题',
      dataIndex: 'title',
      width: 320,
      render: (value: string, row) => (
        <a
          href={`?issue=${encodeURIComponent(row.id)}`}
          onClick={event => {
            event.preventDefault()
            onOpen(row.id)
          }}
        >
          {value}
        </a>
      ),
    },
    { title: '类型', dataIndex: 'kindLabel', width: 140 },
    { title: '店铺', dataIndex: 'storeName', width: 130 },
    { title: '状态', key: 'status', width: 90, render: (_value, row) => <IssueStatusTag status={row.status} label={row.statusLabel} /> },
    { title: '首次出现', dataIndex: 'firstSeenAt', width: 170, render: (value: string) => timeText(value) },
    { title: '涉及 ASIN', key: 'asins', width: 160, ellipsis: true, render: (_value, row) => (row.asins.length ? row.asins.join('、') : <Muted>报告没有给出</Muted>) },
    { title: '处理状态', key: 'handling', width: 100, render: (_value, row) => <HandlingTag status={row.handlingStatus} label={row.handlingStatusLabel} /> },
    { title: '负责人', key: 'owner', width: 110, render: (_value, row) => row.owner?.name ?? <Muted>未指定</Muted> },
    { title: '案件编号', key: 'case', width: 120, render: (_value, row) => row.amazonCaseId ?? <Muted>尚未填写</Muted> },
  ]
}

export function PolicyIssuesPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<StatusFilter>('OPEN')
  const [kind, setKind] = useState<PolicyIssueKind>()
  const [handling, setHandling] = useState<PolicyHandlingStatus>()
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const list = useApiQuery<PolicyIssueListResponse>({
    domain: 'list',
    path: '/account-health/issues',
    params: { status: status || undefined, kind, handlingStatus: handling, q, pageSize, cursor: stack[stack.length - 1] },
  })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(status || kind || handling || q)

  return (
    <div data-testid="policy-issues-panel">
      <Space wrap style={{ marginBottom: 8 }}>
        <Segmented
          aria-label="问题状态"
          value={status}
          options={[
            { value: 'OPEN', label: `未解决${data ? `（${data.counts.OPEN}）` : ''}` },
            { value: 'RESOLVED', label: `已解决${data ? `（${data.counts.RESOLVED}）` : ''}` },
            { value: '', label: '全部' },
          ]}
          onChange={value => {
            setStatus(value as StatusFilter)
            reset()
          }}
        />
        <Input.Search
          allowClear
          aria-label="搜索问题"
          placeholder="搜索标题、问题编号、ASIN"
          style={{ width: 240 }}
          onSearch={value => {
            setQ(value.trim() || undefined)
            reset()
          }}
        />
        <Pick
          label="类型"
          value={kind}
          options={POLICY_ISSUE_KINDS.map(value => ({ value, label: POLICY_ISSUE_KIND_LABEL[value] }))}
          onChange={value => {
            setKind(value as PolicyIssueKind | undefined)
            reset()
          }}
        />
        <Pick
          label="处理状态"
          value={handling}
          options={POLICY_HANDLING_STATUSES.map(value => ({ value, label: POLICY_HANDLING_STATUS_LABEL[value] }))}
          onChange={value => {
            setHandling(value as PolicyHandlingStatus | undefined)
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
      </Space>
      {data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="问题很多，只显示了最前面的一部分" /> : null}
      <SimpleGrid<PolicyIssueRow>
        gridId="account-health.policy-issues-panel"
        columns={columnsOf(onOpen)}
        rows={data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{ kind: 'empty', domain: '政策合规问题', prerequisite: data?.note ?? (filtered ? '没有符合条件的问题；可以放宽筛选条件。' : '目前没有政策合规问题记录') }}
      />
      <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
    </div>
  )
}
