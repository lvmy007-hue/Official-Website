import { useState } from 'react'
import { Alert, Button, Card, Select, Space, Input } from 'antd'
import {
  INVENTORY_RISK_LABEL,
  INVENTORY_RISK_LEVELS,
  PRODUCT_CHANNEL_LABEL,
  PRODUCT_CHANNELS,
  PRODUCT_LISTING_LABEL,
  PRODUCT_RISK_FILTER_NOTE,
  PRODUCT_SORT_LABEL,
  PRODUCT_SORTS,
  type ProductListResponse,
  type ProductListRow,
  type ProductSort,
} from '@nova/api-contracts'
import { FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { ExportAction, ReplenishAction, SyncAction, WatchAction } from './products-actions'
import { productColumns } from './products-columns'
import { ProductMetaAction } from './products-meta-action'

// 商品主数据（P4-07，05 章 5.1）：一个商品一行，销售、利润、库存数字来自各自的汇总（美元、近 30 天，同店同 ASIN 的多个 SKU 共用销售）。
// 筛选、排序、分页都在服务端；批量动作只放真实可执行的：设置标签与负责人（系统内）、同步商品目录、导出、关注、去补货建议。
// 没有数据的地方写“尚无记录”，没有权限的写“无权限”，来源还没建好的（刊登问题数与质量分）写“尚未接入”，不补 0。

const PAGE_SIZES = [20, 50, 100]
const WATCH_OPTIONS = [
  { value: 'true', label: '只看已关注' },
  { value: 'false', label: '只看未关注' },
]

type Filters = {
  q?: string
  parentAsin?: string
  brand?: string
  category?: string
  status?: string
  fulfillment?: string
  tag?: string
  ownerId?: string
  risk?: string
  watched?: string
}

function Pick({
  label,
  value,
  options,
  onChange,
  width = 140,
}: {
  label: string
  value?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string | undefined) => void
  width?: number
}) {
  return <Select allowClear showSearch optionFilterProp="label" style={{ width }} placeholder={label} aria-label={label} value={value} options={options} onChange={next => onChange(next)} />
}

const same = (value: string[] | undefined) => (value ?? []).map(item => ({ value: item, label: item }))

