import type { PrismaClient } from '@prisma/client'
import { MAX_STORED_DIFFS } from './store'
import { countByCategory, type ParityCategory, type ParityReport } from './types'

// 广告核对记录与旧通道状态（P3-01，A-04）：每个广告档案一行状态，每次核对一行运行记录加若干差异行。
// 关闭规则同订单与财务：连续 requiredPasses 次核对“没有未解释差异”后旧通道关闭（之后不再拉旧版数据，也不再核对）。
// 与订单、财务核对不同：按广告档案记，不要求档案已经绑定店铺（绑定在 P3-03）。

export type AdsParityScope = { tenantId: string; adsProfileId: string }
export type AdsParityStatus = 'PASSED' | 'HAS_DIFFS' | 'LEGACY_UNAVAILABLE'
export type SavedAdsParity = { runId: string; status: AdsParityStatus; closed: boolean; counts: Record<ParityCategory, number> }

const ORDER: Record<ParityCategory, number> = { UNEXPLAINED: 0, SCOPE: 1, ATTRIBUTION_BASIS: 2, TIME_BASIS: 3 }
const dayDate = (day: string) => new Date(`${day}T00:00:00Z`)

export const ensureAdsParityState = (prisma: PrismaClient, scope: AdsParityScope) =>
  prisma.adsParityState.upsert({ where: { adsProfileId: scope.adsProfileId }, create: { tenantId: scope.tenantId, adsProfileId: scope.adsProfileId }, update: {} })

export async function saveAdsParityRun(
  prisma: PrismaClient,
  scope: AdsParityScope,
  input: { window: { from: string; to: string }; report: ParityReport | null; warningCount: number; startedAt: Date; now: Date },
): Promise<SavedAdsParity> {
  const report = input.report ?? { legacyCount: 0, newCount: 0, matchedCount: 0, diffs: [] }
  const counts = countByCategory(report.diffs)
  const status: AdsParityStatus = input.report === null ? 'LEGACY_UNAVAILABLE' : counts.UNEXPLAINED === 0 ? 'PASSED' : 'HAS_DIFFS'
  return prisma.$transaction(async tx => {
    const run = await tx.adsParityRun.create({
      data: {
        tenantId: scope.tenantId,
        adsProfileId: scope.adsProfileId,
        windowStart: dayDate(input.window.from),
        windowEnd: dayDate(input.window.to),
        legacyCount: report.legacyCount,
        newCount: report.newCount,
        matchedCount: report.matchedCount,
        unexplainedCount: counts.UNEXPLAINED,
        warningCount: input.warningCount,
        status,
        startedAt: input.startedAt,
        finishedAt: input.now,
      },
    })
    const stored = [...report.diffs].sort((a, b) => ORDER[a.category] - ORDER[b.category]).slice(0, MAX_STORED_DIFFS)
    if (stored.length > 0) {
      await tx.adsParityDiff.createMany({
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
    const state = await ensureAdsParityState(tx as unknown as PrismaClient, scope)
    const passes = status === 'PASSED' ? state.consecutivePasses + 1 : status === 'HAS_DIFFS' ? 0 : state.consecutivePasses
    const closed = state.legacyEnabled && passes >= state.requiredPasses
    await tx.adsParityState.update({
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
