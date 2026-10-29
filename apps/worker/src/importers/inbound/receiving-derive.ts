import { discrepancyOf, type OpportunityEvidence, type RuleWindow } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { loadWindows, writeOpportunity, type UnitCost } from '../../reimbursements/opportunity-write.js'

// 货件接收差异与赔付机会（P2a-13，06 章 6.12、07 章 7.3 第 1 类）：入仓同步拿到接收数量之后调用。
// 规则：货件关闭之前不判差异（接收数量还在变）；关闭后应发减已收，为正是少收、为负是多收；差异消除后不删除，写“已消除时间”。
// 机会只对少收产出：关闭后过了等待期才产出，过了申请期限仍待处理的转为已过期；差异后来消除的，待处理的机会转为“差异已消除”。
// 估算金额 = 少收数量 × 当前生效的单件商品成本；没有商品成本时为空，不当 0。
// P2b-03：机会的写入改走 reimbursements/opportunity-write（7 类机会共用），时限取设置“赔付机会时限”，没设置用默认值。

type Db = Pick<PrismaClient, 'receivingDiscrepancy' | 'reimbursementOpportunity' | 'costVersion' | 'tenantSetting'>

export interface ReceivedRow {
  sku: string
  shipped: number | null
  received: number | null
}

export interface DeriveInput {
  tenantId: string
  sellerAccountId: string
  planId: string
  /** FbaInboundShipment 的行编号，机会的证据跳转用。 */
  shipmentRowId: string
  shipmentId: string
  closed: boolean
  closedAt: Date | null
  rows: readonly ReceivedRow[]
  now: Date
  /** 等待期与申请期限；不传时读设置。 */
  window?: RuleWindow
}

export interface ExistingDiscrepancy {
  id: string
  sku: string
  kind: string
  resolvedAt: Date | null
}

export interface DiscrepancyPlan {
  /** 要写入（新建或更新数量）的差异；reopen 表示之前已消除、现在又出现。 */
  upserts: Array<{ sku: string; kind: 'SHORT' | 'OVER'; qty: number }>
  /** 要标记为已消除的行编号。 */
  resolve: string[]
}

/** 纯函数：关闭后的货件按接收数量算出该有的差异，与已有的比较得出要写与要消除的。没关闭什么都不做。 */
export function planDiscrepancies(existing: readonly ExistingDiscrepancy[], rows: readonly ReceivedRow[], closed: boolean): DiscrepancyPlan {
  if (!closed) return { upserts: [], resolve: [] }
  const wanted = new Map<string, { sku: string; kind: 'SHORT' | 'OVER'; qty: number }>()
  for (const row of rows) {
    const diff = discrepancyOf(row.shipped, row.received)
    if (diff) wanted.set(`${row.sku}|${diff.kind}`, { sku: row.sku, ...diff })
  }
  const resolve = existing.filter(item => !item.resolvedAt && (item.kind === 'SHORT' || item.kind === 'OVER') && !wanted.has(`${item.sku}|${item.kind}`)).map(item => item.id)
  return { upserts: [...wanted.values()], resolve }
}

export async function deriveReceiving(db: Db, input: DeriveInput): Promise<{ discrepancies: number; opportunities: number }> {
  const { tenantId, sellerAccountId, shipmentId, now } = input
  if (!input.closed) return { discrepancies: 0, opportunities: 0 }
  const existing = await db.receivingDiscrepancy.findMany({
    where: { tenantId, sellerAccountId, shipmentRef: shipmentId, source: 'RECEIPT' },
    select: { id: true, sku: true, kind: true, resolvedAt: true },
    take: 5000,
  })
  const plan = planDiscrepancies(existing, input.rows, true)
  for (const item of plan.upserts) {
    await db.receivingDiscrepancy.upsert({
      where: { tenantId_sellerAccountId_shipmentRef_sku_kind_problemKey: { tenantId, sellerAccountId, shipmentRef: shipmentId, sku: item.sku, kind: item.kind, problemKey: '' } },
      create: { tenantId, sellerAccountId, planId: input.planId, shipmentRef: shipmentId, sku: item.sku, kind: item.kind, qty: item.qty, source: 'RECEIPT', firstSeenAt: now, lastSeenAt: now },
      update: { qty: item.qty, lastSeenAt: now, resolvedAt: null },
    })
  }
  if (plan.resolve.length > 0) await db.receivingDiscrepancy.updateMany({ where: { id: { in: plan.resolve } }, data: { resolvedAt: now, lastSeenAt: now } })
  const opportunities = await deriveOpportunities(db, input, plan)
  return { discrepancies: plan.upserts.length + plan.resolve.length, opportunities }
}

const dedupKeyOf = (shipmentId: string, sku: string) => `${shipmentId}:${sku}`.slice(0, 200)

async function deriveOpportunities(db: Db, input: DeriveInput, plan: DiscrepancyPlan): Promise<number> {
  const { tenantId, sellerAccountId, shipmentId, now } = input
  if (!input.closedAt) return 0
  const window = input.window ?? (await loadWindows(db, tenantId)).INBOUND_DISCREPANCY
  let touched = 0
  const rule = 'INBOUND_DISCREPANCY'
  const costCache = new Map<string, UnitCost | null>()
  for (const item of plan.upserts.filter(row => row.kind === 'SHORT')) {
    const evidence: OpportunityEvidence[] = [
      { kind: 'SHIPMENT', id: input.shipmentRowId, label: `货件 ${shipmentId}` },
      { kind: 'SKU', id: item.sku, label: item.sku },
    ]
    const result = await writeOpportunity(db, {
      tenantId,
      sellerAccountId,
      ruleCode: rule,
      dedupKey: dedupKeyOf(shipmentId, item.sku),
      sku: item.sku,
      qty: item.qty,
      anchor: input.closedAt,
      evidence,
      now,
      window,
      costCache,
    })
    if (result !== 'skipped') touched += 1
  }
  // 差异已经消除的少收：待处理的机会转为“差异已消除”（人工处理过的状态不动）
  const stillShort = new Set(plan.upserts.filter(row => row.kind === 'SHORT').map(row => row.sku))
  const shortRows = await db.receivingDiscrepancy.findMany({
    where: { tenantId, sellerAccountId, shipmentRef: shipmentId, kind: 'SHORT', resolvedAt: { not: null } },
    select: { sku: true },
    take: 5000,
  })
  for (const row of shortRows.filter(item => !stillShort.has(item.sku))) {
    const result = await db.reimbursementOpportunity.updateMany({
      where: { tenantId, sellerAccountId, ruleCode: rule, dedupKey: dedupKeyOf(shipmentId, row.sku), status: 'PENDING' },
      data: { status: 'RESOLVED' },
    })
    touched += result.count
  }
  return touched
}
