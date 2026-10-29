import { Injectable } from '@nestjs/common'
import {
  ESTIMATED_FEE_ACTIONS,
  ESTIMATED_FEE_CURRENCY,
  ESTIMATED_FEE_LIMITS,
  ESTIMATED_FEE_RECOMPUTE_NOTE,
  ESTIMATED_FEE_WRITE,
  EstimatedFeeCreateBodySchema,
  EstimatedFeeDeleteQuerySchema,
  EstimatedFeeUpdateBodySchema,
  type EstimatedFeeCreateBody,
  type EstimatedFeeDeleteResult,
  type EstimatedFeeMutationResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { assertUnrestricted, ContextService } from '../auth'
import { assertScopeExists, dayDate, feeAudit, feeRow, findOverlap, overlapMessage, requireCostItem } from './estimated-fees-common'

/**
 * 预估费用规则的新建、修改与删除（P6-20）。需要 finance.estimatedfee.write 与“全部店铺”数据范围（规则可以覆盖 SKU、品类，影响所有店铺的利润）。
 * 修改用乐观锁，每次变更写审计；生效区间重叠返回 409。冻结稿写“大额预估走审批”，审批流在后续工作包交付，本包先直接生效，见 CR-129。
 */
@Injectable()
export class EstimatedFeesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private data(body: EstimatedFeeCreateBody) {
    return {
      itemId: body.itemId,
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      mode: body.mode,
      value: body.value,
      currency: ESTIMATED_FEE_CURRENCY,
      period: body.mode === 'PERCENT_OF_SALES' ? 'DAILY' : body.period,
      from: dayDate(body.from),
      to: body.to ? dayDate(body.to) : null,
      status: body.status,
      note: body.note ? body.note : null,
    }
  }

  private async authorizeWrite(req: RequestWithContext) {
    const { context, scope } = await this.context.authorizeScoped(req, ESTIMATED_FEE_WRITE, {})
    assertUnrestricted(scope)
    return context
  }

  private async view(tenantId: string, userId: string | null, record: Parameters<typeof feeRow>[0], now: Date) {
    const item = await requireCostItem(this.prisma, tenantId, userId, record.itemId, now).catch(() => undefined)
    const store = record.scopeType === 'STORE' ? await this.prisma.sellerAccount.findFirst({ where: { id: record.scopeId, tenantId }, select: { id: true, displayName: true } }) : null
    return feeRow(record, item, new Map(store ? [[store.id, store.displayName]] : []))
  }

  async create(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<EstimatedFeeMutationResult> {
    const context = await this.authorizeWrite(req)
    const body = EstimatedFeeCreateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    await requireCostItem(this.prisma, tenantId, context.userId, body.itemId, now)
    await assertScopeExists(this.prisma, tenantId, body.scopeType, body.scopeId)
    const record = await this.prisma.$transaction(async tx => {
      if ((await tx.estimatedFee.count({ where: { tenantId } })) >= ESTIMATED_FEE_LIMITS.tenantMax)
        throw appError('DATA_CONDITION_FAILED', `预估费用规则最多 ${ESTIMATED_FEE_LIMITS.tenantMax} 条，请先清理停用的规则`)
      const hit = await findOverlap(tx, tenantId, body, null)
      if (hit) throw appError('CONFLICT', overlapMessage(hit), { details: { conflictId: hit.id } })
      const created = await tx.estimatedFee.create({ data: { tenantId, ...this.data(body), createdBy: context.userId } })
      await this.audit.record(req, { action: ESTIMATED_FEE_ACTIONS.created, resourceType: 'EstimatedFee', resourceId: created.id, before: null, after: feeAudit(created) }, { client: tx })
      return created
    })
    return { row: await this.view(tenantId, context.userId, record, now), recomputeNote: ESTIMATED_FEE_RECOMPUTE_NOTE }
  }

  async update(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<EstimatedFeeMutationResult> {
    const context = await this.authorizeWrite(req)
    const body = EstimatedFeeUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const before = await this.prisma.estimatedFee.findFirst({ where: { id: body.id, tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '预估费用规则不存在')
    await requireCostItem(this.prisma, tenantId, context.userId, body.itemId, now)
    await assertScopeExists(this.prisma, tenantId, body.scopeType, body.scopeId)
    const record = await this.prisma.$transaction(async tx => {
      const hit = await findOverlap(tx, tenantId, body, body.id)
      if (hit) throw appError('CONFLICT', overlapMessage(hit), { details: { conflictId: hit.id } })
      const next = await updateWithVersion(tx.estimatedFee, { id: body.id, tenantId }, body.version, this.data(body), { label: '预估费用规则' })
      await this.audit.record(req, { action: ESTIMATED_FEE_ACTIONS.updated, resourceType: 'EstimatedFee', resourceId: body.id, before: feeAudit(before), after: feeAudit(next) }, { client: tx })
      return next
    })
    return { row: await this.view(tenantId, context.userId, record, now), recomputeNote: ESTIMATED_FEE_RECOMPUTE_NOTE }
  }

  async remove(req: RequestWithContext, rawQuery: Record<string, string>): Promise<EstimatedFeeDeleteResult> {
    const context = await this.authorizeWrite(req)
    const query = EstimatedFeeDeleteQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    await this.prisma.$transaction(async tx => {
      const before = await tx.estimatedFee.findFirst({ where: { id: query.id, tenantId } })
      if (!before) throw appError('RESOURCE_NOT_FOUND', '预估费用规则不存在')
      const removed = await tx.estimatedFee.deleteMany({ where: { id: query.id, tenantId, version: query.version } })
      if (removed.count === 0) throw appError('CONFLICT', '预估费用规则已被他人修改，请刷新后再决定是否删除', { details: { currentVersion: before.version, expectedVersion: query.version } })
      await this.audit.record(req, { action: ESTIMATED_FEE_ACTIONS.deleted, resourceType: 'EstimatedFee', resourceId: query.id, before: feeAudit(before), after: null }, { client: tx })
    })
    return { id: query.id, recomputeNote: ESTIMATED_FEE_RECOMPUTE_NOTE }
  }
}
