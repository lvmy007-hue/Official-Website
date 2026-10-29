import { useEffect, useRef, useState } from 'react'
import { Alert, Card, Select, Space, Tag, Typography } from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import {
  LISTING_RUN_KINDS,
  LISTING_RUN_KIND_LABEL,
  listingRunFinished,
  type ListingBatchRowResult,
  type ListingRunKind,
  type ListingRunListResponse,
  type ListingRunView,
  type ListingValidationIssue,
} from '@nova/api-contracts'
import { RowDetailDrawer, SimpleGrid } from '../../components'
import { formatDateTime } from '../../format'
import { useApiQuery } from '../../query/api-query'

// 操作记录（P4-10）：校验预览、修改刊登、批量任务与刊登限制查询的状态与结果。
// 提交只代表“已受理”，真实结果以这里的状态为准；有未完成的记录时自动刷新，全部完成后刷新页面数据（问题状态、限制结果）。

const POLL_MS = 4000
const STATUS_COLOR: Record<string, string> = { SUCCEEDED: 'green', PARTIAL: 'gold', FAILED: 'red' }

/** 单条记录；未完成时轮询，完成后停止。 */
export function useListingRun(id: string | null) {
  return useApiQuery<ListingRunView>({
    domain: 'realtime',
    path: `/listings/runs/${encodeURIComponent(id ?? 'none')}`,
    scoped: false,
    enabled: Boolean(id),
    refetchIntervalMs: data => (data && listingRunFinished(data.status) ? false : POLL_MS),
  })
}

export function IssueList({ issues }: { issues: readonly ListingValidationIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`}>
          <Tag color={issue.severity === 'ERROR' ? 'red' : 'gold'}>{issue.severity === 'ERROR' ? '错误' : '警告'}</Tag>
          {issue.message}
          {issue.attributeNames.length > 0 ? <Typography.Text type="secondary">（{issue.attributeNames.join('、')}）</Typography.Text> : null}
        </li>
      ))}
    </ul>
  )
}

/** 一条记录的结论：状态、失败原因、校验问题、批量任务的逐行结果。 */
export function RunSummary({ run }: { run: ListingRunView }) {
  const finished = listingRunFinished(run.status)
  // 价格校验预览（P4-11）复用这个组件：服务端把它的 kind 记作 PRICE_VALIDATE（类型里没有，按字符串比较）
  const validating = run.kind === 'VALIDATE' || (run.kind as string) === 'PRICE_VALIDATE'
  const verdict = validating && finished && run.status !== 'FAILED' ? (run.validation === 'VALID' ? '校验通过' : '校验未通过') : null
  return (
    <div data-testid="listing-run-summary">
      <Space wrap>
        <Tag color={STATUS_COLOR[run.status] ?? 'blue'}>{run.statusLabel}</Tag>
        {verdict ? <Tag color={run.validation === 'VALID' ? 'green' : 'red'}>{verdict}</Tag> : null}
        {run.usableUntil ? <Typography.Text type="secondary">预览有效至 {formatDateTime(run.usableUntil)}</Typography.Text> : null}
      </Space>
      {run.failureText ? <Alert style={{ marginTop: 8 }} type="error" showIcon message={run.failureText} /> : null}
      <IssueList issues={run.issues} />
      {run.summary ? (
        <p style={{ margin: '8px 0 0' }}>
          亚马逊已接受 {run.summary.accepted} 个，未通过 {run.summary.invalid} 个。
        </p>
      ) : null}
      {run.rows.length > 0 ? (
        <SimpleGrid<ListingBatchRowResult>
          gridId="listings.listing-run-panel"
          columns={[
            { title: 'SKU', dataIndex: 'sku', width: 160 },
            { title: '结果', key: 'ok', width: 90, render: (_v, row) => (row.ok ? <Tag color="green">通过</Tag> : <Tag color="red">未通过</Tag>) },
            { title: '问题', key: 'issues', render: (_v, row) => <IssueList issues={row.issues} /> },
          ]}
          rows={run.rows}
          rowKey={row => row.sku}
          emptyState={{ kind: 'empty', domain: '明细', prerequisite: '尚无记录。' }}
        />
      ) : null}
    </div>
  )
}

export function RunsSection({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [kind, setKind] = useState<ListingRunKind | undefined>()
  const client = useQueryClient()
  const query = useApiQuery<ListingRunListResponse>({
    domain: 'realtime',
    path: '/listings/runs',
    scoped: false,
    params: { kind },
    refetchIntervalMs: data => (data?.items.some(item => !listingRunFinished(item.status)) ? POLL_MS : false),
  })
  const items = query.data?.items
  const busy = items?.filter(item => !listingRunFinished(item.status)).length ?? 0
  const was = useRef(0)
  useEffect(() => {
    // 从“有未完成”变成“全部完成”时，刷新刊登质量的数据（问题状态、限制结果会随之变化）
    if (was.current > 0 && busy === 0) void client.invalidateQueries({ predicate: entry => entry.queryKey[1] === 'list' })
    was.current = busy
  }, [busy, client])

  return (
    <Card size="small" title="操作记录" style={{ marginTop: 8 }} data-testid="listing-runs" extra={<RunKindFilter value={kind} onChange={setKind} />}>
      {query.isError ? <Alert type="error" showIcon message="读取操作记录失败，请稍后重试" /> : null}
      <SimpleGrid<ListingRunView>
        gridId="listings.runs"
        rows={items}
        rowKey={row => row.id}
        loading={query.isFetching && !items}
        onRowOpen={row => onOpen(row.id)}
        emptyState={{ kind: 'empty', domain: '操作记录', prerequisite: '校验、修改刊登、批量任务与刊登限制查询都会记在这里' }}
        columns={[
          { title: '类型', key: 'kind', width: 130, render: (_v, row) => row.kindLabel },
          { title: '对象', key: 'target', render: (_v, row) => (row.sku ? `${row.storeName} · ${row.sku}` : `${row.storeName} · ${row.itemCount} 个`) },
          { title: '状态', key: 'status', width: 130, render: (_v, row) => <Tag color={STATUS_COLOR[row.status] ?? 'blue'}>{row.statusLabel}</Tag> },
          { title: '提交人', key: 'by', width: 110, render: (_v, row) => row.requestedBy ?? '—' },
          { title: '提交时间', key: 'time', width: 170, render: (_v, row) => formatDateTime(row.createdAt) },
        ]}
      />
      <RowDetailDrawer rows={items} rowKey={row => row.id} openKey={openId} onClose={() => onOpen(null)} title={row => `${row.kindLabel} · ${row.storeName}`} width={720}>
        {row => <RunSummary run={row} />}
      </RowDetailDrawer>
      {query.data?.truncated ? <Typography.Text type="secondary">只显示最近 {items?.length ?? 0} 条</Typography.Text> : null}
    </Card>
  )
}

function RunKindFilter({ value, onChange }: { value: ListingRunKind | undefined; onChange: (kind: ListingRunKind | undefined) => void }) {
  return (
    <Select
      allowClear
      size="small"
      style={{ width: 150 }}
      placeholder="全部类型"
      aria-label="记录类型"
      value={value}
      options={LISTING_RUN_KINDS.map(kind => ({ value: kind, label: LISTING_RUN_KIND_LABEL[kind] }))}
      onChange={next => onChange(next)}
    />
  )
}
