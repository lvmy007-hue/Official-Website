import { useRef, useState } from 'react'
import { Alert, App, Button, Card, Input, Select, Space, Tabs, Tag } from 'antd'
import { COMPETITOR_REASONS, COMPETITOR_REASON_LABEL, COMPETITORS_WRITE, type CompetitorListResponse, type CompetitorReason, type CompetitorRow, type CompetitorSort } from '@nova/api-contracts'
import { ActionGuard, FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { AddCompetitorModal } from './AddCompetitorModal'
import { CandidatesPanel } from './CandidatesPanel'
import { competitorColumns } from './competitors-columns'
import { PAGE_SIZES, SORT_FIELDS, SORT_LABEL, type CompetitorFilters } from './competitors-state'

// 竞品监控（P4-12，05 章 5.6）：关注的竞品与我方的价格、排名、推荐报价对照，搜索词推荐，手工添加。
// 竞品来源只有官方接口与报告（热门搜索词点击前三，或手工添加），不抓取亚马逊前台页面；竞品的评分与评分数没有官方来源，不显示。
// 筛选、排序、分页在服务端；没有数据写“尚无记录”，不补 0；核心词点击份额是下限。

export default function CompetitorsPage() {
  const { message } = App.useApp()
  const [tab, setTab] = useState('watched')
  const [filters, setFilters] = useState<CompetitorFilters>({})
  const [sort, setSort] = useState<CompetitorSort>('addedAt')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [adding, setAdding] = useState(false)

  const reset = () => setStack([undefined])
  const apply = (patch: Partial<CompetitorFilters>) => {
    setFilters(current => ({ ...current, ...patch }))
    reset()
  }
  const query = useApiQuery<CompetitorListResponse>({
    domain: 'list',
    path: '/competitors',
    params: { ...filters, sort: `${sort}:${dir}`, pageSize, cursor: stack[stack.length - 1] },
  })
  const remove = useApiMutation<CompetitorRow>({
    method: 'DELETE',
    path: row => `/competitors/${encodeURIComponent(row.asin)}?storeId=${encodeURIComponent(row.storeId)}${row.ownAsin ? `&ownAsin=${encodeURIComponent(row.ownAsin)}` : ''}`,
    body: () => undefined,
    invalidate: ['list'],
    silent: true,
  })
  const data = query.data
  // 换条件重新读取期间，顶部汇总与店铺选项沿用上一次的结果，避免整块闪烁；表格行与分页只用本次结果
  const last = useRef<CompetitorListResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(filters.q || filters.reason)
  const columns = competitorColumns({
    onRemove: row => (
      <ActionGuard
        label="取消关注"
        guard={{ permission: COMPETITORS_WRITE }}
        danger
        preview={{
          title: '取消关注这个竞品',
          content: <p>取消后，不再同步这个竞品对应这个我方商品的数据；如果这个竞品在这个店铺里没有别的关注，它已留存的价格与目录快照也会一并删除。不会影响亚马逊上的任何数据。</p>,
          confirmText: '确认取消',
        }}
        onExecute={() => remove.mutateAsync(row)}
        successText="已取消关注"
        buttonProps={{ type: 'link', size: 'small' }}
      />
    ),
  })

  const watched = (
    <>
      {data && data.state !== 'OK' && data.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.note} /> : null}
      {shell ? (
        <Space wrap size={16} style={{ marginBottom: 8 }} data-testid="competitor-summary">
          <span>
            关注 <span className="erp-num">{shell.summary.watched}</span> 条
          </span>
          <span>
            已有数据 <span className="erp-num">{shell.summary.withSnapshot}</span> 条
          </span>
          <span>等待首次同步 {shell.summary.waiting > 0 ? <span className="erp-num">{shell.summary.waiting}</span> : <Muted>无</Muted>}</span>
        </Space>
      ) : null}
      <Space wrap style={{ marginBottom: 8 }}>
        <ActionGuard label="手工添加竞品" guard={{ permission: COMPETITORS_WRITE }} onExecute={async () => setAdding(true)} buttonProps={{ type: 'primary' }} />
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder="搜索 ASIN、标题、品牌、备注"
          aria-label="搜索竞品"
          key={`q|${filters.q ?? ''}`}
          defaultValue={filters.q}
          onSearch={value => apply({ q: value.trim() || undefined })}
        />
        <Select
          allowClear
          style={{ width: 200 }}
          placeholder="来源"
          aria-label="来源"
          value={filters.reason}
          options={COMPETITOR_REASONS.map(value => ({ value, label: COMPETITOR_REASON_LABEL[value] }))}
          onChange={value => apply({ reason: value as CompetitorReason | undefined })}
        />
        <Select
          value={sort}
          aria-label="排序字段"
          style={{ width: 230 }}
          options={SORT_FIELDS.map(field => ({ value: field, label: `按${SORT_LABEL[field]}排序` }))}
          onChange={field => {
            setSort(field)
            reset()
          }}
        />
        <Button
          aria-label="排序方向"
          onClick={() => {
            setDir(dir === 'desc' ? 'asc' : 'desc')
            reset()
          }}
        >
          {dir === 'desc' ? '从高到低' : '从低到高'}
        </Button>
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
        {filters.reason ? (
          <Tag closable onClose={() => apply({ reason: undefined })}>
            已筛选：{COMPETITOR_REASON_LABEL[filters.reason]}
          </Tag>
        ) : null}
      </Space>
      {data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="关注的竞品很多，只显示了最近关注的前 2000 条" /> : null}
      <SimpleGrid<CompetitorRow>
        gridId="competitors.competitors-page"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{
          kind: 'empty',
          domain: '关注的竞品',
          prerequisite: filtered ? '没有符合条件的竞品；可以放宽筛选条件。' : (data?.note ?? '还没有关注任何竞品；可以在“搜索词推荐”里加入，或手工添加竞品 ASIN。'),
        }}
      />
      <Space style={{ marginTop: 8 }}>
        <Button disabled={stack.length <= 1 || query.isFetching} onClick={() => setStack(current => current.slice(0, -1))}>
          上一页
        </Button>
        <Button disabled={!next || query.isFetching} onClick={() => next && setStack(current => [...current, next])}>
          下一页
        </Button>
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>
          第 {stack.length} 页{data ? `，共 ${data.pageInfo.approxTotal ?? data.items.length} 条` : ''}
        </span>
      </Space>
      {data ? <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{data.basis}</p> : null}
    </>
  )

  return (
    <div data-testid="competitors-page">
      <PageHeader
        title="竞品监控"
        description="关注竞品，对照它们与我方商品的价格、销售排名、推荐报价和在我方核心搜索词中的点击份额。竞品只来自官方接口与报告（热门搜索词点击前三，或手工添加），不抓取亚马逊前台页面；竞品的评分没有官方来源，不显示。"
      />
      <FreshnessBar freshness={shell?.freshness} />
      <Card size="small" style={{ marginTop: 8 }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'watched', label: '关注的竞品', children: watched },
            { key: 'candidates', label: '搜索词推荐', children: <CandidatesPanel onAdded={result => void message.success(result.note)} /> },
          ]}
        />
      </Card>
      <AddCompetitorModal open={adding} stores={shell?.stores ?? []} onClose={() => setAdding(false)} onAdded={result => void message.success(result.note)} />
    </div>
  )
}
