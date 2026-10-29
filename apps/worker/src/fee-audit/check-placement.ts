import { overchargeOf, roundMoney } from '@nova/api-contracts'
import { AUDIT_LIMIT, addLine, chunked, emptyAccumulator, num, subjectOf, type AuditContext, type AuditResult, type AuditSubject, type LineAccumulator } from './shared'

// 入仓配置费核查（P2b-06，07 章 7.6 第 4 类）：收费交易通过交易里的货件标识（SHIPMENT_ID）对上入仓计划，
// 实收 = 该计划所有货件的入仓配置费净额；应收 = 已确认分仓方案的费用减折扣（方案里没有费用，或计划没有确认方案，就不核查）。
// 限制：入仓配置费的收费明细名称按关键字归类（名称含 placement），没有拿真实交易样本核对；收费交易没带货件标识、或货件不在入仓计划里的费用无法核对，不产出结果；
// 实收按核查窗口（最近 30 天）内入账的费用合计，同一计划的费用跨窗口入账时可能只统计到一部分。

type RelatedIdentifier = { name?: unknown; value?: unknown }
const shipmentIdOf = (value: unknown): string | null => {
  const hit = (Array.isArray(value) ? (value as RelatedIdentifier[]) : []).find(item => item?.name === 'SHIPMENT_ID' && typeof item.value === 'string')
  return typeof hit?.value === 'string' ? hit.value : null
}

