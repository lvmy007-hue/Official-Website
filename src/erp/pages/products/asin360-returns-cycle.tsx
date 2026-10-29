import { useCallback, useMemo } from 'react'
import { Space, Statistic } from 'antd'
import type { Asin360IdentityResponse, ReturnCycleBucketRow, ReturnCycleResponse } from '@nova/api-contracts'
import { DataState, PagedGrid, renderColumn, RIGHT_ALIGNED, stateFromError, useDetailFilter, type ErpColDef, type PageFetcher } from '../../components'
import { formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { useProductQuery } from './asin360-hooks'

// 退货周期（P6-21，16 章 3.1 第 6 项“退货周期分布（新）”）：复用退货分析的周期接口（P6-13），只看本商品这一个 ASIN；
// 日期取共享筛选，起点用下单日期，天数段用默认段。没有退货记录写原因，缺起点日期的退货单独说明，不当 0 天。

function CycleGrid({ data }: { data: ReturnCycleResponse }) {
  const columns = useMemo<ErpColDef<ReturnCycleBucketRow>[]>(
    () => [
      renderColumn<ReturnCycleBucketRow>('退货周期', 'label', row => row.label, { group: '周期', pin: 'left', width: 180, sortable: false }),
      renderColumn<ReturnCycleBucketRow>('件数', 'units', row => <span className="erp-num">{formatNumber(row.units)}</span>, { group: '分布', width: 120, sortable: false, ...RIGHT_ALIGNED }),
      renderColumn<ReturnCycleBucketRow>('占比', 'share', row => (row.share === null ? <Muted>—</Muted> : <span className="erp-num">{formatPercent(row.share)}</span>), {
        group: '分布',
        width: 120,
        sortable: false,
        ...RIGHT_ALIGNED,
      }),
    ],
    [],
  )
  const fetchPage = useCallback<PageFetcher<ReturnCycleBucketRow>>(
    async ({ page, pageSize }) => ({ items: data.buckets.slice((page - 1) * pageSize, page * pageSize), total: data.buckets.length }),
    [data.buckets],
  )
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }} data-testid="asin360-returns-cycle">
      <Space size={24} wrap>
        <Statistic title="退货件数" value={data.totals.units} />
        <Statistic title="周期中位数（天）" value={data.totals.median === null ? '—' : formatNumber(data.totals.median, { digits: 1 })} />
      </Space>
      {data.unknownOrderRows > 0 ? <Muted>{`无法计算周期 ${formatNumber(data.unknownOrderRows)} 条（${formatNumber(data.unknownOrderUnits)} 件）：缺下单日期，没有计入上面的分布`}</Muted> : null}
      <PagedGrid<ReturnCycleBucketRow>
        gridId="asin360.returns-cycle"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.key}
        resetKey={`${data.range.from}:${data.range.to}:${data.totals.units}`}
        emptyState={{ kind: 'empty', domain: '退货周期', prerequisite: data.note ?? '所选范围内这个商品没有退货记录' }}
        height={320}
      />
      <Muted>{data.basis}</Muted>
    </Space>
  )
}

export function ReturnsCycleBlock({ id }: { id: string }) {
  const filter = useDetailFilter()
  const identity = useProductQuery<Asin360IdentityResponse>(id, '')
  const product = identity.data?.product
  const query = useApiQuery<ReturnCycleResponse>({
    domain: 'analytics',
    path: '/returns/analysis/cycle',
    scoped: false,
    params: { ...(filter.range ? { from: filter.range.from, to: filter.range.to } : {}), asin: product?.asin, storeIds: product?.sellerAccountId, anchor: 'order', timeBasis: 'return' },
    enabled: product !== undefined,
  })
  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'returns.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={3} />
  return <CycleGrid data={query.data} />
}
