import { useParams } from '@tanstack/react-router'
import { Alert } from 'antd'
import { PROMOTION_TAB_LABEL, budgetTextOf, type PromotionDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import type { IdentityMetric } from '../../components/detail/DetailLayout'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { Muted } from '../inventory/inventory-ui'
import { timeText } from '../orders/orders-ui'
import { AdsTab, CostTab, EffectTab, IssuesTab, ItemsTab, ProfitTab } from './promotion-tabs'
import { PromotionStatusTag, SyncNotice } from './promotions-ui'

// 促销详情（P4-05，04 章 4.8）：身份区 ≤6 项 → 效果 / 商品 / 成本 / 利润 / 问题 / 广告六个页签。
// 只读：亚马逊促销接口没有创建、修改、取消，页面顶部明确写明，所有改动请到卖家后台。效果与回报率是基线法的模型估算，页面常驻口径说明并在数字旁标“估算”。

const metricsOf = (detail: PromotionDetailResponse): IdentityMetric[] => {
  const row = detail.promotion
  return [
    { label: '状态', value: <PromotionStatusTag row={row} /> },
    { label: '类型', value: row.couponType ? `${row.typeLabel}（${row.couponType}）` : row.typeLabel },
    { label: '开始', value: timeText(row.startAt) },
    { label: '结束', value: row.endAt ? timeText(row.endAt) : <Muted>长期有效</Muted> },
    { label: '折扣力度', value: row.benefitTextFull ?? <Muted>未提供</Muted> },
    { label: '预算', value: budgetTextOf(row.budget) ?? <Muted>未设置</Muted> },
  ]
}

export default function PromotionDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<PromotionDetailResponse>({ domain: 'list', path: `/promotions/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'analytics.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  const row = detail.promotion
  return (
    <div>
      <SyncNotice sync={detail.sync} />
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message={detail.write.note} data-testid="promotion-readonly" />
      <DetailLayout
        title={row.title}
        subtitle={`${row.storeName} · ${row.promotionId}`}
        metrics={metricsOf(detail)}
        freshness={{ lastSuccessAt: detail.freshness.lastSuccessAt, sources: detail.freshness.sources, qualityIssues: detail.freshness.qualityIssues }}
        tabs={[
          { key: 'effect', label: PROMOTION_TAB_LABEL.effect, children: <EffectTab detail={detail} /> },
          { key: 'items', label: PROMOTION_TAB_LABEL.items, children: <ItemsTab detail={detail} /> },
          { key: 'cost', label: PROMOTION_TAB_LABEL.cost, children: <CostTab detail={detail} /> },
          { key: 'profit', label: PROMOTION_TAB_LABEL.profit, children: <ProfitTab detail={detail} /> },
          { key: 'issues', label: PROMOTION_TAB_LABEL.issues, children: <IssuesTab detail={detail} /> },
          { key: 'ads', label: PROMOTION_TAB_LABEL.ads, children: <AdsTab detail={detail} /> },
        ]}
      />
    </div>
  )
}
