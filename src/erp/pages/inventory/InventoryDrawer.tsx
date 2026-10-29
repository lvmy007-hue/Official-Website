import type { InventoryDetailResponse } from '@nova/api-contracts'
import { DataState, DetailDrawer, MetricsRow, stateFromError } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { identityMetrics, inventoryDetailTabs, statusTags } from './inventory-detail-parts'
import { LiveLink, RiskTag } from './inventory-ui'

// 库存健康列表的行详情（P6-05，15 章第 8 节“抽屉”）：点列表里的 SKU 在右侧抽屉里快速查看，不离开列表。
// 960 宽；顶部是对象标识（名称、SKU、ASIN、店铺、状态）和主操作（风险、商品全景），下面是 6 项关键指标与 10 个页签
// （与整页详情同一套，页签打开时才取数）；“在新页签打开完整详情”去整页。没有选中行时不取数。

export function InventoryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = useApiQuery<InventoryDetailResponse>({ domain: 'list', path: `/inventory/${encodeURIComponent(id ?? '')}`, scoped: false, enabled: id !== null })
  const detail = query.data
  const row = detail?.row
  const status = query.error ? (
    <DataState {...stateFromError(describeError(query.error), { permission: 'inventory.read', onRetry: () => void query.refetch() })} />
  ) : !detail ? (
    <DataState kind="skeleton" rows={6} />
  ) : undefined
  return (
    <DetailDrawer
      open={id !== null}
      onClose={onClose}
      width={960}
      title={row ? (row.title ?? row.sku) : '库存详情'}
      subtitle={row ? `${row.sku} · ${row.asin}${row.fnsku ? ` · ${row.fnsku}` : ''} · ${row.storeName}` : undefined}
      statuses={detail ? statusTags(detail) : undefined}
      actions={
        detail && row ? (
          <>
            {detail.productId ? (
              <LiveLink component="Asin360Page" id={detail.productId}>
                商品全景（ASIN 360）
              </LiveLink>
            ) : null}
            <RiskTag assessment={row.assessment} />
          </>
        ) : undefined
      }
      fullPath={id ? `/app/inventory/${encodeURIComponent(id)}` : undefined}
      summary={detail ? <MetricsRow metrics={identityMetrics(detail)} /> : undefined}
      status={status}
      tabs={id ? inventoryDetailTabs(id) : []}
    />
  )
}
