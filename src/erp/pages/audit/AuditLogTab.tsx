import { useState } from 'react'
import { Button, DatePicker, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { AUDIT_RESULT_LABEL, AUDIT_RESULTS, AUDIT_SOURCE_LABEL, AUDIT_SOURCES, auditResourcePath, type AuditListResponse, type AuditOptionsResponse, type AuditRow } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { AppLink } from '../../nav/AppLink'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { PAGE_SIZES, Pager } from '../reimbursements/reimbursements-ui'
import { AuditExportAction } from './AuditExportAction'
import { ActorText, PageText, Pick, ResourceCell, ResultTag, SearchBox, rangeParams, type TimeRange } from './audit-ui'

// 审计日志列表（09 章 9.11）：服务端搜索与筛选——操作人、动作、资源类型、资源编号、结果、来源、所属页面、请求编号、时间范围，每一项都真实生效；
// 游标分页，按发生时间从新到旧。系统自动任务的操作人显示“系统”，平台人员显示“平台人员”。
// 没有记录就写“尚无记录”，不画 0 行的假表格。

type Filters = {
  q?: string
  actorId?: string
  action?: string
  resourceType?: string
  resourceId?: string
  result?: string
  source?: string
  page?: string
  requestId?: string
  range: TimeRange
}

const SOURCE_OPTIONS = AUDIT_SOURCES.map(value => ({ value, label: AUDIT_SOURCE_LABEL[value] }))
const RESULT_OPTIONS = AUDIT_RESULTS.map(value => ({ value, label: AUDIT_RESULT_LABEL[value] }))

const columns: ColumnsType<AuditRow> = [
  { title: '时间', key: 'time', width: 160, render: (_value, row) => timeText(row.occurredAt) },
  { title: '操作人', key: 'actor', width: 120, render: (_value, row) => <ActorText actor={row.actor} /> },
  {
    title: '动作',
    key: 'action',
    width: 200,
    render: (_value, row) => (
      <div>
        <div>{row.actionLabel}</div>
        {row.actionLabel === row.action ? null : (
          <div style={{ fontSize: 12 }}>
            <Muted>{row.action}</Muted>
          </div>
        )}
      </div>
    ),
  },
  { title: '资源', key: 'resource', width: 200, render: (_value, row) => <ResourceCell label={row.resourceLabel} id={row.resourceId} path={auditResourcePath(row.resourceType, row.resourceId)} /> },
  { title: '结果', key: 'result', width: 90, render: (_value, row) => <ResultTag result={row.result} label={row.resultLabel} /> },
  {
    title: '来源',
    key: 'source',
    width: 200,
    render: (_value, row) => (
      <div>
        <div>{row.sourceLabel}</div>
        <div style={{ fontSize: 12 }}>
          <PageText page={row.page} />
        </div>
      </div>
    ),
  },
  { title: '访问模式', dataIndex: 'accessModeLabel', key: 'mode', width: 110 },
  { title: '原因', key: 'reason', width: 200, render: (_value, row) => row.reason ?? <Muted>未填写</Muted> },
  {
    title: '请求编号',
    key: 'requestId',
    width: 210,
    render: (_value, row) => (
      <Typography.Text copyable style={{ fontSize: 12 }}>
        {row.requestId}
      </Typography.Text>
    ),
  },
  {
    title: '操作',
    key: 'open',
    width: 80,
    fixed: 'right',
    render: (_value, row) => (
      <AppLink to={`/app/audit/${encodeURIComponent(row.id)}`} keepScope={false}>
        查看详情
      </AppLink>
    ),
  },
]

/** 页面上的筛选 → 接口参数（也是导出保存的条件）；空值不传。 */
function paramsOf(filters: Filters): Record<string, string> {
  const { range, ...rest } = filters
  const all: Record<string, string | undefined> = { ...rest, ...rangeParams(range) }
  return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => Boolean(entry[1])))
}

