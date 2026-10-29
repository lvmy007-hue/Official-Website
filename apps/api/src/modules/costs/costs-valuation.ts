import {
  COST_COMPONENTS,
  COST_COMPONENT_LABEL,
  FX_BASE_CURRENCY,
  INVENTORY_COSTING_LABEL,
  INVENTORY_COSTING_SETTING,
  estimateInventory,
  normalizeCosting,
  toUsd,
  type CostComponent,
  type CostComposition,
  type CostFxInfo,
  type CostLite,
  type CostParts,
  type CostValuation,
  type StockLayer,
} from '@nova/api-contracts'
import { storeWhere, type ResolvedScope } from '../auth'
import { dateText } from '../overview'
import type { Db } from './costs-common'
import { rateOf, type RateMap } from './costs-fx'

// 详情页的两块派生数据（P2b-14）：成本构成（各项折合美元的占比）与库存成本估算（按企业设置的计价方法）。

export function compositionOf(parts: CostParts): CostComposition {
  const present = COST_COMPONENTS.filter(component => parts[component] !== null)
  const slices = present.flatMap(component => {
    const usd = parts[component]?.usd ?? null
    return usd !== null && usd > 0 ? [{ component, label: COST_COMPONENT_LABEL[component], usd }] : []
  })
  const missing = present.filter(component => parts[component]?.usd === null).map(component => COST_COMPONENT_LABEL[component])
  const complete = present.length > 0 && missing.length === 0
  return {
    slices,
    totalUsd: complete ? Math.round(slices.reduce((sum, slice) => sum + slice.usd, 0) * 1_000_000) / 1_000_000 : null,
    note: present.length === 0 ? '没有生效的成本，画不出构成' : missing.length > 0 ? `${missing.join('、')}缺少汇率，没有折合美元，构成图未包含` : slices.length === 0 ? '各项成本都是 0' : null,
  }
}

export function fxOf(rates: RateMap, parts: CostParts): CostFxInfo[] {
  const codes = [...new Set(COST_COMPONENTS.flatMap(component => (parts[component] ? [parts[component].currency] : [])))].filter(code => code !== FX_BASE_CURRENCY)
  return codes.map(code => rates.get(code) ?? { currency: code, rate: null, rateDate: null, carriedForward: false })
}

/** 各店铺最近一次库存规划报告里这个 SKU 的可售数量之和；没有任何报告为 null。 */
export async function onHandUnits(prisma: Db, tenantId: string, scope: ResolvedScope, sku: string): Promise<number | null> {
  const rows = await prisma.inventoryPlanningSnapshot.findMany({
    where: { tenantId, sku, available: { not: null }, ...storeWhere(scope) },
    select: { sellerAccountId: true, snapshotDate: true, available: true },
    orderBy: { snapshotDate: 'desc' },
    take: 2000,
  })
  if (rows.length === 0) return null
  const latest = new Map<string, string>()
  for (const row of rows) if (!latest.has(row.sellerAccountId)) latest.set(row.sellerAccountId, dateText(row.snapshotDate))
  return rows.filter(row => latest.get(row.sellerAccountId) === dateText(row.snapshotDate)).reduce((sum, row) => sum + (row.available ?? 0), 0)
}

export async function valuationOf(prisma: Db, input: { tenantId: string; scope: ResolvedScope; sku: string; actives: readonly CostLite[]; rates: RateMap; today: string }): Promise<CostValuation> {
  const setting = await prisma.tenantSetting.findFirst({ where: { tenantId: input.tenantId, sellerAccountId: null, key: INVENTORY_COSTING_SETTING }, select: { valueJson: true } })
  const { costing, valid } = normalizeCosting(setting?.valueJson)
  const base = { method: costing, methodLabel: INVENTORY_COSTING_LABEL[costing], methodValid: valid }
  const units = await onHandUnits(prisma, input.tenantId, input.scope, input.sku)
  if (units === null)
    return { ...base, state: 'NO_STOCK_DATA', onHandUnits: null, valueUsd: null, uncoveredUnits: 0, avgUnitUsd: null, note: '还没有库存规划报告，不知道现有库存件数，无法估算库存成本' }
  const streams: Record<CostComponent, StockLayer[]> = { product: [], firstMile: [], duty: [], other: [] }
  let noFx = false
  for (const version of input.actives) {
    for (const component of COST_COMPONENTS) {
      const amount = version[component]
      if (amount === null) continue
      const usd = toUsd(amount, version.currency, rateOf(input.rates, version.currency))
      if (usd === null) {
        noFx = true
        continue
      }
      streams[component].push({ date: version.effectiveFrom, qty: version.quantity, usd })
    }
  }
  const estimate = estimateInventory(costing, streams, units, input.today)
  const tail = noFx ? '；有版本缺汇率，没有计入' : ''
  if (estimate.valueUsd === null)
    return { ...base, state: 'NO_COST', onHandUnits: units, valueUsd: null, uncoveredUnits: units, avgUnitUsd: null, note: `没有可用的采购单价，不估算库存成本（只算头程与关税会低估）${tail}` }
  const uncovered = estimate.uncoveredUnits > 0 ? `；有 ${estimate.uncoveredUnits} 件没有对应的入库批次成本，未计入` : ''
  return {
    ...base,
    state: 'OK',
    onHandUnits: units,
    valueUsd: estimate.valueUsd,
    uncoveredUnits: estimate.uncoveredUnits,
    avgUnitUsd: estimate.avgUnitUsd,
    note: `估算值：现有件数取各店铺最近一次库存规划报告，按入库批次与价格版本折合美元，不是账面库存成本${uncovered}${tail}`,
  }
}
