import type { CalcStep, InventoryDemand, ReplenishPolicy } from '@nova/api-contracts'
import { describeForecastOverride } from '@nova/api-contracts'
import type { DemandPlan } from './replenishment-override'
import type { AdjustedDemand } from './replenishment-math'
import type { SupplySplit } from './replenishment-supply'

// 计算链第 1、2 步的展示（P6-09 从引擎里拆出，引擎文件有行数上限）：纯展示，不做任何计算。

const fx = (value: number, digits = 1) => value.toFixed(digits)
const PENDING = '尚未接入'

/** 第 1 步 需求预测：写明用了哪条人工预测规则（没有规则时与以前完全一致）。 */
export function demandStep(args: { demand: InventoryDemand; adjusted: AdjustedDemand; plan: DemandPlan; horizon: number }): CalcStep {
  const { demand, adjusted, plan, horizon } = args
  const ruled = plan.applied.length > 0
  return {
    key: 'DEMAND',
    title: '1 需求预测',
    result: `日销 ${fx(plan.mid, 2)} 件/天（区间 ${fx(plan.low, 2)}–${fx(plan.high, 2)}）${plan.changedDays > 0 ? '，含人工预测规则' : ''}`,
    formula: '历史日销（已剔除断货日）→ 扣除上月订阅部分 → ×趋势系数 → +未来 30 天订阅出货日均；预测范围内有人工预测规则的日期，用规则日销取代，再求范围内的日均',
    details: [
      { label: '历史日销 低/中/高', value: `${fx(demand.low ?? 0, 2)} / ${fx(demand.mid ?? 0, 2)} / ${fx(demand.high ?? 0, 2)}（${demand.method}）` },
      { label: '剔除的断货日', value: `${demand.stockoutDaysExcluded} 天` },
      { label: '趋势系数', value: String(adjusted.trendFactor) },
      { label: '订阅省日均（未来 30 天预测）', value: adjusted.subscribe.subRate === null ? '未叠加' : fx(adjusted.subscribe.subRate, 2) },
      ...(ruled
        ? [
            { label: '模型日销（未叠加规则）', value: `${fx(adjusted.low, 2)} / ${fx(adjusted.mid, 2)} / ${fx(adjusted.high, 2)}` },
            {
              label: `预测范围（今天起 ${horizon} 天）内的规则`,
              value: plan.applied.map(rule => `${describeForecastOverride(rule)}${rule.applied ? `，取代 ${rule.days} 天` : '，未生效'}`).join('；'),
            },
          ]
        : []),
    ],
    notes: [...adjusted.notes, ...plan.notes, '季节性：规划报告只给是否季节性，没有系数，未做数值调整；促销日历尚未接入，未叠加促销。'],
  }
}

/** 第 2 步 供给：提前期内与提前期外分开列；其他供给来源没接入的写“尚未接入”。 */
export function supplyStep(args: {
  policy: ReplenishPolicy
  supply: SupplySplit
  sellable: number
  counted: number
  other: { awd: number | null; domestic: number | null; purchaseInTransit: number | null }
  refDays: number
}): CalcStep {
  const { policy, supply, sellable, counted, other, refDays } = args
  const text = (value: number | null) => (value === null ? PENDING : String(value))
  const inboundInLead = supply.inLeadQty - sellable
  const beyond = supply.parts.filter(part => !part.inLead)
  const offsetText = (offset: number | null) => (offset === null ? '' : `，预计 ${offset} 天内可售`)
  return {
    key: 'SUPPLY',
    title: '2 供给',
    result: `提前期内可用 ${supply.inLeadQty} 件（可售 ${sellable} + 提前期内到仓的在途 ${inboundInLead}）${supply.beyondQty > 0 ? `；提前期外 ${supply.beyondQty} 件不参与建议量` : ''}`,
    formula: '提前期内供给 = 可售 + 预计在主提前期内到仓的在途（参与建议量）；提前期外到仓的在途单列、不参与；上游仓储、国内仓、采购在途只减少采购量',
    details: [
      { label: '可售', value: String(sellable) },
      { label: `计入在途（${policy.inboundCounted.join('、') || '不计入'}）`, value: String(counted) },
      { label: `提前期内的在途（预计 ${refDays} 天内到仓，参与建议量）`, value: String(inboundInLead) },
      {
        label: `提前期外的在途（预计晚于 ${refDays} 天到仓，不参与建议量）`,
        value: beyond.length ? beyond.map(part => `${part.label} ${part.qty} 件${offsetText(part.offsetDays)}`).join('；') : '没有',
      },
      { label: '上游仓储（可用 + 在途入库，取最近一次快照）', value: other.awd === null ? '没有记录（店铺未开通或这个 SKU 不在上游仓储）' : String(other.awd) },
      { label: '国内仓可用', value: text(other.domestic) },
      { label: '采购在途', value: text(other.purchaseInTransit) },
    ],
    notes: [supply.note, '“尚未接入”的供给来源不按 0 算也不凭空估计：它们只会减少采购量，不影响补到亚马逊物流的建议量。'],
  }
}

/** 第 6 步里“必断货量”相关的两行与说明。 */
export function shortageDetails(args: { shortage: number; fastest: number; included: boolean; gap: number; counted: number }): { details: CalcStep['details']; note: string } {
  const { shortage, fastest, included, gap, counted } = args
  return {
    details: [
      {
        label: `必断货量（最快运输 ${fastest} 天也补不上）`,
        value: `${shortage} 件，${shortage === 0 ? '没有' : included ? '已计入建议量（策略开关“计入必断货量”已开）' : '默认不计入建议量（策略开关“计入必断货量”关闭）'}`,
      },
      { label: '计入建议量的缺口', value: `${fx(counted, 1)}（= max（0，${fx(gap, 1)} − ${included ? 0 : shortage}））` },
    ],
    note:
      shortage > 0 && !included
        ? '必断货量是下单后到仓之前无论如何都会卖不出去的需求：新货到仓时这部分需求已经过去，再补等于过度补货，所以默认扣除；想补回这部分请在补货策略里打开“计入必断货量”。'
        : shortage > 0
          ? '必断货量已计入建议量：新货到仓后会比不计入时多出这部分库存，请确认确实要补回。'
          : '',
  }
}
