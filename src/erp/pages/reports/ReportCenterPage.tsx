import { useState } from 'react'
import { Alert, Card, Input, Space, Tabs, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  REPORT_DOMAINS,
  REPORT_DOMAIN_LABEL,
  REPORT_SOURCES,
  REPORT_SOURCE_LABEL,
  REPORT_STATUSES,
  REPORT_STATUS_LABEL,
  type ReportDomain,
  type ReportListResponse,
  type ReportRow,
  type ReportStatus,
} from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { CreateReportAction, FailureText, ReportActions, ReportStatusTag, fileText, parseText, retentionText, rowsText } from './reports-ui'

// 报表中心（P5-03，09 章 9.3）：亚马逊报告接口、广告报告接口、数据中心查询三类任务合并成一张表，按业务域分组。
// 每个任务显示申请条件、数据周期、创建人、任务状态、文件状态、解析状态、导入行数、保留期与失败原因；可取消、重试、下载原始文件、跳到分析页。
// 广告与数据中心任务的结果直接写入各自的数据表，报表中心不留存它们的文件，下载栏写明原因。取消只取消本系统任务，不撤回亚马逊侧已开始的报告。

const ACTIVE = new Set<ReportStatus>(['PENDING', 'GENERATING'])

const columns = (reload: () => void): ColumnsType<ReportRow> => [
  {
    title: '报告',
    key: 'report',
    width: 240,
    fixed: 'left',
    render: (_value, row) => (
      <div>
        <LiveLink component="ReportJobDetailPage" id={row.id}>
          {row.label}
        </LiveLink>
        <div style={{ fontSize: 12 }}>
          <Muted>
            {REPORT_SOURCE_LABEL[row.source]}
            {row.domain ? ` · ${REPORT_DOMAIN_LABEL[row.domain]}` : ''}
            {row.storeName ? ` · ${row.storeName}` : ''}
          </Muted>
        </div>
      </div>
    ),
  },
  { title: '申请条件', dataIndex: 'requirement', width: 260, render: (value: string) => <span style={{ fontSize: 12 }}>{value}</span> },
  { title: '数据周期', dataIndex: 'periodText', width: 190 },
  {
    title: '创建人',
    key: 'creator',
    width: 150,
    render: (_value, row) => (
      <div>
        {row.createdByName ?? <Muted>系统</Muted>}
        <div style={{ fontSize: 12 }}>{timeText(row.createdAt)}</div>
      </div>
    ),
  },
  { title: '任务状态', key: 'status', width: 130, render: (_value, row) => <ReportStatusTag row={row} /> },
  { title: '文件', key: 'file', width: 150, render: (_value, row) => fileText(row) },
  { title: '解析', key: 'parse', width: 90, render: (_value, row) => parseText(row) },
  { title: '导入行数', dataIndex: 'importedRows', width: 100, align: 'right', render: (value: number | null) => rowsText(value) },
  { title: '保留期至', key: 'retention', width: 110, render: (_value, row) => retentionText(row) },
  { title: '失败原因', key: 'failure', width: 280, render: (_value, row) => <FailureText row={row} /> },
  { title: '操作', key: 'actions', width: 300, fixed: 'right', render: (_value, row) => <ReportActions row={row} onChanged={reload} /> },
]

export default function ReportCenterPage() {
  const [domain, setDomain] = useState<ReportDomain>()
  const [status, setStatus] = useState<ReportStatus>()
  const [source, setSource] = useState<string>()
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const list = useApiQuery<ReportListResponse>({
    domain: 'list',
    path: '/reports',
    params: { domain, status, source, q, pageSize, cursor: stack[stack.length - 1] },
    refetchIntervalMs: data => (data?.items.some(item => ACTIVE.has(item.status)) ? 5000 : false),
  })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const total = data ? REPORT_DOMAINS.reduce((sum, key) => sum + data.domainCounts[key], 0) : null

  return (
    <div>
      <PageHeader title="报表中心" description="亚马逊报告、广告报告和数据中心查询的任务都在这里：看进度、失败原因，取消或重试，下载原始文件。" actions={<CreateReportAction onDone={reset} />} />
      <Card size="small">
        <Tabs
          activeKey={domain ?? 'ALL'}
          onChange={key => {
            setDomain(key === 'ALL' ? undefined : (key as ReportDomain))
            reset()
          }}
          items={[
            { key: 'ALL', label: `全部${total === null ? '' : `（${total}）`}` },
            ...REPORT_DOMAINS.map(key => ({ key, label: `${REPORT_DOMAIN_LABEL[key]}${data ? `（${data.domainCounts[key]}）` : ''}` })),
          ]}
        />
        {data?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="任务太多，更早的任务没有合并进列表；缩小业务域、状态或来源后再看" /> : null}
        <Space wrap style={{ margin: '4px 0 8px' }} data-testid="status-chips">
          <Tag.CheckableTag
            checked={!status}
            onChange={() => {
              setStatus(undefined)
              reset()
            }}
          >
            全部状态
          </Tag.CheckableTag>
          {REPORT_STATUSES.map(key => (
            <Tag.CheckableTag
              key={key}
              checked={status === key}
              onChange={checked => {
                setStatus(checked ? key : undefined)
                reset()
              }}
            >
              {REPORT_STATUS_LABEL[key]}
              {data ? `（${data.counts[key]}）` : ''}
            </Tag.CheckableTag>
          ))}
        </Space>
        <Space wrap style={{ marginBottom: 8 }}>
          <Input.Search
            allowClear
            aria-label="搜索报告"
            placeholder="搜索报告名称或类型编号"
            style={{ width: 260 }}
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onSearch={value => {
              setQ(value.trim() || undefined)
              reset()
            }}
          />
          <Pick
            label="来源"
            value={source}
            options={REPORT_SOURCES.map(value => ({ value, label: REPORT_SOURCE_LABEL[value] }))}
            onChange={value => {
              setSource(value)
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
        <SimpleGrid<ReportRow>
          gridId="reports.report-center-page"
          columns={columns(() => void list.refetch())}
          rows={data?.items}
          rowKey={row => row.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyState={{ kind: 'empty', domain: '报告任务', prerequisite: data?.note ?? '尚无记录：还没有创建过报告，也没有广告报告或数据中心任务' }}
        />
        <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
      </Card>
    </div>
  )
}
