import type { PrismaClient } from '@prisma/client'
import { countByCategory, type ParityCategory, type ParityReport, type ParityWindow } from './types'

// 核对记录与旧通道状态：每个店铺、每个数据域一行状态；每次核对一行运行记录加若干差异行。
// 关闭规则：连续 requiredPasses 次核对“没有未解释差异”后，旧通道关闭（之后不再调用旧接口，也不再核对）。

export type ParityDomain = 'ORDERS' | 'FINANCE'
export type ParityStatus = 'PASSED' | 'HAS_DIFFS' | 'LEGACY_UNAVAILABLE'
export type ParityScope = { tenantId: string; sellerAccountId: string }

/** 单次核对最多保存的差异行数（未解释优先）；超出部分只体现在各类计数里。 */
export const MAX_STORED_DIFFS = 1000
/** 核对间隔：每天一次（留 4 小时余量，避免同步任务每天提前一点点就一直错过）。 */
export const PARITY_INTERVAL_MS = 20 * 3_600_000

const ORDER: Record<ParityCategory, number> = { UNEXPLAINED: 0, SCOPE: 1, ATTRIBUTION_BASIS: 2, TIME_BASIS: 3 }

export const ensureChannelState = (prisma: PrismaClient, scope: ParityScope, domain: ParityDomain) =>
  prisma.connectorChannelState.upsert({
    where: { sellerAccountId_domain: { sellerAccountId: scope.sellerAccountId, domain } },
    create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, domain },
    update: {},
  })

export const shouldRunParity = (state: { legacyEnabled: boolean; lastRunAt: Date | null }, now: Date) =>
  state.legacyEnabled && (!state.lastRunAt || now.getTime() - state.lastRunAt.getTime() >= PARITY_INTERVAL_MS)

export type SavedParity = { runId: string; status: ParityStatus; closed: boolean; counts: Record<ParityCategory, number> }

export async function saveParityRun(
  prisma: PrismaClient,
  scope: ParityScope,
  domain: ParityDomain,
  input: { window: ParityWindow; report: ParityReport | null; startedAt: Date; now: Date; syncJobId?: string },
): Promise<SavedParity> {
  const report = input.report ?? { legacyCount: 0, newCount: 0, matchedCount: 0, diffs: [] }
  const counts = countByCategory(report.diffs)
  const status: ParityStatus = input.report === null ? 'LEGACY_UNAVAILABLE' : counts.UNEXPLAINED === 0 ? 'PASSED' : 'HAS_DIFFS'
  return prisma.$transaction(async tx => {
    const run = await tx.connectorParityRun.create({
      data: {
        tenantId: scope.tenantId,
        sellerAccountId: scope.sellerAccountId,
        domain,
        windowStart: input.window.start,
        windowEnd: input.window.end,
        legacyCount: report.legacyCount,
        newCount: report.newCount,
        matchedCount: report.matchedCount,
        unexplainedCount: counts.UNEXPLAINED,
        status,
        syncJobId: input.syncJobId,
        startedAt: input.startedAt,
        finishedAt: input.now,
      },
    })
    const stored = [...report.diffs].sort((a, b) => ORDER[a.category] - ORDER[b.category]).slice(0, MAX_STORED_DIFFS)
    if (stored.length > 0) {
      await tx.connectorParityDiff.createMany({
        data: stored.map(diff => ({
          tenantId: scope.tenantId,
          runId: run.id,
          category: diff.category,
          entityKey: diff.entityKey,
          field: diff.field,
          legacyValue: diff.legacyValue,
          newValue: diff.newValue,
          explanation: diff.explanation,
        })),
      })
    }
    const state = await tx.connectorChannelState.upsert({
      where: { sellerAccountId_domain: { sellerAccountId: scope.sellerAccountId, domain } },
      create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, domain },
      update: {},
    })
    const passes = status === 'PASSED' ? state.consecutivePasses + 1 : status === 'HAS_DIFFS' ? 0 : state.consecutivePasses
    const closed = state.legacyEnabled && passes >= state.requiredPasses
    await tx.connectorChannelState.update({
      where: { id: state.id },
      data: {
        consecutivePasses: passes,
        lastRunAt: input.now,
        ...(closed ? { legacyEnabled: false, closedAt: input.now, closedReason: `连续 ${state.requiredPasses} 次核对没有未解释差异，旧通道已关闭` } : {}),
      },
    })
    return { runId: run.id, status, closed, counts }
  })
}
