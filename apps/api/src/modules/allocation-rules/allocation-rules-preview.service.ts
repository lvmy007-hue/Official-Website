import { Injectable } from '@nestjs/common'
import {
  ALLOCATION_RULE_LIMITS,
  ALLOCATION_RULE_READ,
  AllocationPreviewBodySchema,
  allocateByWeights,
  allocationWeights,
  isAllocationRuleBasis,
  monthStartDate,
  monthText,
  pickRuleForMonth,
  round6,
  transactionTypeKey,
  type AllocationPreviewResponse,
  type AllocationPreviewRow,
  type AllocationRuleLite,
  type AllocationWeightData,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { lockedMonths, nextMonthStart, requireFeeItem, toWeights } from './allocation-rules-common'

type Raw = Record<string, unknown>
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(String(value)))
const CAP = 20_000

const SALES_SQL = `
SELECT o."sellerAccountId" AS "store", i."sellerSku" AS "sku", COALESCE(sum(i."quantityOrdered"), 0)::int AS "units", COALESCE(sum(i."itemPrice"), 0) AS "revenue"
FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id" AND i."orderPurchaseDate" = o."purchaseDate" AND i."tenantId" = o."tenantId"
WHERE o."tenantId" = $1 AND o."purchaseDate" >= $2 AND o."purchaseDate" < $3 AND lower(o."status") NOT IN ('canceled', 'cancelled')
  AND i."currency" = 'USD' AND i."sellerSku" IS NOT NULL AND i."sellerSku" <> ''
GROUP BY o."sellerAccountId", i."sellerSku"`

/**
 * 分摊预览（P6-19，POST /finance/allocation-rules/preview）：某个月按“尚未保存的规则”分摊的结果，对比当前生效规则的差异。只读，不落库。
 * 与利润日表派生用同一份权重与分摊纯函数（契约 allocationWeights、allocateByWeights），差别只在数据口径：预览按世界时的自然月、订单按下单时间，
 * 费用按入账时间；利润日表按企业时区的日历日与所选收入确认口径，月初月末的个别笔可能归属不同月份，总额不受影响。
 */
