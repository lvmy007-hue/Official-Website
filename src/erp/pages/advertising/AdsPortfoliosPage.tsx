import { useState } from 'react'
import { Alert, Button, Card, Input, Select, Space, Tooltip } from 'antd'
import {
  ADS_PORTFOLIO_PACE_LABEL,
  ADS_PORTFOLIO_PACES,
  ADS_PORTFOLIO_SORT_LABEL,
  ADS_PORTFOLIO_SORTS,
  type AdsPortfolioListResponse,
  type AdsPortfolioPaceVerdict,
  type AdsPortfolioSort,
} from '@nova/api-contracts'
import { PageHeader, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { moneyCell, numberCell } from './ads-campaigns-ui'
import { portfolioColumns } from './ads-portfolios-columns'

// 广告组合与预算（P3-11，08 章 8.8）：每个组合的预算上限与周期、已用金额、实际与理想节奏、活动数与所选范围的关键指标；偏快与偏慢一眼能看出来。
// 筛选、排序、翻页都在服务端。新建组合、改预算上限与预算规则写亚马逊，随“广告写入接入”（P3-17），这里禁用并说明原因。没有数据写“尚无记录”，算不出节奏写原因。

const PAGE_SIZES = [20, 50, 100]

export default function AdsPortfoliosPage() {
  const [q, setQ] = useState<string>()
  const [pace, setPace] = useState<AdsPortfolioPaceVerdict>()
  const [sort, setSort] = useState<{ field: AdsPortfolioSort; dir: 'asc' | 'desc' }>({ field: 'spend', dir: 'desc' })
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  // 游标栈：栈顶是当前页的游标，undefined 表示第一页
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const reset = () => setStack([undefined])
  const query = useApiQuery<AdsPortfolioListResponse>({
    domain: 'analytics',
    path: '/ads/portfolios',
    params: { q, pace, sort: `${sort.field}:${sort.dir}`, pageSize, cursor: stack[stack.length - 1] },
  })
  const data = query.data
  const next = data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null
  const filtered = Boolean(q || pace)
  const summary = data?.summary

  return (
    <div data-testid="ads-portfolios-page">
      <PageHeader
        title="广告组合与预算"
        description="每个广告组合的预算上限、已用金额与花费节奏：实际累计对比理想累计，偏快或偏慢会标出来。指标是所选日期范围内的合计（美元账户）；改预算上限与预算规则暂未提供写入入口，请在亚马逊广告后台操作。"
      />
      <Card size="small">
        {data?.range.defaulted ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 8 }}
            message={`未选择日期范围，当前显示 ${data.range.from} 至 ${data.range.to} 的指标（最近 30 天）；预算节奏按各组合自己的预算周期计算，不受日期范围影响`}
          />
        ) : null}
        {data?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="广告组合、预算周期或活动数量超过读取上限，只处理了一部分；请缩小店铺范围" /> : null}
        {data?.metricsTruncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="报表分组超过读取上限，部分组合的花费或节奏可能缺失，历史节奏已退回按天均摊" /> : null}
        {data?.note && data.state === 'OK' ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.note} /> : null}
        {summary && summary.portfolios > 0 ? (
          <Space size={24} wrap style={{ marginBottom: 8 }} data-testid="ads-portfolios-summary">
            <span>
              组合 <strong>{numberCell(summary.portfolios)}</strong> 个，设了预算 {summary.withBudget} 个
            </span>
            <span>
              偏快 <strong style={summary.ahead > 0 ? { color: '#d48806' } : undefined}>{summary.ahead}</strong> 个，正常 <strong>{summary.onTrack}</strong> 个，偏慢 <strong>{summary.behind}</strong>{' '}
              个
            </span>
            <span>
              已算出节奏的预算上限合计 <strong>{moneyCell(summary.cap)}</strong>，已用 <strong>{moneyCell(summary.spent)}</strong>
            </span>
          </Space>
        ) : null}
        <Space wrap style={{ marginBottom: 8 }}>
          <Input.Search
            allowClear
            style={{ width: 240 }}
            placeholder="搜索组合名称"
            aria-label="搜索组合名称"
            onSearch={value => {
              setQ(value.trim() || undefined)
              reset()
            }}
          />
          <Select
            allowClear
            style={{ width: 150 }}
            placeholder="预算节奏"
            aria-label="预算节奏"
            value={pace}
            options={ADS_PORTFOLIO_PACES.map(value => ({ value, label: ADS_PORTFOLIO_PACE_LABEL[value] }))}
            onChange={value => {
              setPace(value)
              reset()
            }}
          />
          <Select
            value={sort.field}
            aria-label="排序字段"
            style={{ width: 190 }}
            options={ADS_PORTFOLIO_SORTS.map(field => ({ value: field, label: `按${ADS_PORTFOLIO_SORT_LABEL[field]}排序` }))}
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
          <Tooltip title={data?.write.note}>
            <span>
              <Button disabled>新建组合</Button> <Button disabled>修改预算上限</Button>
            </span>
          </Tooltip>
        </Space>
        <SimpleGrid
          gridId="advertising.ads-portfolios-page"
          columns={portfolioColumns()}
          rows={data?.items}
          rowKey={row => row.id}
          loading={query.isFetching}
          error={query.error}
          onRetry={() => void query.refetch()}
          emptyState={{
            kind: 'empty',
            domain: '广告组合',
            prerequisite: filtered && data?.state !== 'NOT_CONNECTED' ? '没有符合条件的广告组合；可以放宽筛选条件。' : (data?.note ?? '还没有同步到广告组合；连接广告账户并同步广告组合后显示。'),
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
            第 {stack.length} 页{data ? `，共 ${data.pageInfo.approxTotal ?? data.items.length} 个组合` : ''}
          </span>
        </Space>
        {data ? (
          <div style={{ marginTop: 8, color: 'rgba(0,0,0,0.45)', fontSize: 12 }} data-testid="ads-portfolios-basis">
            {data.paceBasis}
          </div>
        ) : null}
      </Card>
    </div>
  )
}
