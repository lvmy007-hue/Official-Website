import { TRANSPORT_LABEL, type CalcState, type CalcStep, type InventoryDemand, type ReplenishCalc, type ReplenishPolicy, type Shipment } from '@nova/api-contracts'
import { assess, countedInbound, daysBetween, plusDays } from '../inventory'
import { planDemand, type DemandPlan, type ResolvedOverride } from './replenishment-override'
import { asInventoryPolicy } from './replenishment-resolve'
import { adjustDemand, periodRates, round1, round2, roundUpTo, splitTransport, stddev, zScore, type AdjustedDemand, type ModeLead, type SubscribeInput } from './replenishment-math'
import { demandStep, shortageDetails, supplyStep } from './replenishment-steps'
import { splitSupply, unavoidableShortage } from './replenishment-supply'

// 补货建议计算链（06 章 6.2，8 步，每一步带公式与输入）。纯函数，不读数据库：输入由装配层准备好，同一份输入永远得到同一份结果。
// 1 需求预测 → 2 供给 → 3 提前期 → 4 安全库存 → 5 目标覆盖 → 6 建议量（箱规与起订量取整）→ 7 运输方式拆分 → 8 时间。
// 没有接入的输入（上游仓储库存、国内仓可用、采购在途、成本版本）一律是 null，在步骤里写“尚未接入”，不当 0 也不编造。
// P6-09：第 1 步可被人工预测规则取代（replenishment-override.ts）；第 2 步把供给拆成提前期内与提前期外，只有前者参与建议量（replenishment-supply.ts）；
// 第 6 步单列必断货量，策略开关“计入必断货量”关闭时不计入建议量。

export interface EngineInput {
  today: string
  policy: ReplenishPolicy | null
  quantity: { sellable: number | null; inboundWorking: number; inboundShipped: number; inboundReceiving: number }
  demand: InventoryDemand
  subscribe: SubscribeInput | null
  /** 其他供给来源：null 表示对应同步器或模块尚未上线（上游仓储 P2a-08、国内仓与采购在途 P2a-10）。 */
  supply: { awd: number | null; domestic: number | null; purchaseInTransit: number | null }
  /** 适用于这个 SKU 的人工预测规则（装配层已按 SKU 与品类筛好、算好日销）；不传表示没有规则。 */
  overrides?: readonly ResolvedOverride[]
}

const fx = (value: number, digits = 1) => value.toFixed(digits)
const PENDING = '尚未接入'
const DEFAULT_MODE = 'DEFAULT' as const

/** 从今天起算前 days 天的累计需求：逐日日销相加（人工预测规则期间的日销与模型不同，不能直接用“日销 × 天数”）。 */
const demandOver = (plan: DemandPlan, band: 'low' | 'mid' | 'high') => (days: number) => {
  let total = 0
  for (let offset = 0; offset < days; offset += 1) total += plan.rateAt(band, offset)
  return total
}

/** 有人工预测规则时，库存撑多少天要按逐日日销累加（规则期间日销不同）；上限 730 天，撑不到就当不会断货。 */
function coverByPlan(plan: DemandPlan, stock: number): number {
  if (stock <= 0) return 0
  let total = 0
  for (let offset = 0; offset < 730; offset += 1) {
    const rate = plan.rateAt('mid', offset)
    if (total + rate >= stock && rate > 0) return offset + (stock - total) / rate
    total += rate
  }
  return Number.POSITIVE_INFINITY
}

type Extras = Pick<ReplenishCalc, 'supplyInLeadTime' | 'supplyBeyondLeadTime' | 'unavoidableShortage' | 'unavoidableIncluded' | 'appliedOverride'>
const NO_EXTRAS: Extras = { supplyInLeadTime: null, supplyBeyondLeadTime: null, unavoidableShortage: null, unavoidableIncluded: false, appliedOverride: [] }

function empty(state: CalcState, reason: string, policy: ReplenishPolicy | null): ReplenishCalc {
  return {
    ...NO_EXTRAS,
    state,
    reason,
    risk: null,
    daysOfCover: null,
    stockoutDate: null,
    rawQty: null,
    recommendedQty: 0,
    purchaseQty: 0,
    qtyLow: null,
    qtyHigh: null,
    orderDate: null,
    shipDate: null,
    arriveDate: null,
    shipments: [],
    landedCost: null,
    confidence: 0,
    policyVersion: policy?.versionNo ?? null,
    policyLevel: policy?.level ?? null,
    dailyDemand: null,
    subscribeUsed: false,
    steps: [],
  }
}

