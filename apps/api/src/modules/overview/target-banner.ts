import type { KpiTargetBanner } from '@nova/api-contracts'
import { STORE_DIMENSION_REF } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { achievementRatioOf, elapsedDaysOf, linearRatio, totalDaysOf } from '../targets'
import { monthEnd, monthStart } from './period'
import { storeValues } from './summary-queries'

// 目标达成进度横幅（P2a-04 消费方：经营控制台，04 章 4.1 第 2 项）。
// 范围：只统计范围内已设置“当月整店销售额目标”的店铺；查询区间跨自然月时无法归到唯一一个月的目标，不计算。
const NOTE_CROSS_MONTH = '所选时间范围跨越多个自然月，暂不计算目标达成进度（需单一自然月内）'
const NOTE_NO_TARGET = '所选范围内还没有店铺设置当月整店销售额目标'

type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

function coverageNote(storesCovered: number, storesTotal: number): string | null {
  if (storesCovered >= storesTotal) return null
  return `范围内 ${storesTotal} 个店铺中有 ${storesCovered} 个已设置目标，达成率只统计这些店铺`
}

/** 计算经营控制台首行的目标达成横幅；查询区间必须落在单一自然月内才能定位到对应的月度目标。 */
export async function targetBanner(prisma: PrismaService, tenantId: string, scope: ResolvedScope, period: { from: string; to: string }): Promise<KpiTargetBanner> {
  if (period.from.slice(0, 7) !== period.to.slice(0, 7)) return { state: 'NOT_CONNECTED', note: NOTE_CROSS_MONTH }
  const periodStart = monthStart(period.from)
  const periodEnd = monthEnd(period.from)

  const targets = await prisma.businessTarget.findMany({
    where: {
      tenantId,
      periodKind: 'MONTH',
      periodStart: new Date(`${periodStart}T00:00:00Z`),
      dimension: 'STORE',
      dimensionRef: STORE_DIMENSION_REF,
      metric: 'SALES',
      ...storeWhere(scope),
    },
    select: { sellerAccountId: true, targetValue: true },
  })
  if (targets.length === 0) return { state: 'NOT_CONNECTED', note: NOTE_NO_TARGET }

  const coveredIds = targets.map(row => row.sellerAccountId)
  const targetValue = targets.reduce((sum, row) => sum + (num(row.targetValue) ?? 0), 0)
  const storesTotal = scope.unrestricted ? (await prisma.sellerAccount.findMany({ where: { tenantId }, select: { id: true } })).length : scope.sellerAccountIds.length

  const dailyByStore = await storeValues(prisma, { tenantId, scope }, periodStart, period.to)
  const actualValue = coveredIds.reduce((sum, id) => sum + (dailyByStore.get(id)?.sales ?? 0), 0)

  const elapsedDays = elapsedDaysOf('MONTH', periodStart, period.to)
  const totalDays = totalDaysOf('MONTH', periodStart)

  return {
    state: 'OK',
    note: coverageNote(coveredIds.length, storesTotal),
    metric: 'sales',
    periodStart,
    periodEnd,
    targetValue,
    actualValue,
    achievementRatio: achievementRatioOf(actualValue, targetValue),
    expectedToDateRatio: linearRatio(elapsedDays, totalDays),
    storesCovered: coveredIds.length,
    storesTotal,
  }
}
