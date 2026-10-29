import { useParams } from '@tanstack/react-router'
import type { InventoryDetailResponse } from '@nova/api-contracts'
import { DataState, DetailLayout, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { identityMetrics, inventoryCodes, inventoryDetailTabs, statusTags, suggestionsOf } from './inventory-detail-parts'
import { LiveLink, RiskTag } from './inventory-ui'

// 库存详情（P2a-06，06 章 6.1；P6-05 起用整页详情骨架）：头部信息卡（编码字段组 + 6 项关键指标，滚动时收缩吸顶）
// → 规则建议 → 吸顶页签（10 个页签，只在被打开时才取数）。身份区与页签与库存健康的行详情抽屉共用（inventory-detail-parts）。

export default function InventoryDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string }
  const query = useApiQuery<InventoryDetailResponse>({ domain: 'list', path: `/inventory/${encodeURIComponent(id)}`, scoped: false })

  if (query.error) return <DataState {...stateFromError(describeError(query.error), { permission: 'inventory.read', onRetry: () => void query.refetch() })} />
  if (query.isPending || !query.data) return <DataState kind="skeleton" rows={6} />

  const detail = query.data
  const { row } = detail
  return (
    <DetailLayout
      title={row.title ?? row.sku}
      codes={inventoryCodes(detail)}
      statuses={statusTags(detail)}
      metrics={identityMetrics(detail)}
      freshness={{ lastSuccessAt: detail.freshness.lastSuccessAt, sources: detail.freshness.sources, qualityIssues: detail.freshness.qualityIssues }}
      primaryActions={
        <>
          {detail.productId ? (
            <LiveLink component="Asin360Page" id={detail.productId}>
              商品全景（ASIN 360）
            </LiveLink>
          ) : null}
          <RiskTag assessment={row.assessment} />
        </>
      }
      suggestions={suggestionsOf(detail)}
      tabs={inventoryDetailTabs(id)}
    />
  )
}
