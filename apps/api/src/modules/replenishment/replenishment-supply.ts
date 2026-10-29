import { INBOUND_KIND_LABEL, INBOUND_KINDS, type InboundKind, type ReplenishPolicy } from '@nova/api-contracts'
import type { ModeLead } from './replenishment-math'

// 供给按“是否在主提前期内到仓”拆开（P6-09，14 章任务 1 与 2；16 章第 4 节）。
//
// 现状核实（P2a-07 的 8 步计算链）：第 2 步原来把“可售 + 策略计入的在途”整体当作供给，不区分到货时间，所以一批要很久才到的在途也会抵掉缺口。
// 现在拆成两部分：
//   - 提前期内：可售（已经在仓里）加上预计在主提前期内到仓的在途，只有这部分参与建议量计算；
//   - 提前期外：预计到仓时间晚于主提前期的在途，单独列出，不参与建议量（它到的时候新下的单也到了，两者会叠在一起）。
//
// 在途没有逐货件的预计到仓日（货件表没有这一列），所以按状态估算一个“最晚到仓天数”（取策略里最慢的运输方式，偏保守）：
//   接收中：入仓接收天数；已发货（在途）：最慢头程 + 入仓接收；处理中（还没发出）：国内运输 + 最慢头程 + 入仓接收。
// 没有设置运输选项（只有总提前期）时无法估算，计入的在途一律按提前期内处理，并在说明里写明。

export interface SupplyPart {
  kind: 'SELLABLE' | InboundKind
  label: string
  qty: number
  /** 预计多少天后可售（可售为 0）；没有运输选项无法估算时为 null。 */
  offsetDays: number | null
  inLead: boolean
}

export interface SupplySplit {
  parts: SupplyPart[]
  inLeadQty: number
  beyondQty: number
  /** 最快运输方式的提前期（没有运输选项取策略总提前期）。 */
  fastestLead: number
  /** 截至第 days 天（含）已经可售的供给量：可售加上预计在这之前到仓的计入在途。 */
  availableBy(days: number): number
  note: string
}

export function splitSupply(args: { policy: ReplenishPolicy; leads: readonly ModeLead[]; split: boolean; refDays: number; sellable: number; inbound: Record<InboundKind, number> }): SupplySplit {
  const { policy, leads, split, refDays, sellable, inbound } = args
  const slowest = split ? Math.max(...policy.transportOptions.map(option => option.transitDays)) : null
  const receiving = policy.receivingDays ?? 0
  const domestic = policy.domesticDays ?? 0
  const offsetOf = (kind: InboundKind): number | null => {
    if (slowest === null) return null
    if (kind === 'RECEIVING') return receiving
    return kind === 'SHIPPED' ? slowest + receiving : domestic + slowest + receiving
  }
  const parts: SupplyPart[] = [{ kind: 'SELLABLE', label: '可售', qty: sellable, offsetDays: 0, inLead: true }]
  for (const kind of INBOUND_KINDS) {
    if (!policy.inboundCounted.includes(kind) || inbound[kind] <= 0) continue
    const offset = offsetOf(kind)
    parts.push({ kind, label: `${INBOUND_KIND_LABEL[kind]}的在途`, qty: inbound[kind], offsetDays: offset, inLead: offset === null || offset <= refDays })
  }
  const sum = (items: readonly SupplyPart[]) => items.reduce((total, part) => total + part.qty, 0)
  return {
    parts,
    inLeadQty: sum(parts.filter(part => part.inLead)),
    beyondQty: sum(parts.filter(part => !part.inLead)),
    fastestLead: leads.length ? Math.min(...leads.map(lead => lead.leadDays)) : policy.leadTimeDays,
    availableBy: days => sum(parts.filter(part => part.offsetDays === null || part.offsetDays <= days)),
    note:
      slowest === null
        ? '没有设置运输选项，无法估算在途的到仓时间，计入的在途一律按提前期内处理。'
        : `在途按状态估算最晚到仓天数（最慢头程 ${slowest} 天，接收 ${receiving} 天，国内运输 ${domestic} 天），偏保守；货件没有预计到仓日，没有逐货件核对。`,
  }
}

/**
 * 必断货量：即使今天下单并走最快的运输方式，到仓前仍然补不上的需求。
 * = max（0，到最快提前期为止的需求 − 这段时间内已经可售的供给）；需求用逐日日销累加（人工预测规则会改变其中几天）。
 */
export function unavoidableShortage(args: { fastestLead: number; demandOver: (days: number) => number; supply: SupplySplit }): number {
  const need = args.demandOver(args.fastestLead) - args.supply.availableBy(args.fastestLead)
  return need > 1e-6 ? Math.ceil(need - 1e-6) : 0
}
