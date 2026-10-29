import {
  INBOUND_KIND_LABEL,
  type AmazonReplenishment,
  type InboundKind,
  type InventoryAction,
  type InventoryAssessment,
  type InventoryDemand,
  type InventoryDispositionResponse,
  type InventoryPolicy,
  type InventorySuggestion,
  POLICY_NOT_CONFIGURED_NOTE,
} from '@nova/api-contracts'
import { plusDays } from './inventory-rules'

// 建议动作、补货估算、处置建议（06 章 6.1）。纯函数；所有“预计”类数字都带公式并标为模型估算。

export interface ActionInput {
  risk: InventoryAssessment['risk']
  strandedQty: number | null
  strandedReason: string | null
  agingAtRisk: boolean | null
  unsellable: number
  researching: number
}

export function ourAction(input: ActionInput): InventoryAction | null {
  if (input.risk === 'HIGH') return 'REPLENISH_URGENT'
  if (input.risk === 'MEDIUM') return 'REPLENISH'
  if ((input.strandedQty ?? 0) > 0 || Boolean(input.strandedReason)) return 'FIX_STRANDED'
  if (input.agingAtRisk) return 'CLEAR_AGED'
  if (input.risk === 'EXCESS') return 'REDUCE_EXCESS'
  if (input.unsellable > 0 || input.researching > 0) return 'CHECK_UNSELLABLE'
  return null
}

const fixed = (value: number, digits = 1) => (Math.round(value * 10 ** digits) / 10 ** digits).toString()

export interface DiffInput {
  oursQty: number | null
  amazon: AmazonReplenishment
  /** 亚马逊口径近 30 天销量（补货建议报告或规划报告）。 */
  amazonUnits30: number | null
  demand: InventoryDemand
  policy: InventoryPolicy | null
  inbound: { working: number; shipped: number; receiving: number }
}

/** 我方估算与亚马逊建议量的差异原因：只列出确实能从数据里核对出来的原因。 */
export function diffReasons(input: DiffInput): string[] {
  const { amazon, policy } = input
  if (amazon.recommendedQty === null) return amazon.state === 'OK' ? [] : ['亚马逊尚无补货建议，无法对比']
  if (input.oursQty === null || !policy) return []
  if (input.oursQty === amazon.recommendedQty) return []
  const reasons: string[] = []
  if (input.demand.mid !== null && input.amazonUnits30 !== null) {
    const theirs = input.amazonUnits30 / 30
    const base = Math.max(input.demand.mid, theirs)
    if (base > 0 && Math.abs(input.demand.mid - theirs) / base > 0.1) {
      reasons.push(`预测日销不同：我方 ${fixed(input.demand.mid, 2)} 件/天（${input.demand.source === 'ORDERS' ? '订单汇总' : '亚马逊报告'}），亚马逊口径近 30 天日均 ${fixed(theirs, 2)} 件/天`)
    }
  }
  const skipped = (['WORKING', 'SHIPPED', 'RECEIVING'] as InboundKind[]).filter(
    kind => !policy.inboundCounted.includes(kind) && input.inbound[kind.toLowerCase() as 'working' | 'shipped' | 'receiving'] > 0,
  )
  if (skipped.length) {
    const detail = skipped.map(kind => `${INBOUND_KIND_LABEL[kind]} ${input.inbound[kind.toLowerCase() as 'working' | 'shipped' | 'receiving']} 件`).join('、')
    reasons.push(`在途口径不同：我方策略不计入 ${detail}，亚马逊补货建议按全部在途计算`)
  }
  reasons.push(`目标天数不同：我方目标覆盖 ${policy.coverageDays} 天（策略版本 ${policy.versionNo}）；亚马逊按自己的目标天数与提前期计算，不对外公开`)
  return reasons
}

export interface DispositionInput {
  policy: InventoryPolicy | null
  assessment: InventoryAssessment
  agingAtRisk: boolean | null
  agedQty: number | null
  demandMid: number | null
  sellable: number | null
  inboundCounted: number
  nextMonthStorage: number | null
  ageSurcharge: number | null
}

