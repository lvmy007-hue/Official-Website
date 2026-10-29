import { useMemo, useState } from 'react'
import { Button, Card, Select, Space, Tabs } from 'antd'
import {
  LISTING_IMPACTS,
  LISTING_IMPACT_LABEL,
  LISTING_ISSUE_STATUS_FILTERS,
  LISTING_QUALITY_TABS,
  LISTING_QUALITY_TAB_LABEL,
  LISTING_SEVERITIES,
  LISTING_SEVERITY_LABEL,
  type ListingIssueRow,
  type ListingQualityResponse,
  type ListingQualityTab,
} from '@nova/api-contracts'
import { ActionGuard, FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { BatchAction, RestrictionsAction } from './ListingBulkActions'
import { ListingFixDrawer } from './ListingFixDrawer'
import { RunsSection } from './ListingRunPanel'
import { changeColumns, inactiveColumns, issueColumns, restrictionColumns } from './listing-quality-columns'
import { FILTERED_TABS, PAGE_SIZES, guardOf, type QualityFilters } from './listing-quality-state'
import { LifecycleStats, SourceNotes, StateNote } from './listing-quality-stats'

// 刊登质量与合规（P4-10，05 章 5.4）：七个页签——刊登问题、被搜索抑制、刊登限制、属性缺失、商品类型变更、他人内容修改、非活跃刊登。
// 数据来自刊登接口的每日同步与被搜索抑制报告，推送接收端暂缓接入（页面如实标“尚未接入”）。
// 修复走“校验预览 → 提交修改”两步，批量修改走 Feeds 文件；全部只是“已受理”，结果以操作记录为准。没有数据写“尚无记录”，不写 0。

const STATUS_LABEL: Record<string, string> = { OPEN: '未解决', NEW: '新增', IN_PROGRESS: '处理中', RESOLVED: '已解决', ALL: '全部' }

function Pick({ label, value, options, onChange }: { label: string; value?: string; options: Array<{ value: string; label: string }>; onChange: (value: string | undefined) => void }) {
  return <Select allowClear style={{ width: 130 }} placeholder={label} aria-label={label} value={value} options={options} onChange={next => onChange(next)} />
}

export default function ListingQualityPage() {
  const [tab, setTab] = useState<ListingQualityTab>('issues')
  const [filters, setFilters] = useState<QualityFilters>({})
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [fixing, setFixing] = useState<ListingIssueRow | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)

  const reset = () => setStack([undefined])
  const query = useApiQuery<ListingQualityResponse>({
    domain: 'list',
    path: '/listings/quality',
    params: { tab, ...(FILTERED_TABS.has(tab) ? filters : {}), pageSize, cursor: stack[stack.length - 1] },
  })
  const data = query.data?.tab === tab ? query.data : undefined
  const shell = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const write = shell?.write
  const stores = shell?.stores ?? []
  const filtered = Object.values(filters).some(Boolean)
  const noData = shell ? shell.state === 'NOT_CONNECTED' : false

  const columns = useMemo(
    () => ({
      issue: issueColumns({
        onFix: row => <ActionGuard label="修复" guard={guardOf(write?.validate)} onExecute={async () => setFixing(row)} buttonProps={{ size: 'small' }} />,
      }),
      change: changeColumns(),
      inactive: inactiveColumns(),
      restriction: restrictionColumns(),
    }),
    [write],
  )
  const empty = { kind: 'empty' as const, domain: '刊登', prerequisite: filtered ? '没有符合条件的记录；可以放宽筛选条件。' : (data?.note ?? '当前条件下没有记录') }
  const common = { loading: query.isFetching, error: query.error, onRetry: () => void query.refetch(), emptyState: empty }

  return (
    <div data-testid="listing-quality-page">
      <PageHeader
        title="刊登质量与合规"
        description="一个地方看全刊登的健康状况：刊登问题与被搜索抑制、缺少必填属性、非活跃刊登，以及商品类型和内容被改动的记录，还能查询刊登限制。问题可以先校验预览再提交修改，也可以批量修改。"
      />
      <FreshnessBar freshness={shell?.freshness} />
      {shell ? <LifecycleStats stats={shell.stats} empty={noData} /> : null}
      <Card size="small">
        {shell ? <StateNote data={shell} /> : null}
        <Space wrap style={{ marginBottom: 8 }}>
          <RestrictionsAction stores={stores} write={write} onDone={id => setOpenRun(id)} />
          <BatchAction stores={stores} write={write} onDone={id => setOpenRun(id)} />
        </Space>
        <Tabs
          activeKey={tab}
          onChange={key => {
            setTab(key as ListingQualityTab)
            reset()
          }}
          items={LISTING_QUALITY_TABS.map(key => ({ key, label: shell ? `${LISTING_QUALITY_TAB_LABEL[key]}（${noData ? '尚无记录' : shell.counts[key]}）` : LISTING_QUALITY_TAB_LABEL[key] }))}
        />
        {FILTERED_TABS.has(tab) ? (
          <Space wrap style={{ marginBottom: 8 }}>
            <Pick
              label="严重程度"
              value={filters.severity}
              options={LISTING_SEVERITIES.map(value => ({ value, label: LISTING_SEVERITY_LABEL[value] }))}
              onChange={severity => {
                setFilters({ ...filters, severity })
                reset()
              }}
            />
            <Pick
              label="状态"
              value={filters.status}
              options={LISTING_ISSUE_STATUS_FILTERS.map(value => ({ value, label: STATUS_LABEL[value] ?? value }))}
              onChange={status => {
                setFilters({ ...filters, status })
                reset()
              }}
            />
            <Pick
              label="对销售的影响"
              value={filters.impact}
              options={LISTING_IMPACTS.map(value => ({ value, label: LISTING_IMPACT_LABEL[value] }))}
              onChange={impact => {
                setFilters({ ...filters, impact })
                reset()
              }}
            />
          </Space>
        ) : null}
        {tab === 'issues' || tab === 'suppressed' || tab === 'missing' ? (
          <SimpleGrid<ListingIssueRow> gridId="listing-quality-issues" {...common} columns={columns.issue} rows={data?.issueRows} rowKey={row => row.id} />
        ) : null}
        {tab === 'productType' || tab === 'otherEdits' ? <SimpleGrid {...common} gridId="listing-quality-changes" columns={columns.change} rows={data?.changeRows} rowKey={row => row.id} /> : null}
        {tab === 'inactive' ? <SimpleGrid {...common} gridId="listing-quality-inactive" columns={columns.inactive} rows={data?.inactiveRows} rowKey={row => row.id} /> : null}
        {tab === 'restrictions' ? (
          <SimpleGrid {...common} gridId="listing-quality-restrictions" columns={columns.restriction} rows={data?.restrictionRows} rowKey={row => `${row.runId}-${row.asin}`} />
        ) : null}
        {tab !== 'restrictions' ? (
          <Space style={{ marginTop: 8 }}>
            <Select
              value={String(pageSize)}
              aria-label="每页条数"
              style={{ width: 110 }}
              options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
              onChange={value => {
                setPageSize(Number(value))
                reset()
              }}
            />
            <Button disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
              上一页
            </Button>
            <Button disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
              下一页
            </Button>
            <span style={{ color: 'rgba(0,0,0,0.45)' }}>
              第 {stack.length} 页{data ? `，共 ${data.pageInfo.approxTotal ?? 0} 条` : ''}
            </span>
          </Space>
        ) : null}
        {shell ? <SourceNotes sources={shell.sources} /> : null}
        {shell ? (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
            {shell.basis.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </Card>
      <RunsSection openId={openRun} onOpen={setOpenRun} />
      <ListingFixDrawer row={fixing} write={write} onClose={() => setFixing(null)} />
    </div>
  )
}
