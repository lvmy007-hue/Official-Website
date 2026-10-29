import { FEE_AUDIT_WINDOW_DAYS, overchargeOf, roundMoney, type FeeAuditKind } from '@nova/api-contracts'
import {
  AUDIT_LIMIT,
  addLine,
  buildDims,
  chunked,
  dimsNote,
  emptyAccumulator,
  latestBaselines,
  loadProducts,
  num,
  skuKeyOf,
  subjectOf,
  type AuditContext,
  type AuditResult,
  type AuditSubject,
  type LineAccumulator,
} from './shared'

// 配送费与佣金核查（P2b-06，07 章 7.6 第 1、2 类）：逐个订单行比较实收与应收。
// 实收：费用事件里同一订单、同一 SKU 的该类费用净额（扣费为负，取相反数；净额不是扣费的行不核查）。
// 配送费应收 = R-23 的单件预期配送费 × 订单数量；佣金应收 = R-24 的“预估佣金 ÷ 售价”比例 × 订单行商品金额。
// 订单数量与金额来自订单行（订单还没同步下来的行无法核对，不核查也不当作正常）；币种与基准不一致的行跳过。
// 没有可用基准的 SKU 不产出结果行（没有基准就没有“应收”，页面不会把它显示成正常）。
// 限制（依据里如实写出）：预估报告与实际结算口径不会逐分一致；佣金有分档费率、最低佣金与可变关闭费，会产生正常误差。

interface Line {
  sellerAccountId: string
  amazonOrderId: string
  sku: string
  asin: string | null
  actual: number
  currency: string
  postedAt: Date
}

const key3 = (sellerAccountId: string, orderId: string, sku: string) => `${sellerAccountId}|${orderId}|${sku}`

/** 窗口内这类费用的订单行实收（同一订单同一 SKU 合并）。 */
async function loadFeeLines(ctx: AuditContext, kind: 'FULFILLMENT' | 'COMMISSION') {
  const events = await ctx.db.fbaFeeEvent.findMany({
    where: { tenantId: ctx.tenantId, feeCategory: kind, postedAt: { gte: ctx.since }, amazonOrderId: { not: null }, sellerSku: { not: null } },
    select: { sellerAccountId: true, amazonOrderId: true, sellerSku: true, asin: true, amount: true, currency: true, postedAt: true },
    orderBy: { postedAt: 'desc' },
    take: AUDIT_LIMIT + 1,
  })
  const truncated = events.length > AUDIT_LIMIT
  const merged = new Map<string, Line>()
  for (const event of events.slice(0, AUDIT_LIMIT)) {
    if (!event.amazonOrderId || !event.sellerSku) continue
    const key = key3(event.sellerAccountId, event.amazonOrderId, event.sellerSku)
    const amount = Number(event.amount.toString())
    const hit = merged.get(key)
    if (!hit) {
      merged.set(key, {
        sellerAccountId: event.sellerAccountId,
        amazonOrderId: event.amazonOrderId,
        sku: event.sellerSku,
        asin: event.asin,
        actual: -amount,
        currency: event.currency,
        postedAt: event.postedAt,
      })
    } else if (hit.currency === event.currency) {
      hit.actual -= amount
      if (event.postedAt > hit.postedAt) hit.postedAt = event.postedAt
    }
  }
  return { lines: [...merged.values()].filter(line => line.actual > 0), truncated }
}

/** 订单行的数量与金额（同一订单同一 SKU 的多个订单行相加）。 */
async function loadOrderItems(ctx: AuditContext, orderIds: readonly string[]) {
  const items = new Map<string, { quantity: number; amount: number | null }>()
  for (const part of chunked([...new Set(orderIds)], 500)) {
    const rows = await ctx.db.orderItem.findMany({
      where: { tenantId: ctx.tenantId, amazonOrderId: { in: part } },
      select: { sellerAccountId: true, amazonOrderId: true, sellerSku: true, quantityOrdered: true, quantityShipped: true, itemPrice: true },
      take: 10_000,
    })
    for (const row of rows) {
      if (!row.sellerSku) continue
      const key = key3(row.sellerAccountId, row.amazonOrderId, row.sellerSku)
      const quantity = row.quantityShipped > 0 ? row.quantityShipped : row.quantityOrdered
      const price = num(row.itemPrice)
      const hit = items.get(key)
      if (hit) {
        hit.quantity += quantity
        hit.amount = hit.amount === null || price === null ? null : hit.amount + price
      } else {
        items.set(key, { quantity, amount: price })
      }
    }
  }
  return items
}

type Identity = Pick<AuditSubject, 'sellerAccountId' | 'subjectKey' | 'sku' | 'asin' | 'shipmentRef' | 'currency'>
interface Slot {
  acc: LineAccumulator
  identity: Identity
  unit: number
  skipped: { noOrder: number; currency: number; noPrice: number }
}

