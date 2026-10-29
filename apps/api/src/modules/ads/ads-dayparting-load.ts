import {
  ADS_CONSOLE_CURRENCY,
  DAYPARTING_HISTORY_DAYS,
  DAYPARTING_RUN_LIMIT,
  DAYPARTING_STRATEGY_LIMIT,
  buildHourlyCells,
  type AdsHourlyCell,
  type DaypartingLevel,
  type DaypartingProfileOption,
  type DaypartingRunOutcome,
  type DaypartingRunRow,
} from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { adsProfileWhere, adsRelationWhere } from '../auth'
import { num } from './ads-campaigns-common'
import { totalsOf, type AdsLoadContext } from './ads-overview-load'
import { hourlyByHour } from './ads-today-load'
import { levelOf, STRATEGY_SELECT, targetNames, type StrategyRecord } from './ads-dayparting-common'

// 分时策略页的读取（P3-12）：热力图用的小时格、策略列表、执行记录、可选的广告账户。租户条件与数据范围显式带上，行级安全同时生效。

const DAY_MS = 86_400_000
const HARD_LIMIT = 20_000

/** 热力图：范围内全部活动（美元，活动级）最近 14 天的小时指标，按企业时区归到“星期 × 小时”。营销数据流接收端没配置时调用方不要调用。 */
export async function heatmapCells(prisma: PrismaService, ctx: AdsLoadContext, zone: string, now: Date): Promise<AdsHourlyCell[]> {
  const byHour = await hourlyByHour(prisma, ctx, new Date(now.getTime() - DAYPARTING_HISTORY_DAYS * DAY_MS), now)
  return buildHourlyCells(
    [...byHour.entries()].map(([hourStart, totals]) => ({ hourStart: new Date(hourStart), clicks: totals.clicks, orders: totals.orders, spend: totals.spend, sales: totals.sales })),
    zone,
  )
}

/** 策略的作用对象在最近 14 天的小时格（美元；对象类型与档案、外部编号都要对上）。 */
export async function strategyCells(
  prisma: PrismaService,
  ctx: AdsLoadContext,
  input: { adsProfileId: string; level: DaypartingLevel; externalIds: readonly string[]; zone: string; now: Date },
): Promise<AdsHourlyCell[]> {
  if (input.externalIds.length === 0) return []
  const groups = await prisma.adsPerformanceHourly.groupBy({
    by: ['hourStart'],
    where: {
      tenantId: ctx.tenantId,
      ...adsRelationWhere(ctx.scope),
      adsProfileId: input.adsProfileId,
      entityType: input.level,
      entityId: { in: [...input.externalIds] },
      currency: ADS_CONSOLE_CURRENCY,
      hourStart: { gte: new Date(input.now.getTime() - DAYPARTING_HISTORY_DAYS * DAY_MS), lt: input.now },
    },
    _sum: { impressions: true, clicks: true, spend: true, sales: true, orders: true },
    orderBy: { hourStart: 'asc' },
    take: HARD_LIMIT,
  })
  return buildHourlyCells(
    groups.map(group => {
      const totals = totalsOf(group._sum)
      return { hourStart: group.hourStart, clicks: totals.clicks, orders: totals.orders, spend: totals.spend, sales: totals.sales }
    }),
    input.zone,
  )
}

/** 可见范围内的策略，名称升序；多读一个判断是否被截断。 */
export async function loadStrategies(prisma: PrismaService, ctx: AdsLoadContext): Promise<{ records: StrategyRecord[]; truncated: boolean }> {
  const found = await prisma.daypartingStrategy.findMany({
    where: { tenantId: ctx.tenantId, ...adsRelationWhere(ctx.scope) },
    select: STRATEGY_SELECT,
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: DAYPARTING_STRATEGY_LIMIT + 1,
  })
  return { records: found.slice(0, DAYPARTING_STRATEGY_LIMIT), truncated: found.length > DAYPARTING_STRATEGY_LIMIT }
}

/** 最近的执行记录（最新在前），对象名称按策略的作用对象粒度解析。 */
export async function loadRuns(prisma: PrismaService, ctx: AdsLoadContext): Promise<DaypartingRunRow[]> {
  const rows = await prisma.daypartingRun.findMany({
    where: { tenantId: ctx.tenantId, strategy: adsRelationWhere(ctx.scope) },
    select: {
      id: true,
      strategyId: true,
      entityId: true,
      hour: true,
      appliedMultiplier: true,
      executed: true,
      outcome: true,
      message: true,
      runAt: true,
      strategy: { select: { name: true, targetLevel: true } },
    },
    orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
    take: DAYPARTING_RUN_LIMIT,
  })
  const names = await targetNames(
    prisma,
    ctx.tenantId,
    (['CAMPAIGN', 'AD_GROUP'] as const).map(level => ({ level, ids: rows.filter(row => levelOf(row.strategy.targetLevel) === level).map(row => row.entityId) })),
  )
  return rows.map(row => ({
    id: row.id,
    strategyId: row.strategyId,
    strategyName: row.strategy.name,
    entityId: row.entityId,
    entityName: names.get(row.entityId) ?? null,
    hour: row.hour,
    appliedMultiplier: num(row.appliedMultiplier) ?? 0,
    executed: row.executed,
    outcome: row.outcome as DaypartingRunOutcome,
    message: row.message,
    runAt: row.runAt.toISOString(),
  }))
}

/** 创建策略时可选的广告账户（范围内的广告档案）。 */
export async function loadProfiles(prisma: PrismaService, ctx: AdsLoadContext): Promise<DaypartingProfileOption[]> {
  const rows = await prisma.adsProfile.findMany({
    where: { tenantId: ctx.tenantId, ...adsProfileWhere(ctx.scope) },
    select: { id: true, displayName: true, profileId: true, timezone: true, sellerAccount: { select: { displayName: true } } },
    orderBy: [{ profileId: 'asc' }, { id: 'asc' }],
    take: 200,
  })
  return rows.map(row => ({ id: row.id, name: row.displayName ?? row.profileId, storeName: row.sellerAccount?.displayName ?? null, timezone: row.timezone }))
}
