import { asin360PriceLink, type Asin360UnitEconomics, type Asin360UnitLine, type ProfitBridgeView } from '@nova/api-contracts'

// ASIN 360“利润与成本”页签的纯计算：把一个商品的利润桥（金额合计）折成每件经济。
// 口径：每件 = 合计 ÷ 范围内销售件数；净利润沿用利润分析的整体口径（有一行缺成本就整体不给），所以缺成本时每件净利润也不给，不拿部分数字冒充。

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

export interface UnitInput {
  units: number
  revenue: number
  refunds: number
  feeCommission: number
  promotion: number
}

export function unitEconomicsOf(input: UnitInput, bridge: ProfitBridgeView): Asin360UnitEconomics {
  const { units, revenue } = input
  if (units <= 0) {
    return { state: 'NO_UNITS', note: '所选范围内这个商品没有销量，无法折算每件金额。', units, avgPrice: null, netPerUnit: null, proportionalShare: null, lines: [] }
  }
  const lines: Asin360UnitLine[] = bridge.items
    .filter(item => item.key !== 'NET_PROFIT' && item.direction !== 'RESULT')
    .map(item => ({
      key: item.key,
      label: item.label,
      direction: item.direction === 'INCOME' ? 'INCOME' : 'COST',
      perUnit: item.value === null ? null : round6(item.value / units),
      state: item.state,
      link: asin360PriceLink(item.key),
      contribution: item.contribution === null ? null : round6(item.contribution / units),
    }))
  const avgPrice = revenue > 0 ? round6(revenue / units) : null
  const netPerUnit = bridge.netProfit === null ? null : round6(bridge.netProfit / units)
  const base = { units, avgPrice, netPerUnit, lines }
  if (avgPrice === null) {
    return { ...base, state: 'INCOMPLETE', note: '范围内没有销售额，无法折算平均售价，价格模拟不可用。', proportionalShare: null }
  }
  const proportionalShare = round6((input.refunds + input.feeCommission + input.promotion) / revenue)
  if (netPerUnit === null) {
    return {
      ...base,
      state: 'INCOMPLETE',
      proportionalShare,
      note: `有 ${bridge.incompleteRows} 行因缺少成本算不出净利润，每件净利润不给，价格模拟不可用；商品成本生效后（商品成本页）补全。`,
    }
  }
  return { ...base, state: 'OK', note: null, proportionalShare }
}
