import { useRef, useState } from 'react'
import { Alert, Button, Input, Select, Space } from 'antd'
import { REVIEWS_IMPORT_PERMISSION, type RatingRow, type RatingsTabResponse, type ReviewSort } from '@nova/api-contracts'
import { FreshnessBar, RowDetailDrawer, SimpleGrid, useRowDetail } from '../../components'
import { formatDate, formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { useSession } from '../../session/session'
import { RatingsImportAction } from './RatingsImportModal'
import { distributionBars } from './reviews-options'
import { ratingColumns } from './reviews-columns'
import { PAGE_SIZES, RATING_BELOW_OPTIONS, SORT_FIELDS, SORT_LABEL, type RatingFilters } from './reviews-state'
import { Basis, Muted, NONE, Pager, SectionNote, countOrNone } from './reviews-ui'

// 评分概况（P4-13，05 章 5.7）：平均星级与评分数在亚马逊官方接口里没有来源，只来自你导入的评分文件，每行标注来源、采集日期、导入文件与导入人。
// 游标翻页；筛选、排序在服务端；没有评分的商品不出现在表里，也不补 0。

const ratingKey = (row: RatingRow) => `${row.storeId}|${row.asin}`

function Distribution({ row }: { row: RatingRow }) {
  const bars = distributionBars(row.distribution)
  return (
    <div data-testid="rating-distribution" style={{ maxWidth: 520 }}>
      {bars.length === 0 ? (
        <Muted>未导入星级分布</Muted>
      ) : (
        bars.map(bar => (
          <div key={bar.star} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ width: 40 }}>{bar.star} 星</span>
            <div style={{ flex: 1, height: 10, background: 'rgba(0,0,0,0.06)', borderRadius: 2 }}>
              <div style={{ width: `${Math.round((bar.share ?? 0) * 100)}%`, height: 10, background: '#faad14', borderRadius: 2 }} />
            </div>
            <span className="erp-num" style={{ width: 130, textAlign: 'right' }}>
              {formatNumber(bar.count, { digits: 0 })} 人{bar.share === null ? '' : `（${formatPercent(bar.share, { digits: 1 })}）`}
            </span>
          </div>
        ))
      )}
      <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
        采集记录（旧到新）：
        {row.trend
          .map(
            point =>
              `${formatDate(point.date)} 星级 ${point.avgRating === null ? '尚无记录' : point.avgRating.toFixed(2)}、评分数 ${point.ratingCount === null ? '尚无记录' : formatNumber(point.ratingCount, { digits: 0 })}`,
          )
          .join('；')}
      </div>
    </div>
  )
}

export function RatingsPanel() {
  const { canPermission } = useSession()
  const detail = useRowDetail()
  const [filters, setFilters] = useState<RatingFilters>({})
  const [sort, setSort] = useState<ReviewSort>('asin')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const apply = (patch: Partial<RatingFilters>) => {
    setFilters(current => ({ ...current, ...patch }))
    reset()
  }
  const query = useApiQuery<RatingsTabResponse>({
    domain: 'list',
    path: '/reviews',
    params: { tab: 'ratings', ...filters, sort: `${sort}:${dir}`, pageSize, cursor: stack[stack.length - 1] },
  })
  const data = query.data
  // 换条件重新读取期间，汇总与店铺选项沿用上一次的结果；表格行与分页只用本次结果
  const last = useRef<RatingsTabResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(filters.q || filters.ratingBelow)
  const summary = shell?.summary
  const canImport = canPermission(REVIEWS_IMPORT_PERMISSION)

  return (
    <div data-testid="ratings-panel">
      <FreshnessBar freshness={null} />
      <SectionNote state={shell?.state ?? 'OK'} note={shell?.note ?? null} />
      {summary ? (
        <Space wrap size={16} style={{ marginBottom: 8 }} data-testid="ratings-summary">
          <span>目录商品数 {summary.catalogAsins > 0 ? <span className="erp-num">{formatNumber(summary.catalogAsins, { digits: 0 })}</span> : NONE}</span>
          <span>
            已有评分的商品 {summary.withRating > 0 ? <span className="erp-num">{formatNumber(summary.withRating, { digits: 0 })}</span> : NONE}
            {summary.catalogAsins > summary.withRating && summary.withRating > 0 ? <Muted>（另有 {summary.catalogAsins - summary.withRating} 个商品尚无评分记录）</Muted> : null}
          </span>
          <span>最近采集日期 {summary.latestCapture ? <span className="erp-num">{formatDate(summary.latestCapture)}</span> : NONE}</span>
          <span>最低星级 {summary.lowestRating === null ? NONE : <span className="erp-num">{summary.lowestRating.toFixed(2)}</span>}</span>
          <span>低于 4 星的商品 {summary.below4 === null ? NONE : countOrNone(summary.below4)}</span>
        </Space>
      ) : null}
      <Space wrap style={{ marginBottom: 8 }}>
        <RatingsImportAction stores={shell?.stores ?? []} />
        {canImport ? null : <Muted>导入评分文件需要“数据导入”权限（{REVIEWS_IMPORT_PERMISSION}），请联系企业管理员开通</Muted>}
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder="搜索 ASIN 或标题"
          aria-label="搜索评分商品"
          key={`q|${filters.q ?? ''}`}
          defaultValue={filters.q}
          onSearch={value => apply({ q: value.trim() || undefined })}
        />
        <Select
          allowClear
          style={{ width: 140 }}
          placeholder="星级低于"
          aria-label="星级低于"
          virtual={false}
          value={filters.ratingBelow}
          options={RATING_BELOW_OPTIONS.map(value => ({ value, label: `低于 ${value} 星` }))}
          onChange={value => apply({ ratingBelow: value as number | undefined })}
        />
        <Select
          value={sort}
          aria-label="排序字段"
          style={{ width: 200 }}
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
      </Space>
      {data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="评分记录很多，只读取了最近的一部分；请用关键字或星级筛选缩小范围" /> : null}
      <SimpleGrid<RatingRow>
        gridId="reviews.ratings"
        columns={ratingColumns}
        rows={data?.items}
        rowKey={ratingKey}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        onRowOpen={row => detail.open(ratingKey(row))}
        emptyState={{
          kind: 'empty',
          domain: '商品评分',
          prerequisite: filtered ? '没有符合条件的评分记录；可以放宽筛选条件。' : (data?.note ?? '还没有导入过评分文件；点“导入评分文件”选择从卖家后台导出的 CSV（可先下载模板）。'),
        }}
      />
      <RowDetailDrawer rows={data?.items} rowKey={ratingKey} openKey={detail.openKey} onClose={detail.close} title={row => `星级分布：${row.asin}`} width={600}>
        {row => <Distribution row={row} />}
      </RowDetailDrawer>
      <Pager
        page={stack.length}
        hasNext={Boolean(next)}
        busy={query.isFetching}
        onPrev={() => setStack(current => current.slice(0, -1))}
        onNext={() => next && setStack(current => [...current, next])}
        note={data ? `共 ${data.pageInfo.approxTotal ?? data.items.length} 个商品` : undefined}
      />
      {data ? <Basis>{data.basis}</Basis> : null}
    </div>
  )
}
