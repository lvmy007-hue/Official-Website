import type { InventoryCard, InventorySummaryResponse } from '@nova/api-contracts'
import type { GridSummaryResponse } from '../../components/table/grid-types'

// 库存列表的汇总行（P6-02 示范，P6-03 迁到 PagedGrid 的 fetchSummary）：汇总只取服务端，前端不求和。
// 数字来自 GET /inventory/summary 的指标卡（服务端对范围内全部 SKU 的合计，不是当前页之和）：
// - 只在“全部库存”页签且没有搜索词、范围内 SKU 没被截断时显示，否则合计和列表对不上；
// - 接口没有合计的列显示“—”；卡片不是“有数据”状态（尚无记录、尚未接入）时合计为 null，同样显示“—”，不显示成 0。

const valueOf = (card: InventoryCard): number | null => (card.state === 'OK' && card.value !== null ? card.value : null)

/** 能否显示合计：合计覆盖范围内全部 SKU，所以必须是“全部库存”页签、没有搜索、没有被截断。 */
export const canShowTotals = (summary: InventorySummaryResponse | undefined, tab: string, q: string): summary is InventorySummaryResponse =>
  !!summary && tab === 'all' && q === '' && !summary.truncated

/** 列标识 → 服务端合计；没有合计的列不出现，表格显示“—”。 */
export function inventoryTotals(summary: InventorySummaryResponse): GridSummaryResponse {
  const { cards } = summary
  return {
    totals: {
      sellable: valueOf(cards.sellableTotal),
      inbound: valueOf(cards.inboundTotal),
      unsellable: valueOf(cards.unsellableTotal),
      ageSurcharge: valueOf(cards.ageSurchargeEstimate),
      storage: valueOf(cards.nextMonthStorageFee),
    },
    currency: 'USD',
  }
}
