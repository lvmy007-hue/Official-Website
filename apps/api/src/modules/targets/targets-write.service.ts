import { Injectable } from '@nestjs/common'
import { TARGET_DIMENSION_LABEL, TARGET_METRIC_LABEL, TargetUpsertBodySchema, type TargetRow } from '@nova/api-contracts'
import type { BusinessTarget, Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { historyEntityId } from './targets-query.service'

const PERMISSION = 'targets.write'
const LABEL = '目标'
type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

// 目标写入（P2a-04，04 章 4.4 动作：编辑目标）：带版本号的创建或更新，同一事务里写审计与变更时间线。
@Injectable()
export class TargetsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async upsert(req: RequestWithContext, rawBody: unknown): Promise<{ row: TargetRow }> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const body = TargetUpsertBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.sellerAccountId)
    const periodStart = new Date(`${body.periodStart}T00:00:00Z`)
    const cellWhere = {
      tenantId: context.tenantId,
      sellerAccountId: body.sellerAccountId,
      periodKind: body.periodKind,
      periodStart,
      dimension: body.dimension,
      dimensionRef: body.dimensionRef,
      metric: body.metric,
    }

    const saved = await this.prisma.$transaction(async tx => {
      const existing = await tx.businessTarget.findFirst({ where: cellWhere })
      const data = { targetValue: body.targetValue.toFixed(6), paceMode: body.paceMode, note: body.note ?? null, updatedBy: context.userId }
      let row: BusinessTarget
      if (!existing) {
        if (body.version !== 0) throw appError('CONFLICT', '该目标单元格已被他人创建，请刷新后查看最新内容', { details: { currentVersion: 0, expectedVersion: body.version } })
        row = await tx.businessTarget.create({ data: { ...cellWhere, ...data } })
      } else {
        row = await updateWithVersion(tx.businessTarget, cellWhere, body.version, data, { label: LABEL })
      }
      await this.audit.record(
        req,
        {
          action: existing ? 'BUSINESS_TARGET_UPDATED' : 'BUSINESS_TARGET_CREATED',
          resourceType: 'BusinessTarget',
          resourceId: row.id,
          before: existing ? { targetValue: num(existing.targetValue), paceMode: existing.paceMode, note: existing.note } : null,
          after: { targetValue: body.targetValue, paceMode: body.paceMode, note: body.note ?? null },
          detail: {
            sellerAccountId: body.sellerAccountId,
            periodKind: body.periodKind,
            periodStart: body.periodStart,
            dimension: body.dimension,
            dimensionRef: body.dimensionRef,
            metric: body.metric,
          },
        },
        { client: tx },
      )
      await tx.entityEvent.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: body.sellerAccountId,
          entityType: 'BUSINESS_TARGET',
          entityId: historyEntityId(body.sellerAccountId, body.periodKind, body.periodStart),
          kind: 'budget',
          occurredAt: new Date(),
          title: historyTitle(body.dimension, body.metric, existing ? num(existing.targetValue) : null, body.targetValue),
          detailJson: { dimension: body.dimension, dimensionRef: body.dimensionRef, metric: body.metric } as Prisma.InputJsonValue,
          actorKind: 'USER',
          actorId: context.userId,
          sourceRef: `${row.id}:${row.version}`,
        },
      })
      return row
    })

    return {
      row: {
        id: saved.id,
        dimension: body.dimension,
        dimensionRef: body.dimensionRef,
        metric: body.metric,
        targetValue: num(saved.targetValue),
        paceMode: body.paceMode,
        note: saved.note,
        version: saved.version,
        updatedAt: saved.updatedAt.toISOString(),
        // 写接口只返回保存后的目标值本身；展示用的操作人名字与达成进度由网格接口刷新后提供。
        updatedBy: context.userId,
        progress: {
          state: 'NOT_SET',
          note: null,
          asOf: null,
          actualToDate: null,
          expectedToDate: null,
          achievementRatio: null,
          elapsedDays: null,
          totalDays: null,
          paceFallback: false,
          forecast: null,
        },
      },
    }
  }
}

function historyTitle(dimension: string, metric: string, before: number | null, after: number): string {
  const dimLabel = TARGET_DIMENSION_LABEL[dimension as keyof typeof TARGET_DIMENSION_LABEL] ?? dimension
  const metricLabel = TARGET_METRIC_LABEL[metric as keyof typeof TARGET_METRIC_LABEL] ?? metric
  return before === null ? `${dimLabel} · 新设 ${metricLabel}目标：${after}` : `${dimLabel} · ${metricLabel}目标：${before} → ${after}`
}