export function ourDisposition(input: DispositionInput): InventoryDispositionResponse['ours'] {
  const base = { excessQty: null, estimatedSavings: null, formula: null }
  if (!input.policy) return { state: 'NOT_CONNECTED', action: null, ...base, note: POLICY_NOT_CONFIGURED_NOTE }
  const { assessment, sellable } = input
  if (assessment.risk === 'EXCESS' && sellable !== null) {
    const onHand = sellable + input.inboundCounted
    const target = (input.demandMid ?? 0) * input.policy.coverageDays
    const removable = Math.max(0, Math.min(sellable, Math.floor(onHand - target)))
    const perUnit = sellable > 0 && (input.nextMonthStorage !== null || input.ageSurcharge !== null) ? ((input.nextMonthStorage ?? 0) + (input.ageSurcharge ?? 0)) / sellable : null
    const savings = perUnit === null ? null : Math.round(removable * perUnit * 100) / 100
    return {
      state: 'OK',
      action: 'REDUCE_EXCESS',
      excessQty: removable,
      estimatedSavings: savings,
      formula:
        perUnit === null ? null : `${removable} 件 ×（下月仓储费 ${fixed(input.nextMonthStorage ?? 0, 2)} + 库龄附加费预估 ${fixed(input.ageSurcharge ?? 0, 2)}）÷ 可售 ${sellable} 件 = ${savings}`,
      note: '模型估算：只算仓储费与库龄附加费的节省，不含移除费用和降价让利；可移除量不超过可售数量',
    }
  }
  if (input.agingAtRisk) {
    return {
      state: 'OK',
      action: 'CLEAR_AGED',
      excessQty: input.agedQty,
      estimatedSavings: input.ageSurcharge,
      formula: input.ageSurcharge === null ? null : '库龄附加费预估（亚马逊规划报告，按月）',
      note: '高龄库存清理后可避免的库龄附加费，取亚马逊规划报告的预估，不含移除费用和降价让利',
    }
  }
  return { state: 'OK', action: null, ...base, note: '当前没有冗余或高龄库存需要处置' }
}

export interface SuggestionInput {
  assessment: InventoryAssessment
  demand: InventoryDemand
  sellable: number | null
  inboundCounted: number
  policy: InventoryPolicy | null
  action: InventoryAction | null
  strandedReason: string | null
  agedQty: number | null
  ageSurcharge: number | null
  today: string
}

export function suggestionsFor(input: SuggestionInput): InventorySuggestion[] {
  const { assessment: a, demand, policy } = input
  const out: InventorySuggestion[] = []
  const onHand = (input.sellable ?? 0) + input.inboundCounted
  if (policy && (a.risk === 'HIGH' || a.risk === 'MEDIUM') && demand.mid) {
    const span = (rate: number | null) => (rate && rate > 0 ? plusDays(input.today, Math.floor(onHand / rate)) : null)
    const early = span(demand.high)
    const late = span(demand.low)
    out.push({
      id: 'replenish',
      rule: a.risk === 'HIGH' ? '预计断货日早于最快补货到仓日' : '预计断货日落在安全库存覆盖范围内',
      evidence:
        `可售 ${input.sellable ?? 0} + 计入在途 ${input.inboundCounted}，预测日销 ${fixed(demand.mid, 2)} 件/天，` +
        `可售天数 ${a.daysOfCover ?? '—'}，预计断货日 ${a.stockoutDate ?? '—'}；最快补货到仓 ${a.fastestReplenishDate ?? '—'}` +
        `（提前期 ${a.fastestLeadDays} 天，安全库存 ${policy.safetyDays} 天，规则版本 ${policy.versionNo}）`,
      impact:
        early && late ? `按预测日销区间 ${fixed(demand.low ?? 0, 2)}–${fixed(demand.high ?? 0, 2)} 件/天，预计断货日在 ${early} 至 ${late} 之间（模型估算）` : '预测日销区间不足，无法给出断货日区间',
      risk: a.risk === 'HIGH' ? '补货到仓前将断货，断货期间损失销量与排名' : '补货稍有延误就会进入断货',
      action: input.action,
    })
  }
  if (policy && a.risk === 'EXCESS') {
    out.push({
      id: 'excess',
      rule: '库存覆盖天数超过目标覆盖天数 × 冗余倍数',
      evidence: a.noDemand ? `近期没有销量，库存 ${onHand} 件` : `可售天数 ${a.daysOfCover}，目标 ${policy.coverageDays} 天 × 冗余倍数 ${policy.redundancyMultiplier}（规则版本 ${policy.versionNo}）`,
      impact: '见“处置建议”页签的预计节省（模型估算）',
      risk: '占用仓储与资金，高龄后会产生库龄附加费',
      action: input.action,
    })
  }
  if ((input.agedQty ?? 0) > 0 || (input.ageSurcharge ?? 0) > 0) {
    out.push({
      id: 'aging',
      rule: `存在库龄 ${policy?.agingFromDays ?? 271} 天以上的库存`,
      evidence: `高龄库存 ${input.agedQty ?? '—'} 件，库龄附加费预估 ${input.ageSurcharge ?? '—'}（亚马逊库存规划报告）`,
      impact: '见“库龄与费用”页签的跨档时间线',
      risk: '继续持有会进入更高的库龄附加费档',
      action: 'CLEAR_AGED',
    })
  }
  if (input.strandedReason) {
    out.push({ id: 'stranded', rule: '商品处于滞留状态', evidence: `滞留原因：${input.strandedReason}`, impact: '滞留库存无法销售', risk: '长期滞留会占用仓储并影响销量', action: 'FIX_STRANDED' })
  }
  return out
}
