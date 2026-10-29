import { useMemo } from 'react'
import { Alert, Descriptions, Typography } from 'antd'
import type { ReturnCrossMonthRefund, ReturnCrossMonthResponse } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { matrixColumns, matrixRows } from './analysis-columns'
import { AnalysisHead, BasisNote, TruncatedNote, UnknownNotice, unitsText, type AnalysisParams } from './analysis-shared'
import { LocalGrid } from './returns-local-grid'

// 退货分析·跨月退货（P6-13，M-702）：下单月与退货月不同的退货占多少，另给“下单月 × 退货月”的件数矩阵（最多 12 个月）。
// 缺下单时间的退货不进分子分母，单独写明条数。退款金额占比取订单口径的财务交易，同一订单只算一次；核对的订单有上限，超出时写“部分”。

function RefundShare({ refund }: { refund: ReturnCrossMonthRefund }) {
  if (refund.state === 'OK' || refund.state === 'PARTIAL') {
    const money = (value: number | null) => (value === null || !refund.currency ? '—' : formatMoney(value, refund.currency, { digits: 2 }))
    return (
      <span className="erp-num">
        {refund.share === null ? '尚无记录' : formatPercent(refund.share, { digits: 1 })}（跨月 {money(refund.crossMonthAmount)} ÷ 合计 {money(refund.totalAmount)}
        {refund.state === 'PARTIAL' ? `；只核对了最近 ${refund.sampledOrders} 个订单` : ''}）
      </span>
    )
  }
  return <Muted>{refund.note ?? '尚无记录'}</Muted>
}

export function AnalysisCrossMonth({ params }: { params: AnalysisParams }) {
  const query = useApiQuery<ReturnCrossMonthResponse>({ domain: 'analytics', path: '/returns/analysis/cross-month', params: { timeBasis: params.timeBasis } })
  const data = query.data
  const matrix = data?.matrix
  const columns = useMemo(() => matrixColumns('下单月 \\ 退货月', matrix?.returnMonths ?? [], { group: '退货月', metric: 'M-702' }), [matrix?.returnMonths])
  const rows = useMemo(
    () =>
      matrix
        ? matrixRows(
            matrix.orderMonths.map(month => ({ key: month, label: month })),
            matrix.cells,
          )
        : undefined,
    [matrix],
  )
  const emptyText = data?.note ?? '所选日期范围内没有能确定下单月的退货。'

  return (
    <div>
      <AnalysisHead data={data} />
      {data ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ margin: '8px 0' }} data-testid="cross-month-totals">
          <Descriptions.Item label="可计算的退货件数">{unitsText(data.totals.computableUnits)}</Descriptions.Item>
          <Descriptions.Item label="跨月退货件数">{unitsText(data.totals.crossMonthUnits)}</Descriptions.Item>
          <Descriptions.Item label="跨月退货占比">
            {data.totals.share === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(data.totals.share, { digits: 1 })}</span>}
          </Descriptions.Item>
          <Descriptions.Item label="跨月退款金额占比" span={3}>
            <RefundShare refund={data.refund} />
          </Descriptions.Item>
        </Descriptions>
      ) : null}
      <UnknownNotice data={data} what="无法判断是否跨月" />
      <TruncatedNote show={data?.truncated} />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        下单月 × 退货月（件）
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.cross-month"
        columns={columns}
        rows={rows}
        getRowId={row => row.key}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '跨月退货', prerequisite: emptyText }}
        height={460}
      />
      {matrix && matrix.hiddenUnits > 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ margin: '8px 0' }}
          message={`另有 ${formatNumber(matrix.hiddenUnits, { digits: 0 })} 件落在显示的月份之外`}
          description="矩阵只显示最近 12 个月；上面的占比用的是全部可计算的退货。"
        />
      ) : null}
      <BasisNote text={data?.basis} />
    </div>
  )
}
