import {
  BRIDGE_COLUMN,
  PROFIT_CURRENCY,
  PROFIT_FLAG_KEYS,
  STORE_LEVEL_SKU,
  bridgeTargetOfLine,
  computeProfit,
  emptyAmounts,
  lineValue,
  round6,
  type AllocationBasis,
  type InventoryCosting,
  type ProfitAmounts,
  type ProfitBasis,
  type DictionaryResolution,
  type ProfitFlag,
} from '@nova/api-contracts'
import { allocateAds } from './ads-allocation'
import { consumeStream, type CostPiece, type DayCost } from './costing'
import { buildEstimateLines, type EstimateInputs } from './estimated-fees'
import { createFeeAllocator, type AllocationInput } from './fee-allocation'
import type { AdsAttribution, AdsInfo, DayRange, FeeRow, FxLookup, SalesRow, SkuStreams } from './types'

// 利润日表的行装配（P2b-09）：把某个收入确认口径下的销售、费用明细、成本批次、汇率、广告花费合成店铺 × SKU × 日的行。纯函数，不碰数据库。
// 取舍都写在契约 PROFIT_FLAGS 的标记里：成本不全就不给利润、汇率缺失不折算、没数据来源的项保持为空。

export interface ProfitRow extends ProfitAmounts {
  sellerAccountId: string
  sku: string
  asin: string | null
  profitDate: string
  basis: ProfitBasis
  costing: InventoryCosting
  currency: string
  profit: number | null
  costCoverage: number | null
  costCurrency: string | null
  productCostOriginal: number | null
  firstMileCostOriginal: number | null
  fxRate: number | null
  fxSource: string | null
  fxFallback: boolean
  /** 按利润项目字典拆开的、对净利润的带符号贡献（P6-18）；键是项目编号或 `~:目标`；没有字典或这一行没有交易明细为 null。 */
  itemAmounts: Record<string, number> | null
  /** 这一行里估算（预估与自定义费用，P6-20）计入的花费合计，已包含在各费用列里；没有估算为 null。 */
  estimatedFee?: number | null
  flags: ProfitFlag[]
}

export interface AssembleInput {
  basis: ProfitBasis
  costing: InventoryCosting
  costingValid: boolean
  range: DayRange
  /** 企业时区的今天（YYYY-MM-DD），月末加权平均用它判断“暂估”。 */
  today: string
  sales: readonly SalesRow[]
  fees: readonly FeeRow[]
  streams: ReadonlyMap<string, SkuStreams>
  draftOnly: ReadonlySet<string>
  fx: FxLookup
  ads: ReadonlyMap<string, AdsInfo>
  /** 广告商品报表归属与 ASIN → SKU 对照；不给就没有按 ASIN 的归属，全部花费按规则分摊。 */
  attribution?: AdsAttribution
  /** 某一天适用的广告分摊规则；不给就按销售额。 */
  adsBasis?: (day: string) => AllocationBasis
  /** 利润项目字典的解析器（P6-18）；不给就按内置口径归类，也不写按项目拆分的金额。 */
  dictionary?: ((category: string, subtype: string | null | undefined) => DictionaryResolution) | null
  /** 店铺级费用分摊规则与外部权重（P6-19）；不给就不分摊，店铺级费用留在店铺级行。需要字典（按项目匹配规则）。 */
  allocation?: AllocationInput
  /** 预估与自定义费用的规则与冲销依据（P6-20）；不给就没有估算。 */
  estimates?: EstimateInputs
}

interface Acc {
  sellerAccountId: string
  sku: string
  day: string
  asin: string | null
  amounts: ProfitAmounts
  flags: Set<ProfitFlag>
  items: Map<string, number>
  feeLines: number
  estimated: number
  extra: Pick<ProfitRow, 'costCurrency' | 'productCostOriginal' | 'firstMileCostOriginal' | 'fxRate' | 'fxSource' | 'fxFallback'>
}

const RELEASED = new Set(['RELEASED', 'DEFERRED_RELEASED'])