/** 导出任务里记的“筛选摘要”：写人话，方便在导出中心辨认。 */
function summaryOf(filters: Filters, options: AuditOptionsResponse | undefined): string {
  const label = (items: Array<{ value: string; label: string }> | undefined, value?: string) => (value ? (items?.find(item => item.value === value)?.label ?? value) : undefined)
  const parts = [
    filters.actorId ? `操作人 ${label(options?.actors, filters.actorId)}` : null,
    filters.action ? `动作 ${label(options?.actions, filters.action)}` : null,
    filters.resourceType ? `资源类型 ${label(options?.resourceTypes, filters.resourceType)}` : null,
    filters.resourceId ? `资源编号 ${filters.resourceId}` : null,
    filters.result ? `结果 ${AUDIT_RESULT_LABEL[filters.result]}` : null,
    filters.source ? `来源 ${AUDIT_SOURCE_LABEL[filters.source as keyof typeof AUDIT_SOURCE_LABEL]}` : null,
    filters.page ? `页面 ${filters.page}` : null,
    filters.requestId ? `请求编号 ${filters.requestId}` : null,
    filters.q ? `关键词 ${filters.q}` : null,
    filters.range?.[0] || filters.range?.[1] ? `${filters.range?.[0]?.format('YYYY-MM-DD HH:mm') ?? '最早'} 至 ${filters.range?.[1]?.format('YYYY-MM-DD HH:mm') ?? '现在'}` : null,
  ].filter(Boolean)
  return `审计日志：${parts.length ? parts.join('，') : '全部记录'}`
}

export function AuditLogTab() {
  const [filters, setFilters] = useState<Filters>({ range: null })
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  // 清除筛选时换掉搜索框的 key，输入的文字一起清空
  const [boxes, setBoxes] = useState(0)
  const reset = () => setStack([undefined])
  const set = (patch: Partial<Filters>) => {
    setFilters(current => ({ ...current, ...patch }))
    reset()
  }
  const params = paramsOf(filters)
  const options = useApiQuery<AuditOptionsResponse>({ domain: 'list', path: '/audit/options', scoped: false })
  const list = useApiQuery<AuditListResponse>({ domain: 'list', path: '/audit', scoped: false, params: { ...params, pageSize, cursor: stack[stack.length - 1] } })
  const data = list.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const opts = options.data
  const filtered = Object.keys(params).length > 0

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <SearchBox key={`q${boxes}`} width={260} label="搜索审计" placeholder="搜索动作、资源编号或请求编号（开头匹配）" onSearch={value => set({ q: value })} />
        <Pick label="操作人" value={filters.actorId} options={opts?.actors ?? []} onChange={value => set({ actorId: value })} />
        <Pick label="动作" value={filters.action} options={opts?.actions ?? []} onChange={value => set({ action: value })} width={190} />
        <Pick label="资源类型" value={filters.resourceType} options={opts?.resourceTypes ?? []} onChange={value => set({ resourceType: value })} />
        <Pick label="结果" value={filters.result} options={RESULT_OPTIONS} onChange={value => set({ result: value })} width={110} />
        <Pick label="来源" value={filters.source} options={SOURCE_OPTIONS} onChange={value => set({ source: value })} width={120} />
        <Pick label="所属页面" value={filters.page} options={(opts?.pages ?? []).map(page => ({ value: page, label: page }))} onChange={value => set({ page: value })} width={190} />
      </Space>
      <Space wrap style={{ marginBottom: 8 }}>
        <SearchBox key={`r${boxes}`} width={220} label="资源编号" placeholder="资源编号（完全匹配）" onSearch={value => set({ resourceId: value })} />
        <SearchBox key={`n${boxes}`} width={220} label="请求编号" placeholder="请求编号（完全匹配）" onSearch={value => set({ requestId: value })} />
        <DatePicker.RangePicker showTime aria-label="时间范围" value={filters.range} onChange={range => set({ range })} />
        <Button
          disabled={!filtered}
          onClick={() => {
            setFilters({ range: null })
            setBoxes(count => count + 1)
            reset()
          }}
        >
          清除筛选
        </Button>
        <Pick
          label="每页条数"
          value={String(pageSize)}
          options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
          onChange={value => {
            setPageSize(Number(value ?? PAGE_SIZES[0]))
            reset()
          }}
          width={110}
        />
        <AuditExportAction filters={params} summary={summaryOf(filters, opts)} canExport={data?.canExport ?? false} blockedReason={data ? data.exportBlockedReason : '列表还没有加载完成'} />
      </Space>
      {opts?.truncated ? <Muted>动作、资源类型或操作人的候选项过多，只列出了部分；可以直接用上方的关键词与编号搜索。</Muted> : null}
      <SimpleGrid<AuditRow>
        gridId="audit.audit-log-tab"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={{ kind: 'empty', domain: '审计记录', prerequisite: filtered ? '没有符合条件的审计记录；可以放宽筛选条件或扩大时间范围。' : '尚无记录：企业里还没有产生审计记录。' }}
      />
      <Pager stack={stack} next={next} busy={list.isFetching} onStack={setStack} />
    </div>
  )
}