@Injectable()
export class AllocationRulesPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async preview(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<AllocationPreviewResponse> {
    const context = await this.context.authorize(req, ALLOCATION_RULE_READ)
    const body = AllocationPreviewBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const item = await requireFeeItem(this.prisma, tenantId, context.userId, body.rule.feeItemId, now)
    const start = monthStartDate(body.month)
    const end = nextMonthStart(body.month)
    const newRule: AllocationRuleLite = { feeItemId: item.id, basis: body.rule.basis, manualWeights: body.rule.manualWeights ?? null, effectiveMonth: body.month }
    const stored = await this.prisma.allocationRule.findMany({
      where: { tenantId, feeItemId: item.id },
      select: { id: true, feeItemId: true, basis: true, manualWeights: true, effectiveMonth: true, version: true },
      take: 500,
    })
    const existing: AllocationRuleLite[] = stored.flatMap(row =>
      isAllocationRuleBasis(row.basis)
        ? [{ id: row.id, feeItemId: row.feeItemId, basis: row.basis, manualWeights: toWeights(row.manualWeights), effectiveMonth: monthText(row.effectiveMonth), version: row.version }]
        : [],
    )
    const current = pickRuleForMonth(existing, item.id, body.month)

    // 该月映射到这个费用项的店铺级费用（没有 SKU），按店铺汇总
    const mappings = await this.prisma.profitItemMapping.findMany({ where: { tenantId, itemId: item.id }, select: { transactionType: true }, take: 5000 })
    const types = new Set(mappings.map(mapping => mapping.transactionType))
    const fees = await this.prisma.fbaFeeEvent.groupBy({
      by: ['sellerAccountId', 'feeCategory', 'feeSubtype'],
      where: { tenantId, currency: 'USD', OR: [{ sellerSku: null }, { sellerSku: '' }], postedAt: { gte: start, lt: end } },
      _sum: { amount: true },
      orderBy: [{ sellerAccountId: 'asc' }, { feeCategory: 'asc' }, { feeSubtype: 'asc' }],
      take: CAP,
    })
    const totals = new Map<string, number>()
    for (const row of fees) {
      if (!types.has(transactionTypeKey(row.feeCategory, row.feeSubtype))) continue
      totals.set(row.sellerAccountId, (totals.get(row.sellerAccountId) ?? 0) + num(row._sum.amount))
    }

    // 权重原料：按店铺 → SKU
    const needsSales = [newRule, current].some(rule => rule && (rule.basis === 'SALES_AMOUNT' || rule.basis === 'SALES_UNITS'))
    const needsShipment = [newRule, current].some(rule => rule?.basis === 'SHIPMENT_RECEIVED_UNITS')
    const needsRemoval = [newRule, current].some(rule => rule?.basis === 'REMOVAL_ORDER_SKU')
    const sales = new Map<string, Map<string, { revenue: number; units: number }>>()
    const shipment = new Map<string, Map<string, number>>()
    const removal = new Map<string, Map<string, number>>()
    const bump = (target: Map<string, Map<string, number>>, store: string, sku: string, qty: number) => {
      if (!sku || qty <= 0) return
      const skus = target.get(store) ?? new Map<string, number>()
      skus.set(sku, (skus.get(sku) ?? 0) + qty)
      target.set(store, skus)
    }
    if (needsSales) {
      const rows = await this.prisma.$queryRawUnsafe<Raw[]>(SALES_SQL, tenantId, start, end)
      for (const row of rows) {
        const skus = sales.get(String(row.store)) ?? new Map<string, { revenue: number; units: number }>()
        skus.set(String(row.sku), { revenue: num(row.revenue), units: num(row.units) })
        sales.set(String(row.store), skus)
      }
    }
    if (needsShipment) {
      const items = await this.prisma.shipmentItem.findMany({
        where: { tenantId, receivedQty: { gt: 0 }, updatedAt: { gte: start, lt: end } },
        select: { sku: true, receivedQty: true, planId: true },
        take: CAP,
      })
      const planIds = [...new Set(items.map(row => row.planId))]
      const plans = planIds.length > 0 ? await this.prisma.fbaInboundPlan.findMany({ where: { tenantId, id: { in: planIds } }, select: { id: true, sellerAccountId: true }, take: CAP }) : []
      const storeOf = new Map(plans.map(plan => [plan.id, plan.sellerAccountId]))
      for (const row of items) bump(shipment, storeOf.get(row.planId) ?? '', row.sku, row.receivedQty ?? 0)
    }
    if (needsRemoval) {
      const orders = await this.prisma.removalOrder.findMany({ where: { tenantId, requestDate: { gte: start, lt: end } }, select: { sellerAccountId: true, sku: true, requestedQty: true }, take: CAP })
      for (const row of orders) bump(removal, row.sellerAccountId, row.sku, row.requestedQty)
    }
    const dataOf = (store: string): AllocationWeightData => ({ sales: sales.get(store) ?? new Map(), shipment: shipment.get(store) ?? new Map(), removal: removal.get(store) ?? new Map() })

    const rows = new Map<string, AllocationPreviewRow>()
    const touch = (store: string, sku: string) => {
      const key = `${store}|${sku}`
      const hit = rows.get(key)
      if (hit) return hit
      const row: AllocationPreviewRow = { sellerAccountId: store, sku, share: 0, amount: 0, currentAmount: 0, diff: 0 }
      rows.set(key, row)
      return row
    }
    let allocated = 0
    let total = 0
    for (const [store, amount] of [...totals].sort(([a], [b]) => (a < b ? -1 : 1))) {
      total += amount
      const next = allocateByWeights(amount, allocationWeights(newRule, dataOf(store)))
      for (const part of next.parts) {
        const row = touch(store, part.key)
        row.share = part.share
        row.amount = part.amount
        allocated += part.amount
      }
      if (current) for (const part of allocateByWeights(amount, allocationWeights(current, dataOf(store))).parts) touch(store, part.key).currentAmount = part.amount
    }
    const list = [...rows.values()]
      .map(row => ({ ...row, amount: round6(row.amount), currentAmount: round6(row.currentAmount), diff: round6(row.amount - row.currentAmount), share: Math.round(row.share * 1e6) / 1e6 }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.sku.localeCompare(b.sku))
    const locked = (await lockedMonths(this.prisma, tenantId, [body.month])).has(body.month)
    return {
      month: body.month,
      feeItemId: item.id,
      feeItemName: item.name,
      basis: newRule.basis,
      totalAmount: round6(total),
      allocatedAmount: round6(allocated),
      unallocatedAmount: round6(total - allocated),
      currentBasis: current?.basis ?? null,
      locked,
      rows: list.slice(0, ALLOCATION_RULE_LIMITS.previewRowMax),
      truncated: list.length > ALLOCATION_RULE_LIMITS.previewRowMax,
      notes: [
        '预览只读，不会保存规则，也不会改动任何数字；分摊只改变归属，总额不变。',
        '金额为美元、带符号（花费为负）；预览按世界时的自然月取订单（下单时间）与费用（入账时间），利润日表按企业时区与所选收入确认口径，月初月末个别笔可能归属不同月份。',
        ...(locked ? ['这个月所在的期间已关账：保存规则不会改变已关账的数字，需要先重开关账。'] : []),
        ...(totals.size === 0 ? ['这个月没有映射到该费用项的店铺级费用（没有 SKU 的明细），预览没有可分摊的金额。'] : []),
        ...(round6(total - allocated) !== 0 && totals.size > 0 ? ['部分店铺这个月没有任何权重（例如没有销售），这部分费用整笔留在店铺级，不会丢失。'] : []),
      ],
    }
  }
}