interface Converted {
  usd: number
  original: Map<string, number>
  missing: number
  fallback: boolean
  sources: Set<string>
}
function convert(pieces: readonly CostPiece[], day: string, fx: FxLookup): Converted {
  const out: Converted = { usd: 0, original: new Map(), missing: 0, fallback: false, sources: new Set() }
  for (const piece of pieces) {
    const rate = fx(piece.currency, day)
    if (!rate) {
      out.missing += piece.qty
      continue
    }
    const original = piece.qty * piece.unitCost
    out.usd += original / rate.rate
    out.original.set(piece.currency, (out.original.get(piece.currency) ?? 0) + original)
    out.fallback = out.fallback || rate.carriedForward
    out.sources.add(rate.source)
  }
  return out
}
const emptyDay = (units: number): DayCost => ({ pieces: [], uncovered: units, exhausted: false, provisional: false, mixedCurrency: false })

export function assembleProfit(input: AssembleInput): ProfitRow[] {
  const { basis, range } = input
  const inRange = (day: string) => day >= range.from && day <= range.to
  const accs = new Map<string, Acc>()
  const slot = (sellerAccountId: string, sku: string, day: string): Acc => {
    const key = `${sellerAccountId}|${sku || STORE_LEVEL_SKU}|${day}`
    let acc = accs.get(key)
    if (!acc) {
      acc = {
        sellerAccountId,
        sku: sku || STORE_LEVEL_SKU,
        day,
        asin: null,
        amounts: emptyAmounts(),
        flags: new Set(),
        items: new Map(),
        feeLines: 0,
        estimated: 0,
        extra: { costCurrency: null, productCostOriginal: null, firstMileCostOriginal: null, fxRate: null, fxSource: null, fxFallback: false },
      }
      accs.set(key, acc)
    }
    return acc
  }

  // 1. 销售：件数与销售额；全部历史日期的件数按 SKU 留下，成本批次的消耗要从最早的入库接上
  const unitsBySku = new Map<string, Map<string, number>>()
  for (const row of input.sales) {
    if (row.currency !== PROFIT_CURRENCY) {
      if (inRange(row.day)) slot(row.sellerAccountId, '', row.day).flags.add('NON_USD_EXCLUDED')
      continue
    }
    if (row.sku) {
      const days = unitsBySku.get(row.sku) ?? new Map<string, number>()
      days.set(row.day, (days.get(row.day) ?? 0) + row.units)
      unitsBySku.set(row.sku, days)
    }
    if (!inRange(row.day)) continue
    const acc = slot(row.sellerAccountId, row.sku, row.day)
    acc.amounts.units += row.units
    acc.amounts.revenue += row.revenue
    acc.asin ??= row.asin
    if (!row.sku) acc.flags.add('SKU_UNKNOWN')
  }

  // 2. 费用明细：归到利润桥项目
  const allocate = input.allocation && input.allocation.rules.length > 0 ? createFeeAllocator(input.allocation, input.sales) : null
  for (const line of input.fees) {
    if (!inRange(line.day)) continue
    if (line.currency !== PROFIT_CURRENCY) {
      slot(line.sellerAccountId, '', line.day).flags.add('NON_USD_EXCLUDED')
      continue
    }
    const resolved = input.dictionary?.(line.category, line.subtype)
    const target = resolved?.target ?? bridgeTargetOfLine({ category: line.category, subtype: line.subtype })
    if (target === 'EXCLUDED') continue
    if (target === 'REVENUE' && basis !== 'SETTLED') continue // 销售额来自订单，费用明细里的销售额不能再算一遍
    if (basis === 'SETTLED' && line.status !== null && !RELEASED.has(line.status)) {
      slot(line.sellerAccountId, '', line.day).flags.add('DEFERRED_EXCLUDED')
      continue
    }
    // 店铺级费用（没有 SKU）：企业配了分摊规则就按规则拆到 SKU（P6-19），拆不出去（没有规则或当月没有权重）留在店铺级行
    if (line.sku === '' && resolved?.mapped && allocate) {
      const result = allocate(line.sellerAccountId, line.day, resolved.itemKey, line.amount)
      if (result) {
        const allocatedColumn = BRIDGE_COLUMN[target] as keyof ProfitAmounts
        for (const part of result.parts) {
          const share = slot(line.sellerAccountId, part.key, line.day)
          ;(share.amounts as unknown as Record<string, number>)[allocatedColumn] += lineValue(target, part.amount)
          share.items.set(resolved.itemKey, (share.items.get(resolved.itemKey) ?? 0) + part.amount)
        }
        continue
      }
    }
    const acc = slot(line.sellerAccountId, line.sku, line.day)
    const column = BRIDGE_COLUMN[target] as keyof ProfitAmounts
    ;(acc.amounts as unknown as Record<string, number>)[column] += lineValue(target, line.amount)
    // 明细金额本身就是对净利润的带符号贡献（费用为负、收入为正），按项目累加
    if (resolved) acc.items.set(resolved.itemKey, (acc.items.get(resolved.itemKey) ?? 0) + line.amount)
    if (target !== 'REVENUE') acc.feeLines += line.lines
    if (line.mode === 'UNLINKED') acc.flags.add('FEES_UNLINKED_ORDER')
    acc.asin ??= line.asin
  }

  // 2b. 预估与自定义费用（P6-20）：按规则生成估算费用行，与实际费用走同一条路径；对应期间已有实际费用的规则在生成时就被冲销
  if (input.estimates && input.estimates.rules.length > 0) {
    const revenue = [...accs.values()].filter(acc => acc.amounts.revenue > 0).map(acc => ({ sellerAccountId: acc.sellerAccountId, sku: acc.sku, day: acc.day, revenue: acc.amounts.revenue }))
    const pairs = [...new Set(input.sales.filter(row => row.sku && row.currency === PROFIT_CURRENCY).map(row => `${row.sellerAccountId}\u0000${row.sku}`))].map(key => {
      const [sellerAccountId, sku] = key.split('\u0000') as [string, string]
      return { sellerAccountId, sku }
    })
    for (const line of buildEstimateLines({ estimates: input.estimates, range, today: input.today, revenue, pairs })) {
      if (line.target === 'EXCLUDED') continue
      const column = BRIDGE_COLUMN[line.target] as keyof ProfitAmounts
      const result = line.sku === '' && allocate ? allocate(line.sellerAccountId, line.day, line.itemKey, -line.amount) : null
      const parts = result ? result.parts.map(part => ({ sku: part.key, amount: -part.amount })) : [{ sku: line.sku, amount: line.amount }]
      for (const part of parts) {
        const acc = slot(line.sellerAccountId, part.sku, line.day)
        ;(acc.amounts as unknown as Record<string, number>)[column] += part.amount
        acc.items.set(line.itemKey, (acc.items.get(line.itemKey) ?? 0) - part.amount)
        acc.estimated += part.amount
        acc.flags.add('ESTIMATE_INCLUDED')
      }
    }
  }

  // 3. 成本：按存货计价逐日消耗批次，再按当天汇率折成美元
  const cache = new Map<string, { product: Map<string, DayCost>; firstMile: Map<string, DayCost>; other: Map<string, DayCost>; duty: Map<string, DayCost> }>()
  const costsOf = (sku: string) => {
    let costs = cache.get(sku)
    if (!costs) {
      const streams = input.streams.get(sku)
      const units = unitsBySku.get(sku) ?? new Map<string, number>()
      const run = (layers: SkuStreams['product'] | undefined) => (layers && layers.length > 0 ? consumeStream(input.costing, layers, units, input.today) : new Map<string, DayCost>())
      costs = { product: run(streams?.product), firstMile: run(streams?.firstMile), other: run(streams?.other), duty: run(streams?.duty) }
      cache.set(sku, costs)
    }
    return costs
  }
  for (const acc of [...accs.values()]) {
    const units = acc.amounts.units
    if (units <= 0 || acc.sku === STORE_LEVEL_SKU) continue
    const streams = input.streams.get(acc.sku)
    const total = unitsBySku.get(acc.sku)?.get(acc.day) ?? units
    const share = total > 0 ? Math.min(1, units / total) : 1
    if (!streams || streams.product.length === 0) {
      acc.flags.add(input.draftOnly.has(acc.sku) ? 'COST_DRAFT_ONLY' : 'COST_MISSING')
      continue
    }
    const costs = costsOf(acc.sku)
    const day = costs.product.get(acc.day) ?? emptyDay(total)
    const product = convert(day.pieces, acc.day, input.fx)
    const covered = Math.max(0, total - day.uncovered - Math.round(product.missing))
    acc.amounts.costedUnits = Math.min(units, Math.round(covered * share))
    if (acc.amounts.costedUnits >= units) acc.amounts.productCost = round6(product.usd * share)
    else {
      if (day.uncovered > 0) acc.flags.add(day.exhausted ? 'COST_LAYERS_EXHAUSTED' : 'COST_MISSING')
      if (product.missing > 0) acc.flags.add('FX_MISSING')
    }
    if (day.provisional && acc.amounts.costedUnits > 0) acc.flags.add('COST_PROVISIONAL')
    if (day.mixedCurrency) acc.flags.add('COST_MIXED_CURRENCY')
    if (product.fallback) acc.flags.add('FX_FALLBACK')
    const currencies = [...product.original.keys()]
    if (currencies.length === 1) {
      const currency = currencies[0] as string
      const original = product.original.get(currency) as number
      acc.extra.costCurrency = currency
      acc.extra.productCostOriginal = round6(original * share)
      acc.extra.fxRate = currency === PROFIT_CURRENCY ? 1 : product.usd > 0 ? Math.round((original / product.usd) * 1e8) / 1e8 : null
    } else if (currencies.length > 1) acc.extra.costCurrency = 'MIXED'
    acc.extra.fxSource = product.sources.size === 1 ? ([...product.sources][0] as string) : product.sources.size > 1 ? 'MIXED' : null
    acc.extra.fxFallback = product.fallback

    const firstMileDay = costs.firstMile.get(acc.day)
    if (streams.firstMile.length > 0 && firstMileDay) {
      const first = convert(firstMileDay.pieces, acc.day, input.fx)
      acc.amounts.firstMileCost = round6(first.usd * share)
      if (firstMileDay.uncovered > 0 || first.missing > 0) acc.flags.add('FIRST_MILE_MISSING')
      if (first.fallback) acc.flags.add('FX_FALLBACK')
      if (first.original.size === 1) acc.extra.firstMileCostOriginal = round6([...first.original.values()][0]! * share)
      if (first.missing > 0) acc.flags.add('FX_MISSING')
    } else acc.flags.add('FIRST_MILE_MISSING')
    const dutyDay = costs.duty.get(acc.day)
    if ((streams.duty?.length ?? 0) > 0 && dutyDay) acc.amounts.dutyCost = round6(convert(dutyDay.pieces, acc.day, input.fx).usd * share)
    const otherDay = costs.other.get(acc.day)
    if (streams.other.length > 0 && otherDay) acc.amounts.otherCost = round6(convert(otherDay.pieces, acc.day, input.fx).usd * share)
  }

  // 4. 广告：有花费记录的日期范围内，先按广告商品报表归属到 ASIN，剩余的按规则分摊到当天有销售的 SKU（P3-16）；
  //    分不出去的留在店铺级行的“未分摊”。每个有业务的日子都有一行店铺级行，让页面能看到“广告是否接入”。
  const storeDays = new Set<string>()
  for (const acc of accs.values()) storeDays.add(`${acc.sellerAccountId}|${acc.day}`)
  for (const [store, info] of input.ads) for (const day of info.byDay.keys()) if (inRange(day)) storeDays.add(`${store}|${day}`)
  const skuAccs = new Map<string, Acc[]>()
  for (const acc of accs.values()) if (acc.sku !== STORE_LEVEL_SKU) skuAccs.set(`${acc.sellerAccountId}|${acc.day}`, [...(skuAccs.get(`${acc.sellerAccountId}|${acc.day}`) ?? []), acc])
  for (const key of storeDays) {
    const [store, day] = key.split('|') as [string, string]
    const acc = slot(store, '', day)
    const info = input.ads.get(store)
    if (info?.first && info.last && day >= info.first && day <= info.last) {
      const result = allocateAds({
        total: info.byDay.get(day) ?? 0,
        basis: input.adsBasis?.(day) ?? 'BY_SALES',
        direct: input.attribution?.direct.get(store)?.get(day) ?? new Map<string, number>(),
        rows: (skuAccs.get(key) ?? []).map(sku => ({ sku: sku.sku, asin: sku.asin, revenue: sku.amounts.revenue, units: sku.amounts.units })),
        asinSkus: input.attribution?.asinSkus.get(store) ?? new Map<string, string[]>(),
      })
      for (const sku of skuAccs.get(key) ?? []) sku.amounts.adsSpendAllocated = round6(result.bySku.get(sku.sku) ?? 0)
      for (const [sku, asin] of result.addedAsins) {
        const added = slot(store, sku, day)
        added.asin ??= asin
        added.amounts.adsSpendAllocated = round6(result.bySku.get(sku) ?? 0)
      }
      acc.amounts.adsUnallocated = round6(result.unallocated)
      if (result.unallocated > 0) acc.flags.add('ADS_UNALLOCATED')
      if (result.exceeded) acc.flags.add('ADS_ATTRIBUTION_EXCEEDS')
      if (result.unmapped > 0) acc.flags.add('ADS_ASIN_UNMAPPED')
    } else acc.flags.add('ADS_NOT_CONNECTED')
    if (info?.nonUsd) acc.flags.add('NON_USD_EXCLUDED')
    if (!input.costingValid) acc.flags.add('COSTING_INVALID')
  }

  // 5. 收尾：费用未入账标记、利润、成本覆盖率、取整、去掉空行
  const rows: ProfitRow[] = []
  for (const acc of accs.values()) {
    const a = acc.amounts
    if (acc.sku !== STORE_LEVEL_SKU && a.revenue > 0 && acc.feeLines === 0) acc.flags.add('FEES_PENDING')
    const record = a as unknown as Record<string, number | null>
    for (const key of Object.keys(record)) if (typeof record[key] === 'number' && key !== 'units' && key !== 'costedUnits') record[key] = round6(record[key] as number)
    const empty =
      a.units === 0 &&
      a.revenue === 0 &&
      a.refunds === 0 &&
      a.reimbursement === 0 &&
      a.promotion === 0 &&
      a.adsUnallocated === null &&
      (a.adsSpendAllocated ?? 0) === 0 &&
      a.feeCommission === 0 &&
      a.feeFulfillment === 0 &&
      a.feeStorage === 0 &&
      a.feeAged === 0 &&
      a.feeInbound === 0 &&
      a.feeOther === 0
    if (empty && acc.flags.size === 0) continue
    rows.push({
      ...a,
      itemAmounts: acc.items.size > 0 ? Object.fromEntries([...acc.items].map(([key, value]) => [key, round6(value)])) : null,
      ...(acc.estimated > 0 ? { estimatedFee: round6(acc.estimated) } : {}),
      sellerAccountId: acc.sellerAccountId,
      sku: acc.sku,
      asin: acc.asin,
      profitDate: acc.day,
      basis,
      costing: input.costing,
      currency: PROFIT_CURRENCY,
      profit: computeProfit(a),
      costCoverage: a.units > 0 ? round6(a.costedUnits / a.units) : null,
      ...acc.extra,
      flags: PROFIT_FLAG_KEYS.filter(flag => acc.flags.has(flag)),
    })
  }
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
  return rows.sort((x, y) => order(x.profitDate, y.profitDate) || order(x.sellerAccountId, y.sellerAccountId) || order(x.sku, y.sku))
}
