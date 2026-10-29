import { COST_COMPONENTS, coverageOf, currentVersions, landedOf, toUsd, type CostLite, type CostPart, type CostParts, type CostRow } from '@nova/api-contracts'
import { rateOf, type RateMap } from './costs-fx'

// 把一个 SKU 的生效版本装配成列表里的一行（P2b-14）：当前各项成本、折合美元、到岸成本合计、覆盖状态。列表与详情共用。

export interface SkuSummary {
  activeCount: number
  draftCount: number
  /** 生效日不晚于今天的、带采购单价的生效版本里最新的生效日。 */
  productEffectiveFrom: string | null
  lastChangedAt: Date | null
}

export const EMPTY_SUMMARY: SkuSummary = { activeCount: 0, draftCount: 0, productEffectiveFrom: null, lastChangedAt: null }

export function partsOf(versions: readonly CostLite[], rates: RateMap, today: string): CostParts {
  const current = currentVersions(versions, today)
  const parts: CostParts = { product: null, firstMile: null, duty: null, other: null }
  for (const component of COST_COMPONENTS) {
    const version = current[component]
    const amount = version?.[component]
    if (!version || amount === null || amount === undefined) continue
    const part: CostPart = {
      amount: String(amount),
      currency: version.currency,
      usd: toUsd(amount, version.currency, rateOf(rates, version.currency)),
      versionId: version.id,
      versionNo: version.versionNo,
      effectiveFrom: version.effectiveFrom,
      source: version.source,
    }
    parts[component] = part
  }
  return parts
}

export function rowOf(input: { sku: string; title: string | null; asin: string | null; versions: readonly CostLite[]; summary: SkuSummary; rates: RateMap; today: string }): CostRow {
  const parts = partsOf(input.versions, input.rates, input.today)
  const landed = landedOf(parts)
  return {
    sku: input.sku,
    title: input.title,
    asin: input.asin,
    parts,
    landedUsd: landed.usd,
    landedState: landed.state,
    coverage: coverageOf({ productEffectiveFrom: input.summary.productEffectiveFrom, hasDraft: input.summary.draftCount > 0, today: input.today }),
    productEffectiveFrom: input.summary.productEffectiveFrom,
    activeCount: input.summary.activeCount,
    draftCount: input.summary.draftCount,
    lastChangedAt: input.summary.lastChangedAt ? input.summary.lastChangedAt.toISOString() : null,
  }
}