export default function ProductsPage() {
  const [filters, setFilters] = useState<Filters>({})
  const [sort, setSort] = useState<{ field: ProductSort; dir: 'asc' | 'desc' }>({ field: 'updatedAt', dir: 'desc' })
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  // 游标栈：栈顶是当前页的游标，undefined 表示第一页
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [selected, setSelected] = useState<ProductListRow[]>([])
  const reset = () => {
    setStack([undefined])
    setSelected([])
  }
  const set = (patch: Filters) => {
    setFilters(current => ({ ...current, ...patch }))
    reset()
  }
  const query = useApiQuery<ProductListResponse>({
    domain: 'list',
    path: '/products',
    params: { ...filters, sort: `${sort.field}:${sort.dir}`, pageSize, cursor: stack[stack.length - 1] },
  })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Object.values(filters).some(Boolean)
  const options = data?.filterOptions
  const columns = productColumns({ stockAllowed: data?.stock.state !== 'RESTRICTED', profitAllowed: data?.profit.state !== 'RESTRICTED', notConnected: data?.notConnected ?? '' })
  const exportFilters = { ...filters, fulfillment: filters.fulfillment as 'AFN' | 'MFN' | undefined, watched: filters.watched === undefined ? undefined : filters.watched === 'true' }
  return (
    <div data-testid="products-page">
      <PageHeader
        title="商品主数据"
        description="一个商品一行：ASIN、SKU、品牌、类目、价格，以及近 30 天销售、利润率与可售库存；点标题进入 ASIN 360。可以按条件筛选后批量设置标签与负责人、同步商品目录、导出或加入关注。"
      />
      <FreshnessBar freshness={data?.freshness} />
      <Card size="small">
        {data?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="商品数量超过读取上限，只处理了前一部分；请用筛选缩小范围" /> : null}
        {data?.riskTruncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="库存记录超过评估上限，库存风险筛选可能漏掉部分商品" /> : null}
        {data && data.stock.state !== 'OK' ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`可售库存：${data.stock.note ?? ''}`} /> : null}
        {data && data.profit.state !== 'OK' ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`利润率：${data.profit.note ?? ''}`} /> : null}
        <Space wrap style={{ marginBottom: 8 }}>
          <Input.Search allowClear style={{ width: 240 }} placeholder="搜索 ASIN、SKU、标题" aria-label="搜索商品" onSearch={value => set({ q: value.trim() || undefined })} />
          <Input.Search allowClear style={{ width: 160 }} placeholder="父 ASIN" aria-label="父 ASIN" onSearch={value => set({ parentAsin: value.trim() || undefined })} />
          <Pick label="品牌" value={filters.brand} options={same(options?.brands)} onChange={value => set({ brand: value })} width={130} />
          <Pick label="类目" value={filters.category} options={same(options?.categories)} onChange={value => set({ category: value })} width={160} />
          <Pick
            label="刊登状态"
            value={filters.status}
            options={(options?.statuses ?? []).map(status => ({ value: status, label: PRODUCT_LISTING_LABEL[status] ?? status }))}
            onChange={value => set({ status: value })}
            width={110}
          />
          <Pick
            label="配送方式"
            value={filters.fulfillment}
            options={PRODUCT_CHANNELS.map(channel => ({ value: channel, label: PRODUCT_CHANNEL_LABEL[channel] }))}
            onChange={value => set({ fulfillment: value })}
            width={140}
          />
          <Pick label="标签" value={filters.tag} options={same(options?.tags)} onChange={value => set({ tag: value })} width={120} />
          <Pick label="负责人" value={filters.ownerId} options={(options?.owners ?? []).map(item => ({ value: item.id, label: item.name }))} onChange={value => set({ ownerId: value })} width={120} />
          <Pick
            label="库存风险"
            value={filters.risk}
            options={INVENTORY_RISK_LEVELS.map(level => ({ value: level, label: INVENTORY_RISK_LABEL[level] }))}
            onChange={value => set({ risk: value })}
            width={170}
          />
          <Pick label="关注" value={filters.watched} options={WATCH_OPTIONS} onChange={value => set({ watched: value })} width={120} />
        </Space>
        {filters.risk ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={PRODUCT_RISK_FILTER_NOTE} /> : null}
        <Space wrap style={{ marginBottom: 8 }}>
          <Select
            value={sort.field}
            aria-label="排序字段"
            style={{ width: 170 }}
            options={PRODUCT_SORTS.map(field => ({ value: field, label: `按${PRODUCT_SORT_LABEL[field]}排序` }))}
            onChange={field => {
              setSort(current => ({ ...current, field }))
              reset()
            }}
          />
          <Button
            aria-label="排序方向"
            onClick={() => {
              setSort(current => ({ ...current, dir: current.dir === 'desc' ? 'asc' : 'desc' }))
              reset()
            }}
          >
            {sort.dir === 'desc' ? '从高到低' : '从低到高'}
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
          <ProductMetaAction targets={selected} members={data?.members ?? []} onDone={() => setSelected([])} />
          <SyncAction targets={selected} />
          <WatchAction targets={selected} onDone={() => void query.refetch()} />
          <ReplenishAction />
          <ExportAction filters={exportFilters} />
          {selected.length > 0 ? <span style={{ color: 'rgba(0,0,0,0.45)' }}>已选 {selected.length} 个</span> : null}
        </Space>
        <SimpleGrid<ProductListRow>
          columns={columns}
          rows={data?.items}
          rowKey={row => row.id}
          loading={query.isFetching}
          error={query.error}
          onRetry={() => void query.refetch()}
          gridId="products"
          resetKey={JSON.stringify([filters, sort, pageSize, stack.length])}
          onSelectionChange={setSelected}
          emptyState={{
            kind: 'empty',
            domain: '商品',
            prerequisite: filtered ? '没有符合条件的商品；可以放宽筛选条件。' : (data?.note ?? '还没有同步到商品；连接店铺并同步商品目录后显示。'),
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
            第 {stack.length} 页{data ? `，共 ${data.pageInfo.approxTotal ?? data.items.length} 个商品` : ''}
          </span>
        </Space>
        {data ? <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{data.basis}</p> : null}
      </Card>
    </div>
  )
}
