import { useParams } from '@tanstack/react-router'
import type { SettlementSummaryResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { money } from '../orders/orders-ui'
import { DisbursementsTab, LinesTab, ReconciliationTab, SummaryTab } from './settlement-sections'
import { StatusTag, dayText, periodText } from './settlements-ui'

// 结算单详情（P2b-07，07 章 7.7）：身份区 ≤6 项 → 汇总 / 交易明细 / 三方核对 / 打款记录。只读：核对结果由后台每 6 小时重算，页面不能手工改。
// 到账的手工登记属于回款页（P2b-08），这里只显示结算报告里的打款信息。

const metricsOf = (summary: SettlementSummaryResponse): IdentityMetric[] => {
  const row = summary.settlement
  return [
    { label: '核对状态', value: <StatusTag status={row.status} label={row.statusLabel} pendingReason={row.pendingReason} /> },
    { label: '店铺', value: row.storeName },
    { label: '结算周期（UTC）', value: periodText(row.periodStart, row.periodEnd) },
    { label: '打款日', value: dayText(row.depositDate) },
    { label: '打款金额', value: money(row.disbursementAmount, row.currency) },
    { label: '期初余额', value: money(row.openingBalance, row.currency) },
  ]
}

export default function SettlementDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<SettlementSummaryResponse>({ domain: 'list', path: `/settlements/${encodeURIComponent(id)}/summary`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'finance.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const summary = query.data
  const settlementId = summary.settlement.id
  return (
    <DetailLayout
      title={`结算单 ${summary.settlement.externalSettlementId}`}
      subtitle={`结算币种 ${summary.settlement.currency}`}
      metrics={metricsOf(summary)}
      freshness={{ lastSuccessAt: summary.freshness.lastSuccessAt, sources: summary.freshness.sources, qualityIssues: summary.freshness.qualityIssues }}
      tabs={[
        { key: 'summary', label: '汇总', children: <SummaryTab summary={summary} /> },
        { key: 'lines', label: '交易明细', children: <LinesTab id={settlementId} /> },
        { key: 'reconciliation', label: `三方核对${summary.settlement.openExceptions > 0 ? `（${summary.settlement.openExceptions}）` : ''}`, children: <ReconciliationTab id={settlementId} /> },
        { key: 'disbursements', label: '打款记录', children: <DisbursementsTab id={settlementId} /> },
      ]}
    />
  )
}
