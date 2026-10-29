import { MATRIX_RISK_RANK, type InventoryRiskLevel } from '@nova/api-contracts'
import type { ResolvedScope } from '../auth'
import type { InventoryLoaderService, InventoryPolicyService } from '../inventory'
import { nullableSum } from '../overview'

// 父体各子体的库存汇总（P4-03）：复用库存健康的读取与评估（口径与库存健康页一致），这里只把同一 ASIN 的多个 SKU、多个店铺合并成一行。

export interface ChildStock {
  asin: string
  skuCount: number
  sellable: number | null
  inboundCounted: number | null
  /** 同一 ASIN 各 SKU 里最短的可售天数与最早的断货日（最紧的那个）。 */
  daysOfCover: number | null
  stockoutDate: string | null
  risk: InventoryRiskLevel | null
}

export interface ParentStock {
  /** 有没有生效的补货策略；没有时只有库存数量，没有风险与可售天数。 */
  hasPolicy: boolean
  byAsin: Map<string, ChildStock>
  truncated: boolean
}

export async function stockOf(
  loader: InventoryLoaderService,
  policies: InventoryPolicyService,
  input: { tenantId: string; scope: ResolvedScope; today: string; asins: ReadonlySet<string> },
): Promise<ParentStock> {
  const policy = await policies.currentOf(input.tenantId, input.today)
  const { items, truncated } = await loader.load({ tenantId: input.tenantId, scope: input.scope, today: input.today, policy })
  const grouped = new Map<string, typeof items>()
  for (const item of items) if (input.asins.has(item.row.asin)) grouped.set(item.row.asin, [...(grouped.get(item.row.asin) ?? []), item])
  const byAsin = new Map<string, ChildStock>()
  for (const [asin, list] of grouped) {
    const rows = list.map(item => item.row)
    const risks = rows.flatMap(row => (row.assessment.state === 'OK' && row.assessment.risk ? [row.assessment.risk] : []))
    const dates = rows.flatMap(row => (row.assessment.stockoutDate ? [row.assessment.stockoutDate] : [])).sort()
    byAsin.set(asin, {
      asin,
      skuCount: rows.length,
      sellable: nullableSum(rows.map(row => row.quantity.sellable)),
      inboundCounted: nullableSum(rows.map(row => row.quantity.inboundCounted)),
      daysOfCover: rows.flatMap(row => (row.assessment.daysOfCover === null ? [] : [row.assessment.daysOfCover])).sort((a, b) => a - b)[0] ?? null,
      stockoutDate: dates[0] ?? null,
      risk: risks.length === 0 ? null : risks.reduce((worst, risk) => (MATRIX_RISK_RANK[risk] > MATRIX_RISK_RANK[worst] ? risk : worst)),
    })
  }
  return { hasPolicy: policy !== null, byAsin, truncated }
}
