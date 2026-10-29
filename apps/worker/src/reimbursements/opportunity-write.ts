import { claimWindowOf, reasonMatchesRule, resolveWindows, type OpportunityEvidence, type OpportunityRule, type ReimbursementWindows, type RuleWindow } from '@nova/api-contracts'
import { Prisma, type PrismaClient } from '@prisma/client'

// 赔付机会的写入规则（P2b-03，07 章 7.3）：7 类机会共用。机会按 (企业, 店铺, 规则, 去重键) 唯一，重复扫描只刷新，不重复新建。
// 状态规则：只有“待处理、差异已消除、已过期”三种状态会被扫描改写；“已生成案件”“已忽略”是人工处理过的，扫描永远不动。
// 起算日之后还在等待期内的不产出机会；过了申请期限的新机会不产出（已有的待处理转为已过期）；条件不再成立的待处理机会转为“差异已消除”。
// 估算金额 = 数量 × 当前生效的单件商品成本；没有商品成本时为空（不当 0）。

export type OpportunityDb = Pick<PrismaClient, 'reimbursementOpportunity' | 'costVersion' | 'reimbursementRecord' | 'tenantSetting'>

export async function loadWindows(db: Pick<PrismaClient, 'tenantSetting'>, tenantId: string): Promise<ReimbursementWindows> {
  const row = await db.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: 'reimbursement.windows' }, select: { valueJson: true } })
  return resolveWindows(row?.valueJson)
}

export interface UnitCost {
  amount: number
  currency: string
}

/** 当前生效的单件商品成本；没有为 null。同一次扫描里同一个 SKU 只查一次。 */
export async function unitCostOf(db: Pick<PrismaClient, 'costVersion'>, tenantId: string, sku: string, cache?: Map<string, UnitCost | null>): Promise<UnitCost | null> {
  const hit = cache?.get(sku)
  if (hit !== undefined) return hit
  const version = await db.costVersion.findFirst({
    where: { tenantId, sku, status: 'ACTIVE', unitProductCost: { not: null } },
    orderBy: { versionNo: 'desc' },
    select: { unitProductCost: true, currency: true },
  })
  const cost = version?.unitProductCost ? { amount: version.unitProductCost.toNumber(), currency: version.currency } : null
  cache?.set(sku, cost)
  return cost
}

export interface OpportunityDraft {
  tenantId: string
  sellerAccountId: string
  ruleCode: OpportunityRule
  dedupKey: string
  sku: string | null
  qty: number | null
  /** 起算日：等待期与申请期限都从这一天算。 */
  anchor: Date
  evidence: OpportunityEvidence[]
  now: Date
  window: RuleWindow
  costCache?: Map<string, UnitCost | null>
}

const WRITABLE = ['PENDING', 'RESOLVED', 'EXPIRED']

export async function writeOpportunity(db: Pick<PrismaClient, 'reimbursementOpportunity' | 'costVersion'>, draft: OpportunityDraft): Promise<'created' | 'updated' | 'skipped'> {
  const { tenantId, sellerAccountId, ruleCode, dedupKey } = draft
  const window = claimWindowOf(draft.anchor, draft.now, draft.window.waitDays, draft.window.windowDays)
  if (window.state === 'WAITING') return 'skipped'
  const where = { tenantId_sellerAccountId_ruleCode_dedupKey: { tenantId, sellerAccountId, ruleCode, dedupKey: dedupKey.slice(0, 200) } }
  const current = await db.reimbursementOpportunity.findUnique({ where, select: { status: true } })
  if (current && !WRITABLE.includes(current.status)) return 'skipped'
  if (!current && window.state === 'EXPIRED') return 'skipped'
  const cost = draft.sku && draft.qty ? await unitCostOf(db, tenantId, draft.sku, draft.costCache) : null
  const data = {
    evidenceRefsJson: draft.evidence as unknown as Prisma.InputJsonValue,
    estimatedAmount: cost && draft.qty ? Math.round(cost.amount * draft.qty * 100) / 100 : null,
    currency: cost?.currency ?? null,
    deadlineAt: new Date(`${window.deadline}T00:00:00.000Z`),
    status: window.state === 'EXPIRED' ? 'EXPIRED' : 'PENDING',
    sku: draft.sku,
    qty: draft.qty,
  }
  await db.reimbursementOpportunity.upsert({ where, create: { tenantId, sellerAccountId, ruleCode, dedupKey: dedupKey.slice(0, 200), ...data }, update: data })
  return current ? 'updated' : 'created'
}

export const liveKeyOf = (sellerAccountId: string, dedupKey: string) => `${sellerAccountId}|${dedupKey.slice(0, 200)}`

/** 这一轮扫描里仍然成立的机会之外，同一规则下“待处理”的机会不再成立：转为“差异已消除”。扫描被截断时不要调用。 */
export async function resolveStale(db: Pick<PrismaClient, 'reimbursementOpportunity'>, tenantId: string, ruleCode: OpportunityRule, liveKeys: ReadonlySet<string>, now: Date): Promise<number> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  const open = await db.reimbursementOpportunity.findMany({
    where: { tenantId, ruleCode, status: 'PENDING', OR: [{ deadlineAt: null }, { deadlineAt: { gte: today } }] },
    select: { id: true, sellerAccountId: true, dedupKey: true },
    take: 20_000,
  })
  const stale = open.filter(row => !liveKeys.has(liveKeyOf(row.sellerAccountId, row.dedupKey))).map(row => row.id)
  if (stale.length === 0) return 0
  const result = await db.reimbursementOpportunity.updateMany({ where: { id: { in: stale }, tenantId, status: 'PENDING' }, data: { status: 'RESOLVED' } })
  return result.count
}

/** 申请期限已过、还在“待处理”的机会转为“已过期”（不管有没有被这一轮扫描看到）。 */
export async function expireOverdue(db: Pick<PrismaClient, 'reimbursementOpportunity'>, tenantId: string, now: Date): Promise<number> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  const result = await db.reimbursementOpportunity.updateMany({ where: { tenantId, status: 'PENDING', deadlineAt: { lt: today } }, data: { status: 'EXPIRED' } })
  return result.count
}

/**
 * 官方赔付明细已经覆盖的数量：同一店铺、同一 SKU、赔付原因与这类机会吻合、批准日不早于起算日的正数赔付，数量相加。
 * 用来把“亚马逊已经自动赔付了”的缺口从机会里扣掉。
 */
export async function paidQuantity(
  db: Pick<PrismaClient, 'reimbursementRecord'>,
  tenantId: string,
  sellerAccountId: string,
  sku: string,
  rule: OpportunityRule,
  since: Date,
  cache?: Map<string, number>,
): Promise<number> {
  const key = `${sellerAccountId}|${sku}|${rule}|${since.toISOString().slice(0, 10)}`
  const hit = cache?.get(key)
  if (hit !== undefined) return hit
  const rows = await db.reimbursementRecord.findMany({ where: { tenantId, sellerAccountId, sku, approvedAt: { gte: since }, amount: { gt: 0 } }, select: { reason: true, quantity: true }, take: 1000 })
  const total = rows.filter(row => reasonMatchesRule(row.reason, rule)).reduce((sum, row) => sum + row.quantity, 0)
  cache?.set(key, total)
  return total
}
