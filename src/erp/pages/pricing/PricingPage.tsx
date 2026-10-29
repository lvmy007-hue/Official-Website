import { useRef, useState } from 'react'
import { Alert, Button, Card, Input, Select, Space, Tabs, Tag } from 'antd'
import { PRICING_PRICE_WRITE, PRICING_SORTS, type PriceHealth, type PricingListResponse, type PricingRow, type PricingSort } from '@nova/api-contracts'
import { ActionGuard, FreshnessBar, PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { GuardrailPanel } from './GuardrailPanel'
import { PriceChangeDrawer, type PriceChangeTarget, type RuleSuggestion } from './PriceChangeDrawer'
import { RulePanel } from './RulePanel'
import { pricingColumns } from './pricing-columns'
import { PAGE_SIZES, HEALTH_COLOR, guardOf, type PricingFilters } from './pricing-state'

// 定价与购物车（P4-11，05 章 5.5）：价格列表（当前价、推荐报价、最低竞争价、预期获胜价、差距、购物车获得率、价格健康、利润率）、
// 价格护栏、定价规则。筛选、排序、分页在服务端；没有数据写“尚无记录”，没有权限写“无权限”，来源没接上写“尚未接入”，不补 0。
// 利润率是估算，带“估算”标签；改价要先校验预览再提交，护栏由服务端再核一遍。

const SORT_LABEL: Record<PricingSort, string> = { sku: 'SKU', price: '当前价', gap: '与预期获胜价的差距', margin: '利润率', buyBox: '购物车获得率', lastChange: '最近调价时间' }

export default function PricingPage() {
  const [tab, setTab] = useState('prices')
  const [filters, setFilters] = useState<PricingFilters>({})
  const [sort, setSort] = useState<PricingSort>('gap')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const [change, setChange] = useState<{ target: PriceChangeTarget; suggestion?: RuleSuggestion } | null>(null)

  const reset = () => setStack([undefined])
  const apply = (patch: Partial<PricingFilters>) => {
    setFilters(current => ({ ...current, ...patch }))
    reset()
  }
  const query = useApiQuery<PricingListResponse>({
    domain: 'list',
    path: '/pricing',
    params: { ...filters, sort: `${sort}:${dir}`, pageSize, cursor: stack[stack.length - 1] },
  })
  const data = query.data
  // 换条件重新读取期间，顶部统计、筛选项与写入状态沿用上一次的结果，避免整块闪烁；表格行与分页只用本次结果
  const last = useRef<PricingListResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const write = shell?.write
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(filters.q || filters.health)
  const targetOf = (row: PricingRow): PriceChangeTarget => ({
    storeId: row.storeId,
    sku: row.sku,
    asin: row.asin,
    title: row.title,
    currency: row.currency,
    price: row.price,
    expectedPrice: row.expectedPrice,
    limits: row.limits,
  })
  const columns = pricingColumns({
    onChange: row => (
      <ActionGuard label="改价" guard={guardOf(PRICING_PRICE_WRITE, write?.validate)} onExecute={async () => setChange({ target: targetOf(row) })} buttonProps={{ type: 'link', size: 'small' }} />
    ),
  })

  const prices = (
    <>
      {data && data.state !== 'OK' && data.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.note} /> : null}
      {shell ? (
        <Space wrap size={8} style={{ marginBottom: 8 }} data-testid="pricing-summary">
          {shell.summary.health.map(item => {
            const selected = filters.health === item.state
            return (
              <Card
                key={item.state}
                size="small"
                hoverable
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${item.label}（点击筛选）`}
                style={{ width: 190, borderColor: selected ? 'var(--ant-color-primary)' : undefined, cursor: 'pointer' }}
                onClick={() => apply({ health: selected ? undefined : item.state })}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    apply({ health: selected ? undefined : item.state })
                  }
                }}
              >
                <div style={{ fontSize: 12 }}>{item.label}</div>
                <div style={{ fontSize: 20 }}>
                  <span className="erp-num">{item.count}</span>
                </div>
              </Card>
            )
          })}
          <Card size="small" style={{ width: 190 }}>
            <div style={{ fontSize: 12 }}>已有价格 / 尚无价格记录</div>
            <div style={{ fontSize: 20 }}>
              <span className="erp-num">{shell.summary.withPrice}</span> / {shell.summary.withoutPrice > 0 ? <span className="erp-num">{shell.summary.withoutPrice}</span> : <Muted>无</Muted>}
            </div>
          </Card>
        </Space>
      ) : null}
      <Space wrap style={{ marginBottom: 8 }}>
        <Input.Search
          allowClear
          style={{ width: 240 }}
          placeholder="搜索 ASIN、SKU、标题"
          aria-label="搜索商品"
          key={`q|${filters.q ?? ''}`}
          defaultValue={filters.q}
          onSearch={value => apply({ q: value.trim() || undefined })}
        />
        <Select
          allowClear
          style={{ width: 220 }}
          placeholder="价格健康"
          aria-label="价格健康"
          value={filters.health}
          options={(shell?.summary.health ?? []).map(item => ({ value: item.state, label: item.label }))}
          onChange={value => apply({ health: value as PriceHealth | undefined })}
        />
        <Select
          value={sort}
          aria-label="排序字段"
          style={{ width: 200 }}
          options={PRICING_SORTS.map(field => ({ value: field, label: `按${SORT_LABEL[field]}排序` }))}
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
        {filters.health ? (
          <Tag closable color={HEALTH_COLOR[filters.health]} onClose={() => apply({ health: undefined })}>
            已筛选：{shell?.summary.health.find(item => item.state === filters.health)?.label ?? filters.health}
          </Tag>
        ) : null}
      </Space>
      <SimpleGrid<PricingRow>
        gridId="pricing.pricing-page"
        columns={columns}
        rows={data?.items}
        rowKey={row => row.id}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{
          kind: 'empty',
          domain: '商品价格',
          prerequisite: filtered ? '没有符合条件的商品；可以放宽筛选条件。' : (data?.note ?? '还没有同步到价格；连接店铺并授权“定价”角色后，每 2 小时同步一次。'),
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
      {data ? (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
          {data.basis} {data.marginBasis}
        </p>
      ) : null}
    </>
  )

  return (
    <div data-testid="pricing-page">
      <PageHeader
        title="定价与购物车"
        description="看每个商品的价格、推荐报价（购物车）与预期获胜价的差距，估算利润率；设置价格护栏与定价规则，调价要先校验预览再提交。利润率是估算，调价前后对照只是相关性、不是因果。"
      />
      <FreshnessBar freshness={shell?.freshness} />
      <Card size="small" style={{ marginTop: 8 }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'prices', label: '价格列表', children: prices },
            { key: 'guardrails', label: '价格护栏', children: <GuardrailPanel write={write} stores={shell?.stores ?? []} /> },
            { key: 'rules', label: '定价规则', children: <RulePanel write={write} stores={shell?.stores ?? []} onConfirm={(target, suggestion) => setChange({ target, suggestion })} /> },
          ]}
        />
      </Card>
      <PriceChangeDrawer target={change?.target ?? null} suggestion={change?.suggestion} write={write} onClose={() => setChange(null)} />
    </div>
  )
}
