import type { OpportunityRule, ReimbursementWindows } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import { liveKeyOf, resolveStale, writeOpportunity, type OpportunityDraft, type UnitCost } from './opportunity-write.js'

// 赔付机会扫描的公共部分（P2b-03）：扫描上下文、结果结构、统一提交。每类机会一个检测函数，只负责“找出当前成立的缺口”，写入与消除都走这里。

const DAY_MS = 86_400_000

export type ScanDb = Pick<
  PrismaClient,
  | 'reimbursementOpportunity'
  | 'reimbursementRecord'
  | 'costVersion'
  | 'tenantSetting'
  | 'inventoryLedgerEntry'
  | 'fbaReturnCase'
  | 'fbaFinancialTransaction'
  | 'orderItem'
  | 'removalOrder'
  | 'receivingDiscrepancy'
  | 'fbaInboundShipment'
  | 'fbaInboundPlan'
>

export interface ScanContext {
  db: ScanDb
  tenantId: string
  now: Date
  windows: ReimbursementWindows
  costCache: Map<string, UnitCost | null>
  paidCache: Map<string, number>
}

export interface ScanResult {
  rule: OpportunityRule
  created: number
  updated: number
  resolved: number
  /** 读取数据触到上限：这一轮不做“差异已消除”的判断，避免把看不见的当成不存在。 */
  truncated: boolean
}

/** 扫描读取的行数上限（每类）。 */
export const SCAN_LIMIT = 20_000

export type DraftInput = Omit<OpportunityDraft, 'tenantId' | 'now' | 'window' | 'costCache'>

/** 起算日往前（负数）或往后推若干天后的当天零点（UTC）。 */
export function shiftDay(from: Date, days: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) + days * DAY_MS)
}

export const dayText = (value: Date) => value.toISOString().slice(0, 10)

export function newContext(db: ScanDb, tenantId: string, now: Date, windows: ReimbursementWindows): ScanContext {
  return { db, tenantId, now, windows, costCache: new Map(), paidCache: new Map() }
}

/** 把一类机会的检测结果写入：新建或刷新，再消除不再成立的。 */
export async function commitRule(ctx: ScanContext, rule: OpportunityRule, drafts: readonly DraftInput[], truncated: boolean, skipResolve = false): Promise<ScanResult> {
  const window = ctx.windows[rule]
  let created = 0
  let updated = 0
  const live = new Set<string>()
  for (const draft of drafts) {
    live.add(liveKeyOf(draft.sellerAccountId, draft.dedupKey))
    const outcome = await writeOpportunity(ctx.db, { ...draft, tenantId: ctx.tenantId, now: ctx.now, window, costCache: ctx.costCache })
    if (outcome === 'created') created += 1
    else if (outcome === 'updated') updated += 1
  }
  const resolved = truncated || skipResolve ? 0 : await resolveStale(ctx.db, ctx.tenantId, rule, live, ctx.now)
  return { rule, created, updated, resolved, truncated }
}
