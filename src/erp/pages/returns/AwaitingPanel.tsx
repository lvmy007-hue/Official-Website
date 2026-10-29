import { Alert } from 'antd'
import type { ReturnAwaitingResponse } from '@nova/api-contracts'
import { FreshnessBar } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { awaitingColumns } from './returns-columns'
import { LocalGrid } from './returns-local-grid'

// 退款后未收到退货（07 章 7.2 “退款后是否已收到退货”）：订单第一笔退款入账已满阈值天数、却没有任何退货记录的订单。
// 这是待核实清单，不是赔付结论；退款不等于要退货。数据不全（交易、候选订单触到上限）时明说。清单一次返回，用 PagedGrid 分页显示。

export function AwaitingPanel() {
  const query = useApiQuery<ReturnAwaitingResponse>({ domain: 'list', path: '/returns/awaiting' })
  const data = query.data
  return (
    <div>
      <FreshnessBar freshness={data?.freshness} />
      {data ? (
        <Alert type="info" showIcon style={{ margin: '8px 0' }} message={`退款已满 ${data.thresholdDays} 天仍没有收到退货的订单（${data.range.from} 至 ${data.range.to}）`} description={data.basis} />
      ) : null}
      {data?.truncated ? (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '8px 0' }}
          message="清单可能不完整"
          description="退款交易或候选订单数量触到上限，只显示了退款最早的一部分订单；请缩小日期范围或选择店铺后再看。"
        />
      ) : null}
      <LocalGrid
        gridId="returns.awaiting"
        columns={awaitingColumns}
        rows={data?.items}
        getRowId={row => `${row.sellerAccountId}|${row.amazonOrderId}`}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '退款后未收到退货', prerequisite: data?.note ?? '所选范围内没有满足条件的订单；店铺授权并完成财务交易与客户退货报告同步后显示。' }}
        height={420}
      />
    </div>
  )
}