/** 提前期（按运输方式）：生产 + 国内运输 + 头程 + 入仓接收；没有运输选项时用策略的总提前期，不拆分。 */
export function modeLeads(policy: ReplenishPolicy): { leads: ModeLead[]; split: boolean } | null {
  if (policy.transportOptions.length === 0) return { leads: [], split: false }
  if (policy.productionDays === null || policy.domesticDays === null || policy.receivingDays === null) return null
  const base = policy.productionDays + policy.domesticDays + policy.receivingDays
  return { leads: policy.transportOptions.map(option => ({ mode: option.mode, leadDays: base + option.transitDays, unitCost: option.unitCost })), split: true }
}

/** 计算安全库存与目标用的“主提前期”：固定偏好用该方式；自动时成本都已设置取成本最低的，否则取最快的。 */
function referenceLead(policy: ReplenishPolicy, leads: readonly ModeLead[]): { days: number; label: string } {
  if (leads.length === 0) return { days: policy.leadTimeDays, label: '策略总提前期' }
  const fastest = [...leads].sort((a, b) => a.leadDays - b.leadDays)[0]
  const preferred = policy.transportPreference && policy.transportPreference !== 'AUTO' ? leads.find(lead => lead.mode === policy.transportPreference) : undefined
  if (preferred) return { days: preferred.leadDays, label: `${TRANSPORT_LABEL[preferred.mode]}（策略偏好）` }
  if (leads.every(lead => lead.unitCost !== null)) {
    const cheapest = [...leads].sort((a, b) => (a.unitCost as number) - (b.unitCost as number) || a.leadDays - b.leadDays)[0]
    return { days: cheapest.leadDays, label: `${TRANSPORT_LABEL[cheapest.mode]}（成本最低）` }
  }
  return { days: fastest.leadDays, label: `${TRANSPORT_LABEL[fastest.mode]}（成本未设全，取最快）` }
}

function confidenceOf(demand: InventoryDemand, sigmaKnown: boolean): { value: number; note: string } {
  const history = demand.historyDays ?? 0
  const base = demand.source === 'AMAZON_REPORT' ? 0.5 : history >= 90 ? 0.9 : history >= 60 ? 0.8 : history >= 30 ? 0.65 : 0.45
  const value = Math.min(0.95, Math.max(0.2, Math.round(base * (sigmaKnown ? 1 : 0.9) * 100) / 100))
  return {
    value,
    note: `置信度 ${value}：销量来源 ${demand.source === 'ORDERS' ? `订单历史 ${history} 天` : '亚马逊报告'}（基础 ${base}）${sigmaKnown ? '' : '，波动无法估计 ×0.9'}；模型启发式，不是统计置信区间`,
  }
}

/** 一个店铺 SKU 的补货计算链。 */
export function computeReplenishment(input: EngineInput): ReplenishCalc {
  const { today, policy, demand, quantity } = input
  if (!policy) return empty('NO_POLICY', '尚未配置补货策略：先在“补货策略”里保存企业级策略', null)
  if (quantity.sellable === null) return empty('NO_QUANTITY', '尚无库存数量', policy)
  const adjusted = adjustDemand(demand, input.subscribe, today)
  if (!adjusted) return empty('NO_DEMAND', '没有销量记录，无法预测需求', policy)
  const leadInfo = modeLeads(policy)
  if (policy.serviceLevel === null || !leadInfo) {
    return empty('POLICY_INCOMPLETE', '当前策略版本没有服务水平或提前期拆分：请保存新版本补齐（旧版库存规则不含这些参数）', policy)
  }
  return chain(input, policy, adjusted, leadInfo)
}