export async function auditPlacement(ctx: AuditContext): Promise<AuditResult> {
  const events = await ctx.db.fbaFeeEvent.findMany({
    where: { tenantId: ctx.tenantId, feeCategory: 'INBOUND_PLACEMENT', eventType: { not: 'INBOUND_NONCOMPLIANCE' }, postedAt: { gte: ctx.since }, sourceRecordId: { not: null } },
    select: { sellerAccountId: true, feeSubtype: true, amount: true, currency: true, postedAt: true, sourceRecordId: true },
    orderBy: { postedAt: 'desc' },
    take: AUDIT_LIMIT + 1,
  })
  const truncated = events.length > AUDIT_LIMIT
  const placement = events.slice(0, AUDIT_LIMIT).filter(event => /placement/i.test(event.feeSubtype ?? '') && event.sourceRecordId)
  // 来源交易（店铺 + 交易编号 + 入账时间）里的货件标识
  const shipmentOf = new Map<string, string>()
  for (const part of chunked(placement, 200)) {
    const transactions = await ctx.db.fbaFinancialTransaction.findMany({
      where: { tenantId: ctx.tenantId, OR: part.map(event => ({ sellerAccountId: event.sellerAccountId, externalTransactionId: event.sourceRecordId as string, postedAt: event.postedAt })) },
      select: { sellerAccountId: true, externalTransactionId: true, relatedIdentifiers: true },
      take: part.length,
    })
    for (const transaction of transactions) {
      const shipment = shipmentIdOf(transaction.relatedIdentifiers)
      if (shipment) shipmentOf.set(`${transaction.sellerAccountId}|${transaction.externalTransactionId}`, shipment)
    }
  }
  const shipmentIds = [...new Set(shipmentOf.values())]
  const shipments: Array<{
    shipmentId: string
    shipmentConfirmationId: string | null
    planId: string
    plan: { id: string; name: string; sellerAccountId: string; selectedPlacementOptionId: string | null }
  }> = []
  for (const part of chunked(shipmentIds, 300)) {
    const rows = await ctx.db.fbaInboundShipment.findMany({
      where: { plan: { tenantId: ctx.tenantId }, OR: [{ shipmentId: { in: part } }, { shipmentConfirmationId: { in: part } }] },
      select: { shipmentId: true, shipmentConfirmationId: true, planId: true, plan: { select: { id: true, name: true, sellerAccountId: true, selectedPlacementOptionId: true } } },
      take: 2000,
    })
    shipments.push(...rows)
  }
  const planOf = new Map<string, (typeof shipments)[number]>()
  for (const shipment of shipments) {
    planOf.set(shipment.shipmentId, shipment)
    if (shipment.shipmentConfirmationId) planOf.set(shipment.shipmentConfirmationId, shipment)
  }
  const actualByPlan = new Map<string, { plan: (typeof shipments)[number]['plan']; refs: Set<string>; currency: string; amount: number; first: Date; last: Date; count: number }>()
  for (const event of placement) {
    const shipmentId = shipmentOf.get(`${event.sellerAccountId}|${event.sourceRecordId}`)
    const shipment = shipmentId ? planOf.get(shipmentId) : undefined
    if (!shipment || !shipmentId) continue
    const hit = actualByPlan.get(shipment.planId) ?? { plan: shipment.plan, refs: new Set<string>(), currency: event.currency, amount: 0, first: event.postedAt, last: event.postedAt, count: 0 }
    actualByPlan.set(shipment.planId, hit)
    if (hit.currency !== event.currency) continue
    hit.amount -= Number(event.amount.toString())
    hit.refs.add(shipmentId)
    hit.count += 1
    if (event.postedAt < hit.first) hit.first = event.postedAt
    if (event.postedAt > hit.last) hit.last = event.postedAt
  }
  const planIds = [...actualByPlan.keys()]
  const options = new Map<string, { fees: number; discounts: number; currency: string; optionId: string }>()
  for (const part of chunked(planIds, 300)) {
    const rows = await ctx.db.placementOption.findMany({
      where: { tenantId: ctx.tenantId, planId: { in: part }, confirmed: true },
      select: { planId: true, placementOptionId: true, fees: true, discounts: true, currency: true },
      take: 2000,
    })
    for (const row of rows) {
      const wanted = actualByPlan.get(row.planId)?.plan.selectedPlacementOptionId
      if (!wanted || wanted === row.placementOptionId)
        options.set(row.planId, { fees: num(row.fees) ?? 0, discounts: num(row.discounts) ?? 0, currency: row.currency, optionId: row.placementOptionId })
    }
  }
  const subjects: AuditSubject[] = []
  for (const [planId, hit] of actualByPlan) {
    const option = options.get(planId)
    if (!option || option.currency !== hit.currency || hit.amount <= 0) continue
    const expected = roundMoney(Math.max(0, option.fees - option.discounts))
    const actual = roundMoney(hit.amount)
    const acc: LineAccumulator = emptyAccumulator()
    const refs = [...hit.refs].slice(0, 5).join('、')
    addLine(acc, {
      at: hit.last,
      ref: refs,
      label: `入仓计划 ${hit.plan.name}：${hit.refs.size} 个货件、${hit.count} 笔入仓配置费`,
      quantity: null,
      expected,
      actual,
      overcharge: overchargeOf(expected, actual),
    })
    if (acc.occurrences > 0) acc.first = hit.first
    const money = (value: number) => `${value.toFixed(2)} ${hit.currency}`
    const verdict = acc.occurrences > 0 ? `实收高于方案费用，多收 ${money(acc.overcharge)}` : '实收与方案费用一致（在容差内）'
    subjects.push(
      subjectOf({ sellerAccountId: hit.plan.sellerAccountId, subjectKey: planId, sku: null, asin: null, shipmentRef: refs, currency: hit.currency }, acc, {
        summary: `入仓计划“${hit.plan.name}”已确认方案 ${option.optionId} 的费用 ${money(option.fees)}、折扣 ${money(option.discounts)}，应收 ${money(expected)}，近期实收 ${money(actual)}；${verdict}`,
        dims: null,
        notes: [
          '实收是核查窗口内入账的入仓配置费合计，跨窗口入账的费用可能只统计到一部分；收费交易没带货件标识或货件不在入仓计划里的费用无法核对',
          ...(truncated ? ['读取的费用事件行数触到上限，本轮结果可能不完整'] : []),
        ],
      }),
    )
  }
  return { kind: 'INBOUND_PLACEMENT', subjects, truncated }
}
