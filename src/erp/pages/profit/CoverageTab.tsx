import { useState } from 'react'
import { Alert, Card, Col, Input, Row, Statistic, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { ProfitCoverageResponse, ProfitCoverageRow } from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { Pager } from './groups-controls'
import { ProfitFrame } from './profit-ui'

// 成本覆盖（07 章 7.9 第 5 个页签，需要成本字段权限）：哪些 SKU 的成本缺失、批次不够、仍是草稿、汇率缺失或沿用前值、成本版本过期；
// 以及账户级广告里还没分摊到商品的金额。成本版本过期的天数是我们自己定的（接口里给出），不是亚马逊或会计准则的规定。

const columns: ColumnsType<ProfitCoverageRow> = [
  {
    title: '商品',
    key: 'product',
    width: 280,
    render: (_value, row) => (
      <div>
        <span className="erp-num">{row.sku}</span>
        {row.asin ? (
          <span style={{ marginLeft: 8, color: 'rgba(0,0,0,0.45)' }}>
            {row.productId ? (
              <LiveLink component="Asin360Page" id={row.productId}>
                {row.asin}
              </LiveLink>
            ) : (
              row.asin
            )}
          </span>
        ) : null}
        <div style={{ color: 'rgba(0,0,0,0.65)' }}>{row.title ?? <Muted>尚无商品名</Muted>}</div>
      </div>
    ),
  },
  { title: '店铺', dataIndex: 'storeName', width: 120 },
  { title: '销量（件）', dataIndex: 'units', width: 100, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
  { title: '已计成本（件）', dataIndex: 'costedUnits', width: 120, align: 'right', render: (value: number) => <span className="erp-num">{formatNumber(value, { digits: 0 })}</span> },
  { title: '覆盖率', dataIndex: 'coverage', width: 90, align: 'right', render: (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : formatPercent(value, { digits: 1 })) },
  {
    title: '问题',
    key: 'issues',
    render: (_value, row) =>
      row.issues.map(item => (
        <Tag key={item.issue} color={item.issue === 'COST_STALE' || item.issue === 'FX_FALLBACK' ? 'default' : 'warning'} bordered={false}>
          {item.label}（{item.rows} 行）
        </Tag>
      )),
  },
  {
    title: '最新成本生效日',
    key: 'effective',
    width: 150,
    render: (_value, row) => (row.latestCostEffective ? `${row.latestCostEffective}（${row.costAgeDays ?? 0} 天前）` : <Muted>没有生效的成本版本</Muted>),
  },
]

export function CoverageTab({ recognition }: { recognition: string }) {
  const [q, setQ] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const query = useApiQuery<ProfitCoverageResponse>({ domain: 'list', path: '/profit/cost-coverage', params: { recognition, q, pageSize: 20, cursor: stack[stack.length - 1] } })
  return (
    <ProfitFrame query={query} testId="profit-coverage">
      {data => (
        <>
          <Row gutter={[12, 12]} style={{ margin: '8px 0 12px' }} data-testid="coverage-summary">
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="成本覆盖率" value={data.summary.coverage === null ? '尚无记录' : formatPercent(data.summary.coverage, { digits: 1 })} />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="有问题的 SKU" value={`${data.summary.skusWithIssues} / ${data.summary.skus}`} />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title={`成本版本超过 ${data.staleDays} 天未更新`} value={data.summary.staleSkus} suffix="个 SKU" />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Statistic title="汇率沿用前值 / 缺失（行）" value={`${data.fx.fallbackRows} / ${data.fx.missingRows}`} />
              </Card>
            </Col>
          </Row>
          <Alert
            type={data.adsUnallocated.total === null ? 'info' : data.adsUnallocated.total > 0 ? 'warning' : 'success'}
            showIcon
            style={{ marginBottom: 8 }}
            data-testid="coverage-ads"
            message={
              data.adsUnallocated.total === null
                ? '广告花费尚未接入，没有“未分摊广告”可看'
                : data.adsUnallocated.total > 0
                  ? `账户级广告里还没分摊到商品的金额：${formatMoney(data.adsUnallocated.total, 'USD', { digits: 2 })}`
                  : '范围内的广告花费已全部分摊到商品'
            }
            description={
              data.adsUnallocated.stores
                .filter(store => store.amount > 0)
                .map(store => `${store.storeName} ${store.amount.toFixed(2)}`)
                .join('；') || undefined
            }
          />
          {data.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="商品数量超过读取上限，列表可能不完整" /> : null}
          <Input.Search
            allowClear
            style={{ width: 260, margin: '4px 0 8px' }}
            placeholder="搜索 SKU 或 ASIN"
            aria-label="搜索 SKU"
            value={text}
            onChange={event => setText(event.target.value)}
            onSearch={value => {
              setQ(value.trim() || undefined)
              setStack([undefined])
            }}
          />
          <SimpleGrid<ProfitCoverageRow>
            gridId="profit.coverage-tab"
            columns={columns}
            rows={data.items}
            rowKey={row => row.key}
            loading={query.isFetching}
            emptyState={{ kind: 'empty', domain: '成本问题', prerequisite: q ? '没有符合搜索条件的 SKU。' : (data.note ?? '所选范围内所有 SKU 的成本都完整。') }}
          />
          <Pager stack={stack} setStack={setStack} pageInfo={data.pageInfo} fetching={query.isFetching} />
        </>
      )}
    </ProfitFrame>
  )
}