function chain(input: EngineInput, policy: ReplenishPolicy, base: AdjustedDemand, leadInfo: { leads: ModeLead[]; split: boolean }): ReplenishCalc {
  const { today, demand } = input
  const steps: CalcStep[] = []
  const serviceLevel = policy.serviceLevel as number
  const ref = referenceLead(policy, leadInfo.leads)

  // 1 需求预测（预测范围 = 今天起 max（目标覆盖天数，主提前期）天；人工预测规则取代范围内对应日期的模型日销）
  const horizon = Math.max(policy.coverageDays, ref.days)
  const plan = planDemand(base, today, horizon, input.overrides ?? [])
  const { low, mid, high } = plan
  steps.push(demandStep({ demand, adjusted: base, plan, horizon }))

  // 2 供给：提前期内与提前期外分开，只有提前期内的参与建议量；cover（可售天数、断货日）仍按全部计入的供给算，与库存健康页一致
  const counted = countedInbound(policy.inboundCounted, { working: input.quantity.inboundWorking, shipped: input.quantity.inboundShipped, receiving: input.quantity.inboundReceiving })
  const sellable = input.quantity.sellable as number
  const fba = sellable + counted
  const supply = splitSupply({
    policy,
    leads: leadInfo.leads,
    split: leadInfo.split,
    refDays: ref.days,
    sellable,
    inbound: { WORKING: input.quantity.inboundWorking, SHIPPED: input.quantity.inboundShipped, RECEIVING: input.quantity.inboundReceiving },
  })
  const { awd, domestic, purchaseInTransit } = input.supply
  steps.push(supplyStep({ policy, supply, sellable, counted, other: input.supply, refDays: ref.days }))

  // 3 提前期
  steps.push({
    key: 'LEAD_TIME',
    title: '3 提前期',
    result: leadInfo.split ? `主提前期 ${ref.days} 天（${ref.label}）` : `总提前期 ${ref.days} 天（${ref.label}）`,
    formula: leadInfo.split ? '提前期 = 生产 + 国内运输 + 头程（按运输方式）+ 入仓接收' : '没有设置运输选项：直接取策略的总提前期，不拆分运输方式',
    details: leadInfo.split
      ? [
          { label: '生产 / 国内运输 / 入仓接收', value: `${policy.productionDays} / ${policy.domesticDays} / ${policy.receivingDays} 天` },
          ...leadInfo.leads.map(lead => ({
            label: TRANSPORT_LABEL[lead.mode],
            value: `${lead.leadDays} 天（头程 ${policy.transportOptions.find(option => option.mode === lead.mode)?.transitDays} 天）`,
          })),
        ]
      : [{ label: '总提前期', value: `${policy.leadTimeDays} 天` }],
    notes: ['头程时效取策略里设置的天数；头程时效统计（实测值）由 P2a-11 交付，上线后改读实测。上游仓储调拨到亚马逊物流的时效尚未实测，策略里设置的上游仓储提前期也还没有参与风险判断。'],
  })

  // 4 安全库存
  const rates = periodRates(demand)
  const sigma = rates ? stddev(rates) : null
  const z = zScore(serviceLevel)
  const statSafety = sigma === null ? 0 : z * sigma * Math.sqrt(ref.days)
  const safetyOf = (rate: number) => Math.max(statSafety, policy.safetyDays * rate)
  const safety = Math.ceil(safetyOf(mid))
  steps.push({
    key: 'SAFETY',
    title: '4 安全库存',
    result: `安全库存 ${safety} 件`,
    formula: '取 max（服务水平系数 z × 日销波动 σ × √提前期，安全库存天数 × 日销）',
    details: [
      { label: '服务水平 → z', value: `${round2(serviceLevel * 100)}% → ${fx(z, 3)}` },
      { label: '日销波动 σ（近 90 天四个时段日均的标准差）', value: sigma === null ? '历史不足，无法估计' : fx(sigma, 3) },
      { label: '统计安全库存', value: fx(statSafety, 1) },
      { label: `策略下限（${policy.safetyDays} 天 × 日销）`, value: fx(policy.safetyDays * mid, 1) },
    ],
    notes: ['σ 用四个时段的日均估算，比逐日波动小，统计安全库存可能偏低；策略下限兜底。'],
  })

  // 5 目标覆盖
  const targetOf = (rate: number) => Math.max(rate * policy.coverageDays, rate * ref.days + safetyOf(rate))
  const target = targetOf(mid)
  steps.push({
    key: 'TARGET',
    title: '5 目标覆盖',
    result: `目标库存位置 ${fx(target, 1)} 件（覆盖 ${policy.coverageDays} 天）`,
    formula: '目标 = max（日销 × 目标覆盖天数，日销 × 主提前期 + 安全库存）',
    details: [
      { label: '日销 × 目标覆盖天数', value: `${fx(mid, 2)} × ${policy.coverageDays} = ${fx(mid * policy.coverageDays, 1)}` },
      { label: '日销 × 主提前期 + 安全库存', value: `${fx(mid, 2)} × ${ref.days} + ${safety} = ${fx(mid * ref.days + safety, 1)}` },
    ],
    notes: [`策略来源：${policy.level === 'TENANT' ? '企业级' : policy.level === 'CATEGORY' ? `品类 ${policy.levelRef}` : `SKU ${policy.levelRef}`}，第 ${policy.versionNo} 版`],
  })

  // 6 建议量：缺口按提前期内供给算；必断货量（最快运输也补不上的需求）默认从缺口里扣掉，策略开了“计入必断货量”才保留
  const includeShortage = policy.includeUnavoidableShortage
  const shortageOf = (band: 'low' | 'mid' | 'high') => unavoidableShortage({ fastestLead: supply.fastestLead, demandOver: demandOver(plan, band), supply })
  const gapOf = (rate: number) => Math.max(0, targetOf(rate) - supply.inLeadQty)
  const rawOf = (rate: number, band: 'low' | 'mid' | 'high') => (includeShortage ? gapOf(rate) : Math.max(0, gapOf(rate) - shortageOf(band)))
  const gap = gapOf(mid)
  const shortage = shortageOf('mid')
  const raw = rawOf(mid, 'mid')
  const recommended = roundUpTo(raw, policy.casePackQty)
  const supplied = (awd ?? 0) + (domestic ?? 0) + (purchaseInTransit ?? 0)
  const purchaseNeed = Math.max(0, recommended - supplied)
  const purchaseQty = purchaseNeed > 0 ? roundUpTo(Math.max(purchaseNeed, policy.moq ?? 0), policy.casePackQty) : 0
  const qtyLow = roundUpTo(rawOf(low, 'low'), policy.casePackQty)
  const qtyHigh = roundUpTo(rawOf(high, 'high'), policy.casePackQty)
  const shortageRows = shortageDetails({ shortage, fastest: supply.fastestLead, included: includeShortage, gap, counted: raw })
  steps.push({
    key: 'QTY',
    title: '6 建议量',
    result: `建议补货 ${recommended} 件，建议采购 ${purchaseQty} 件（日销区间下 ${qtyLow}–${qtyHigh} 件）`,
    formula: '缺口 = max（0，目标 − 提前期内供给）；必断货量默认不计入（策略开关）；补货量按箱规向上取整；采购量 = 补货量 − 上游仓储、国内仓、采购在途，再按最小起订量与箱规取整',
    details: [
      { label: '缺口（未取整）', value: `${fx(target, 1)} − ${supply.inLeadQty} = ${fx(gap, 1)}` },
      { label: '箱规 / 最小起订量', value: `${policy.casePackQty ?? '未设置'} / ${policy.moq ?? '未设置'}` },
      { label: '已有采购侧供给', value: awd === null && domestic === null && purchaseInTransit === null ? PENDING : String(supplied) },
      ...shortageRows.details,
    ],
    notes: [
      policy.minOrderValue === null ? '未设置最小起订金额。' : `最小起订金额 ${policy.minOrderValue} 美元：商品成本版本由 P2a-10 交付，尚未校验，请下单前人工核对。`,
      ...(shortageRows.note ? [shortageRows.note] : []),
    ],
  })
  const extras: Extras = {
    supplyInLeadTime: supply.inLeadQty,
    supplyBeyondLeadTime: supply.beyondQty,
    unavoidableShortage: shortage,
    unavoidableIncluded: includeShortage,
    appliedOverride: plan.applied,
  }

  const cover = plan.changedDays > 0 ? coverByPlan(plan, fba) : mid > 0 ? fba / mid : Number.POSITIVE_INFINITY
  const stockoutDate = Number.isFinite(cover) ? plusDays(today, Math.floor(cover)) : null
  const assessment = assess({ policy: asInventoryPolicy(policy), sellable, inboundCounted: counted, demandMid: mid, awdQty: null, today })
  const sigmaKnown = sigma !== null
  const confidence = confidenceOf(demand, sigmaKnown)

  if (recommended <= 0) {
    steps.push(
      { key: 'TRANSPORT', title: '7 运输方式拆分', result: '无需发运', formula: '建议量为 0', details: [], notes: [] },
      { key: 'TIMING', title: '8 时间', result: '无需下单', formula: '建议量为 0', details: [], notes: [] },
    )
    const onlyShortage = gap > 0 && shortage > 0 && !includeShortage
    return {
      ...empty('NO_NEED', onlyShortage ? '缺口全部是必断货量（最快运输方式也补不上），默认不计入建议量' : mid > 0 ? '库存位置已达到目标，无需补货' : '近期没有销量，无需补货', policy),
      risk: assessment.risk,
      daysOfCover: Number.isFinite(cover) ? round1(cover) : null,
      stockoutDate,
      rawQty: Math.round(raw * 10) / 10,
      qtyLow,
      qtyHigh,
      confidence: confidence.value,
      dailyDemand: mid,
      subscribeUsed: base.subscribe.used,
      ...extras,
      steps,
    }
  }

  // 7 运输方式拆分
  const coverDays = Number.isFinite(cover) ? Math.floor(cover) : 365
  const split = leadInfo.split
    ? splitTransport({ qty: recommended, coverDays, mid, modes: leadInfo.leads, preference: policy.transportPreference ?? 'AUTO', casePack: policy.casePackQty })
    : { parts: [{ mode: DEFAULT_MODE, qty: recommended }], note: '没有设置运输选项，不拆分运输方式（总提前期见第 3 步）' }
  const leadOf = (mode: string) => (mode === DEFAULT_MODE ? policy.leadTimeDays : (leadInfo.leads.find(lead => lead.mode === mode)?.leadDays as number))
  const costOf = (mode: string) => (mode === DEFAULT_MODE ? null : (policy.transportOptions.find(option => option.mode === mode)?.unitCost ?? null))
  // 所有批次都能在断货日前到仓的最晚下单日；已经来不及（或不会断货之外的情形）就今天下单
  const latestOrder = stockoutDate ? plusDays(stockoutDate, -Math.max(...split.parts.map(part => leadOf(part.mode)))) : today
  const orderDate = latestOrder > today ? latestOrder : today
  const shipments: Shipment[] = split.parts.map(part => {
    const lead = leadOf(part.mode)
    const arriveDate = plusDays(orderDate, lead)
    return {
      mode: part.mode,
      qty: part.qty,
      orderDate,
      shipDate: leadInfo.split ? plusDays(orderDate, (policy.productionDays as number) + (policy.domesticDays as number)) : null,
      arriveDate,
      leadDays: lead,
      lateDays: stockoutDate ? Math.max(0, daysBetween(stockoutDate, arriveDate)) : 0,
      unitCost: costOf(part.mode),
    }
  })
  const landed = shipments.every(shipment => shipment.unitCost !== null) ? round2(shipments.reduce((total, shipment) => total + shipment.qty * (shipment.unitCost as number), 0)) : null
  steps.push({
    key: 'TRANSPORT',
    title: '7 运输方式拆分',
    result: shipments.map(shipment => `${shipment.mode === DEFAULT_MODE ? '默认' : TRANSPORT_LABEL[shipment.mode]} ${shipment.qty} 件`).join('、'),
    formula: '总到仓成本 = Σ（数量 × 该方式每件到仓成本）；在不断货的前提下取成本最低',
    details: [
      ...shipments.map(shipment => ({
        label: shipment.mode === DEFAULT_MODE ? '默认' : TRANSPORT_LABEL[shipment.mode],
        value: `${shipment.qty} 件，提前期 ${shipment.leadDays} 天，${shipment.lateDays > 0 ? `晚于预计断货日 ${shipment.lateDays} 天` : '断货前到仓'}${shipment.unitCost === null ? '，每件成本未设置' : `，每件 ${shipment.unitCost} 美元`}`,
      })),
      { label: '总到仓成本', value: landed === null ? '无法计算（有方式未设置每件成本）' : `${landed} 美元` },
    ],
    notes: [split.note, '运输成本取策略里设置的每件到仓成本，没有按重量体积推算。'],
  })

  // 8 时间
  const first = shipments[0]
  steps.push({
    key: 'TIMING',
    title: '8 时间',
    result: `建议 ${orderDate} 下单，${first.shipDate ? `${first.shipDate} 发货，` : ''}${first.arriveDate} 到仓`,
    formula: '下单日 = max（今天，预计断货日 − 最长的到仓提前期，即所有批次都不断货的最晚下单日）；发货日 = 下单日 + 生产 + 国内运输；到仓日 = 下单日 + 该方式提前期',
    details: [
      { label: '预计断货日', value: stockoutDate ? `${stockoutDate}（可售天数 ${round1(cover)}）` : '近期没有销量，不会断货' },
      ...shipments.map(shipment => ({ label: `${shipment.mode === DEFAULT_MODE ? '默认' : TRANSPORT_LABEL[shipment.mode]}到仓日`, value: shipment.arriveDate })),
    ],
    notes: [confidence.note],
  })

  return {
    state: 'OK',
    reason: null,
    risk: assessment.risk,
    daysOfCover: Number.isFinite(cover) ? round1(cover) : null,
    stockoutDate,
    rawQty: Math.round(raw * 10) / 10,
    recommendedQty: recommended,
    purchaseQty,
    qtyLow,
    qtyHigh,
    orderDate,
    shipDate: first.shipDate,
    arriveDate: first.arriveDate,
    shipments,
    landedCost: landed,
    confidence: confidence.value,
    policyVersion: policy.versionNo,
    policyLevel: policy.level,
    dailyDemand: mid,
    subscribeUsed: base.subscribe.used,
    ...extras,
    steps,
  }
}
