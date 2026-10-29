import { Injectable } from '@nestjs/common'
import { FEE_CATEGORIES, FEE_EVENTS_RECONCILE, FeeReconcileBodySchema, RECONCILIATION_LABEL, type FeeReconcileResult, type ReconciliationStatus } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { FEE_ENTITY_TYPE, FEE_HISTORY_KIND, FEE_ID_PATTERN } from './fee-events-common'

const labelOf = (status: string) => RECONCILIATION_LABEL[status as ReconciliationStatus] ?? status

// 标记差异与填写对账备注（07 章 7.5 动作）：只改对账状态、备注与操作人，不改金额与分类。带版本号（乐观锁），别人先改了会提示刷新；
// 每次写入审计，并留一条变更记录给“查看证据”的变更历史用。“已对账”由结算交易的三方核对写入（P2b-07），这里不接受手工设置。
@Injectable()
export class FeeEventsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async reconcile(req: RequestWithContext, id: string, rawBody: unknown): Promise<FeeReconcileResult> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, FEE_EVENTS_RECONCILE, {})
    if (!FEE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '费用事件不存在')
    const body = FeeReconcileBodySchema.parse(rawBody)
    const current = await this.prisma.fbaFeeEvent.findFirst({
      where: { id, tenantId: context.tenantId, ...storeWhere(scope), feeCategory: { in: [...FEE_CATEGORIES] } },
      select: { id: true, postedAt: true, sellerAccountId: true, reconciliationStatus: true, reconciliationNote: true },
    })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '费用事件不存在')
    const nextStatus = body.status ?? current.reconciliationStatus
    const nextNote = body.note === undefined ? current.reconciliationNote : body.note || null
    if (nextStatus === current.reconciliationStatus && nextNote === current.reconciliationNote) {
      throw appError('DATA_CONDITION_FAILED', '对账状态与备注都没有变化', { details: { reconciliationStatus: current.reconciliationStatus } })
    }
    const now = new Date()
    const row = await this.prisma.$transaction(async tx => {
      // 分区表的主键含入账时间：带上它让数据库只查一个分区
      const next = await updateWithVersion(
        tx.fbaFeeEvent,
        { id, postedAt: current.postedAt, tenantId: context.tenantId },
        body.version,
        { reconciliationStatus: nextStatus, reconciliationNote: nextNote, reconciledBy: context.userId, reconciledAt: now },
        { label: '费用事件', select: { version: true, reconciliationStatus: true } },
      )
      const changedStatus = nextStatus !== current.reconciliationStatus
      await tx.entityEvent.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: current.sellerAccountId,
          entityType: FEE_ENTITY_TYPE,
          entityId: id,
          kind: FEE_HISTORY_KIND,
          occurredAt: now,
          title: changedStatus ? `对账状态：${labelOf(current.reconciliationStatus)} → ${labelOf(nextStatus)}${nextNote ? `；备注：${nextNote}` : ''}` : `更新对账备注：${nextNote ?? '（已清空）'}`,
          actorKind: 'USER',
          actorId: context.userId,
          sourceRef: `reconcile:${id}:${next.version}`,
        },
      })
      await this.audit.record(
        req,
        {
          action: 'FEE_EVENT_RECONCILED',
          resourceType: 'FbaFeeEvent',
          resourceId: id,
          before: { reconciliationStatus: current.reconciliationStatus, reconciliationNote: current.reconciliationNote },
          after: { reconciliationStatus: nextStatus, reconciliationNote: nextNote },
          reason: nextNote ?? undefined,
        },
        { client: tx },
      )
      return next
    })
    return { id, version: row.version, reconciliationStatus: row.reconciliationStatus as ReconciliationStatus }
  }
}