export async function auditOrderLines(ctx: AuditContext, kind: Extract<FeeAuditKind, 'FULFILLMENT' | 'COMMISSION'>): Promise<AuditResult> {
  const field = kind === 'FULFILLMENT' ? 'expectedFulfillmentFee' : 'expectedReferralFee'
  const { latest: baselines, truncated: baselineCut } = await latestBaselines(ctx, field)
  const { lines, truncated: feeCut } = await loadFeeLines(ctx, kind)
  const items = await loadOrderItems(
    ctx,
    lines.map(line => line.amazonOrderId),
  )
  const slots = new Map<string, Slot>()
  for (const line of lines) {
    const skuKey = skuKeyOf(line.sellerAccountId, line.sku)
    const baseline = baselines.get(skuKey)
    const unit = baseline ? num(baseline[field]) : null
    if (!baseline || unit === null) continue
    const slot: Slot = slots.get(skuKey) ?? {
      acc: emptyAccumulator(),
      identity: { sellerAccountId: line.sellerAccountId, subjectKey: line.sku, sku: line.sku, asin: line.asin ?? (baseline.asin || null), shipmentRef: null, currency: baseline.currency },
      unit,
      skipped: { noOrder: 0, currency: 0, noPrice: 0 },
    }
    slots.set(skuKey, slot)
    const item = items.get(key3(line.sellerAccountId, line.amazonOrderId, line.sku))
    if (!item || item.quantity <= 0) {
      slot.skipped.noOrder += 1
      continue
    }
    if (baseline.currency !== line.currency) {
      slot.skipped.currency += 1
      continue
    }
    const price = num(baseline.salesPrice)
    if (kind === 'COMMISSION' && (price === null || price <= 0 || item.amount === null)) {
      slot.skipped.noPrice += 1
      continue
    }
    const expected = roundMoney(kind === 'FULFILLMENT' ? unit * item.quantity : (unit / (price as number)) * (item.amount as number))
    const actual = roundMoney(line.actual)
    addLine(slot.acc, {
      at: line.postedAt,
      ref: line.amazonOrderId,
      label: kind === 'FULFILLMENT' ? `订单 ${line.amazonOrderId}，${item.quantity} 件` : `订单 ${line.amazonOrderId}，商品金额 ${(item.amount as number).toFixed(2)}`,
      quantity: item.quantity,
      expected,
      actual,
      overcharge: overchargeOf(expected, actual),
    })
  }
  const products = await loadProducts(
    ctx,
    [...slots.values()].map(slot => slot.identity.sku ?? ''),
  )
  const subjects: AuditSubject[] = []
  for (const slot of slots.values()) {
    const { acc, identity, unit, skipped } = slot
    if (acc.checked === 0) continue
    const skuKey = skuKeyOf(identity.sellerAccountId, identity.sku ?? '')
    const baseline = baselines.get(skuKey)
    const dims = kind === 'FULFILLMENT' ? buildDims(baseline, products.get(skuKey)) : null
    const money = (value: number) => `${value.toFixed(2)} ${identity.currency}`
    const head =
      kind === 'FULFILLMENT'
        ? `近 ${FEE_AUDIT_WINDOW_DAYS} 天核对 ${acc.checked} 个订单行，单件预期配送费 ${money(unit)}`
        : `近 ${FEE_AUDIT_WINDOW_DAYS} 天核对 ${acc.checked} 个订单行，预估佣金 ${money(unit)}（基准售价 ${num(baseline?.salesPrice)?.toFixed(2) ?? '—'}）`
    const verdict = acc.occurrences > 0 ? `其中 ${acc.occurrences} 行实收高于应收，累计多收 ${money(roundMoney(acc.overcharge))}` : '实收均在应收与容差范围内'
    const notes = [
      skipped.noOrder > 0 ? `${skipped.noOrder} 个订单行的订单行记录还没同步，无法取得数量或金额，未核对` : null,
      skipped.currency > 0 ? `${skipped.currency} 个订单行的币种与基准不一致，未核对` : null,
      skipped.noPrice > 0 ? `${skipped.noPrice} 个订单行缺少基准售价或商品金额，无法按比例推算佣金，未核对` : null,
      feeCut || baselineCut ? '读取的费用事件或基准行数触到上限，本轮结果可能不完整' : null,
      dimsNote(dims),
    ].filter((note): note is string => note !== null)
    subjects.push(subjectOf(identity, acc, { summary: `${head}；${verdict}`, dims, notes }))
  }
  return { kind, subjects, truncated: feeCut || baselineCut }
}
