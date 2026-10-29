import { Injectable } from '@nestjs/common'
import {
  STORE_DIMENSION_REF,
  TARGET_METRICS,
  TARGET_METRIC_LABEL,
  TargetHistoryQuerySchema,
  TargetListQuerySchema,
  type TargetDimension,
  type TargetGridResponse,
  type TargetHistoryItem,
  type TargetHistoryResponse,
  type TargetMetric,
  type TargetPaceMode,
  type TargetRow,
} from '@nova/api-contracts'
import type { BusinessTarget } from '@prisma/client'
import { ApiContext, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { assertStoreInScope, ContextService, type ResolvedScope } from '../auth'
import { addDays, todayIn, validZone } from '../overview'
import { periodEndExclusive } from './targets-math'
import { computeProgress } from './targets-progress'

const PERMISSION = 'targets.read'
type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

/** 目标网格与变更历史（P2a-04，04 章 4.4）：读接口，只读校验 targets.read，且店铺必须在成员的数据范围内。 */
@Injectable()
export class TargetsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  // 权限检查必须先于参数校验（无权限的人看不到校验细节），所以这里先只认证权限，拿到 scope 后再解析查询参数、再校验店铺范围。
  private async authorize(req: RequestWithContext): Promise<{ context: ApiContext; scope: ResolvedScope }> {
    return this.context.authorizeScoped(req, PERMISSION, {})
  }

  private async asOfFor(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    return todayIn(validZone(tenant?.timezone))
  }

  private toRow(row: BusinessTarget | null, dimension: TargetDimension, dimensionRef: string, metric: TargetMetric, names: ReadonlyMap<string, string>) {
    return {
      id: row?.id ?? null,
      dimension,
      dimensionRef,
      metric,
      targetValue: row ? num(row.targetValue) : null,
      paceMode: (row?.paceMode ?? 'LINEAR') as TargetPaceMode,
      note: row?.note ?? null,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ? nameOrFormer(names, row.updatedBy) : null,
    }
  }

  async grid(req: RequestWithContext, rawQuery: unknown): Promise<TargetGridResponse> {
    const { context, scope } = await this.authorize(req)
    const query = TargetListQuerySchema.parse(rawQuery)
    assertStoreInScope(scope, query.sellerAccountId)
    const asOf = await this.asOfFor(context.tenantId)
    const where = { tenantId: context.tenantId, sellerAccountId: query.sellerAccountId, periodKind: query.periodKind, periodStart: new Date(`${query.periodStart}T00:00:00Z`) }
    const rows = await this.prisma.businessTarget.findMany({ where })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.updatedBy),
    )

    const storeRows: TargetRow[] = await Promise.all(
      TARGET_METRICS.map(async metric => {
        const row = rows.find(item => item.dimension === 'STORE' && item.metric === metric) ?? null
        const base = this.toRow(row, 'STORE', STORE_DIMENSION_REF, metric, names)
        const progress = await computeProgress(this.prisma, {
          tenantId: context.tenantId,
          sellerAccountId: query.sellerAccountId,
          dimension: 'STORE',
          dimensionRef: STORE_DIMENSION_REF,
          metric,
          periodKind: query.periodKind,
          periodStart: query.periodStart,
          asOf,
          targetValue: base.targetValue,
          paceMode: base.paceMode,
          permissions: context.permissions,
        })
        return { ...base, progress }
      }),
    )

    const customRows: TargetRow[] = await Promise.all(
      rows
        .filter(row => row.dimension !== 'STORE')
        .map(async row => {
          const dimension = row.dimension as TargetDimension
          const metric = row.metric as TargetMetric
          const base = this.toRow(row, dimension, row.dimensionRef, metric, names)
          const progress = await computeProgress(this.prisma, {
            tenantId: context.tenantId,
            sellerAccountId: query.sellerAccountId,
            dimension,
            dimensionRef: row.dimensionRef,
            metric,
            periodKind: query.periodKind,
            periodStart: query.periodStart,
            asOf,
            targetValue: base.targetValue,
            paceMode: base.paceMode,
            permissions: context.permissions,
          })
          return { ...base, progress }
        }),
    )

    return {
      sellerAccountId: query.sellerAccountId,
      periodKind: query.periodKind,
      periodStart: query.periodStart,
      periodEnd: addDays(periodEndExclusive(query.periodKind, query.periodStart).toISOString().slice(0, 10), -1),
      currency: 'USD',
      storeRows,
      customRows,
      metrics: TARGET_METRICS.map(key => ({ key, label: TARGET_METRIC_LABEL[key] })),
    }
  }

  async history(req: RequestWithContext, rawQuery: unknown): Promise<TargetHistoryResponse> {
    const { context, scope } = await this.authorize(req)
    const query = TargetHistoryQuerySchema.parse(rawQuery)
    assertStoreInScope(scope, query.sellerAccountId)
    const entityId = historyEntityId(query.sellerAccountId, query.periodKind, query.periodStart)
    const events = await this.prisma.entityEvent.findMany({
      where: { tenantId: context.tenantId, entityType: 'BUSINESS_TARGET', entityId },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      events.map(event => event.actorId),
    )
    const items: TargetHistoryItem[] = events.map(event => {
      const detail = (event.detailJson ?? {}) as { dimension?: string; dimensionRef?: string; metric?: string }
      return {
        id: event.id,
        at: event.occurredAt.toISOString(),
        dimension: (detail.dimension ?? 'STORE') as TargetDimension,
        dimensionRef: detail.dimensionRef ?? STORE_DIMENSION_REF,
        metric: (detail.metric ?? 'SALES') as TargetMetric,
        title: event.title,
        actor: event.actorId ? nameOrFormer(names, event.actorId) : null,
      }
    })
    return { items }
  }
}

/** 变更历史的 entityId：按店铺 + 期间聚合（同一店铺同一期间的全部目标改动共用一条时间线）。 */
export function historyEntityId(sellerAccountId: string, periodKind: string, periodStart: string): string {
  return `${sellerAccountId}:${periodKind}:${periodStart}`
}
