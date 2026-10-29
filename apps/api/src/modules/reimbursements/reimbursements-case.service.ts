import { Injectable } from '@nestjs/common'
import {
  CASE_STATUS_LABEL,
  CaseCreateBodySchema,
  CaseUpdateBodySchema,
  OPPORTUNITY_RULE_LABEL,
  OpportunityIgnoreBodySchema,
  OpportunityRestoreBodySchema,
  REIMBURSEMENTS_WRITE,
  isRuleConnected,
  validateCaseUpdate,
  type CaseStatus,
  type CaseUpdateResult,
  type OpportunityRule,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { CASE_SELECT, ID_PATTERN, evidenceOf, isUniqueViolation, newCaseNo } from './reimbursements-common'

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
const label = (status: CaseStatus) => CASE_STATUS_LABEL[status]

// 赔付案件的写操作（07 章 7.3）：从机会生成案件、更新状态与回填亚马逊案件编号、忽略与恢复机会。
// 亚马逊的卖家支持接口不能创建案件：提交在卖家后台完成，这里只记录“已提交”与亚马逊给的案件编号。
// 实收金额与“已到账”只由官方赔付明细匹配产生，接口不接受手填。
@Injectable()
export class ReimbursementsCaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async loadOpportunity(tenantId: string, scope: Parameters<typeof storeWhere>[0], id: string) {
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '赔付机会不存在')
    const row = await this.prisma.reimbursementOpportunity.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '赔付机会不存在')
    return row
  }

  private async assertOwner(tenantId: string, ownerId: string) {
    const member = await this.prisma.membership.findFirst({ where: { tenantId, userId: ownerId, status: 'ACTIVE' }, select: { id: true } })
    if (!member) throw appError('VALIDATION_FAILED', '负责人必须是企业内的在职成员', { fieldErrors: { ownerId: ['负责人必须是企业内的在职成员'] } })
  }

  /** 从一条待处理的机会生成案件：机会转为“已生成案件”，证据引用复制到案件（之后机会变化不影响已建案件）。 */
  async create(req: RequestWithContext, rawBody: unknown): Promise<{ id: string; caseNo: string; version: number }> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_WRITE, {})
    const body = CaseCreateBodySchema.parse(rawBody)
    const opportunity = await this.loadOpportunity(context.tenantId, scope, body.opportunityId)
    const rule = opportunity.ruleCode as OpportunityRule
    if (!isRuleConnected(rule)) throw appError('DATA_CONDITION_FAILED', `“${OPPORTUNITY_RULE_LABEL[rule] ?? rule}”尚未接入，不能生成案件`)
    if (opportunity.status !== 'PENDING')
      throw appError('DATA_CONDITION_FAILED', opportunity.status === 'CASE_CREATED' ? '这条机会已经生成过案件' : '只有“待处理”的机会才能生成案件', { details: { status: opportunity.status } })
    const ownerId = body.ownerId ?? context.userId
    if (ownerId !== context.userId) await this.assertOwner(context.tenantId, ownerId)
    const expected = body.expectedAmount === undefined ? num(opportunity.estimatedAmount) : body.expectedAmount
    const currency = opportunity.currency ?? body.currency ?? null
    if (expected !== null && !currency) throw appError('VALIDATION_FAILED', '填写应收金额时必须同时选择币种', { fieldErrors: { currency: ['该机会没有商品成本，请选择应收金额的币种'] } })
    const evidence = evidenceOf(opportunity.evidenceRefsJson)
    const returnIds = evidence.filter(item => item.kind === 'RETURN').map(item => item.id)
    const now = new Date()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async tx => {
          const claimed = await tx.reimbursementOpportunity.updateMany({
            where: { id: opportunity.id, tenantId: context.tenantId, status: 'PENDING' },
            data: { status: 'CASE_CREATED', version: { increment: 1 } },
          })
          if (claimed.count === 0) throw appError('CONFLICT', '这条机会刚刚被他人处理，请刷新后查看')
          const created = await tx.reimbursementCase.create({
            data: {
              tenantId: context.tenantId,
              sellerAccountId: opportunity.sellerAccountId,
              caseNo: newCaseNo(now),
              opportunityId: opportunity.id,
              ruleCode: opportunity.ruleCode,
              sku: opportunity.sku,
              qty: opportunity.qty,
              expectedAmount: expected,
              currency,
              ownerId,
              deadlineAt: opportunity.deadlineAt,
              evidenceRefsJson: opportunity.evidenceRefsJson as Prisma.InputJsonValue,
              note: body.note || null,
              createdBy: context.userId,
            },
            select: { id: true, caseNo: true, version: true },
          })
          // 退货页（P2b-02）的“赔付状态”列：关联到案件
          if (returnIds.length > 0)
            await tx.fbaReturnCase.updateMany({ where: { id: { in: returnIds }, tenantId: context.tenantId }, data: { reimbursementCaseId: created.id, reimbursementStatus: 'CASE_CREATED' } })
          await tx.entityEvent.create({
            data: {
              tenantId: context.tenantId,
              sellerAccountId: opportunity.sellerAccountId,
              entityType: 'REIMBURSEMENT_CASE',
              entityId: created.id,
              kind: 'reimbursement.status',
              occurredAt: now,
              title: `从“${OPPORTUNITY_RULE_LABEL[rule] ?? rule}”机会生成案件`,
              actorKind: 'USER',
              actorId: context.userId,
              sourceRef: `create:${created.id}`,
            },
          })
          await this.audit.record(
            req,
            {
              action: 'REIMBURSEMENT_CASE_CREATED',
              resourceType: 'ReimbursementCase',
              resourceId: created.id,
              after: { caseNo: created.caseNo, opportunityId: opportunity.id, ruleCode: opportunity.ruleCode, expectedAmount: expected, currency },
            },
            { client: tx },
          )
          return created
        })
      } catch (error) {
        // 案件编号碰撞（5 位随机码）重试；机会已有案件（opportunityId 唯一）是并发重复提交
        const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? '')
        if (isUniqueViolation(error) && attempt < 2 && (target.includes('no_uq') || target.includes('caseNo'))) continue
        if (isUniqueViolation(error)) throw appError('CONFLICT', '这条机会已经生成过案件')
        throw error
      }
    }
    throw appError('CONFLICT', '案件编号生成冲突，请重试')
  }

  /** 更新状态、金额、负责人、备注，回填亚马逊案件编号。带版本号；已到账只能由赔付明细匹配产生。 */
  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<CaseUpdateResult> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_WRITE, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const body = CaseUpdateBodySchema.parse(rawBody)
    const current = await this.prisma.reimbursementCase.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) }, select: CASE_SELECT })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const status = current.status as CaseStatus
    const problem = validateCaseUpdate(
      { status, expectedAmount: num(current.expectedAmount), approvedAmount: num(current.approvedAmount), amazonCaseId: current.amazonCaseId },
      { status: body.status, approvedAmount: body.approvedAmount, expectedAmount: body.expectedAmount },
    )
    if (problem) throw appError('DATA_CONDITION_FAILED', problem, { details: { status } })
    if (body.ownerId && body.ownerId !== current.ownerId) await this.assertOwner(context.tenantId, body.ownerId)
    const nextExpected = body.expectedAmount === undefined ? num(current.expectedAmount) : body.expectedAmount
    const nextCurrency = current.currency ?? body.currency ?? null
    if (nextExpected !== null && !nextCurrency) throw appError('VALIDATION_FAILED', '填写应收金额时必须同时选择币种', { fieldErrors: { currency: ['请选择应收金额的币种'] } })
    // 标记“已提交”时可以不填亚马逊案件编号，之后再回填：编号用来自动匹配赔付，不填则靠 订单与 SKU、SKU 与原因匹配
    const now = new Date()
    const data: Prisma.ReimbursementCaseUncheckedUpdateManyInput = {}
    if (body.status && body.status !== status) {
      data.status = body.status
      if (body.status === 'SUBMITTED') data.submittedAt = now
      if (body.status === 'APPROVED' || body.status === 'PARTIAL' || body.status === 'REJECTED') data.decidedAt = now
    }
    if (body.amazonCaseId !== undefined) data.amazonCaseId = body.amazonCaseId
    if (body.ownerId) data.ownerId = body.ownerId
    if (body.expectedAmount !== undefined) data.expectedAmount = body.expectedAmount
    if (body.approvedAmount !== undefined) data.approvedAmount = body.approvedAmount
    if (nextCurrency !== current.currency) data.currency = nextCurrency
    if (body.note !== undefined) data.note = body.note || null
    const next = await this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.reimbursementCase, { id, tenantId: context.tenantId }, body.version, data, { label: '赔付案件' })
      if (data.status) {
        await tx.entityEvent.create({
          data: {
            tenantId: context.tenantId,
            sellerAccountId: current.sellerAccountId,
            entityType: 'REIMBURSEMENT_CASE',
            entityId: id,
            kind: 'reimbursement.status',
            occurredAt: now,
            title: `案件状态：${label(status)} → ${label(body.status as CaseStatus)}`,
            actorKind: 'USER',
            actorId: context.userId,
            sourceRef: `status:${row.version}`,
          },
        })
      }
      await this.audit.record(
        req,
        {
          action: 'REIMBURSEMENT_CASE_UPDATED',
          resourceType: 'ReimbursementCase',
          resourceId: id,
          before: { status, amazonCaseId: current.amazonCaseId, expectedAmount: num(current.expectedAmount), approvedAmount: num(current.approvedAmount), ownerId: current.ownerId },
          after: { status: row.status, amazonCaseId: row.amazonCaseId, expectedAmount: num(row.expectedAmount), approvedAmount: num(row.approvedAmount), ownerId: row.ownerId },
        },
        { client: tx },
      )
      return row
    })
    return { id, version: next.version, status: next.status as CaseStatus }
  }

  async ignore(req: RequestWithContext, id: string, rawBody: unknown): Promise<{ id: string; version: number; status: 'IGNORED' }> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_WRITE, {})
    const body = OpportunityIgnoreBodySchema.parse(rawBody)
    const opportunity = await this.loadOpportunity(context.tenantId, scope, id)
    if (opportunity.status !== 'PENDING') throw appError('DATA_CONDITION_FAILED', '只有“待处理”的机会可以忽略', { details: { status: opportunity.status } })
    const row = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.reimbursementOpportunity, { id, tenantId: context.tenantId }, body.version, { status: 'IGNORED', note: body.reason }, { label: '赔付机会' })
      await this.audit.record(
        req,
        { action: 'REIMBURSEMENT_OPPORTUNITY_IGNORED', resourceType: 'ReimbursementOpportunity', resourceId: id, after: { reason: body.reason }, reason: body.reason },
        { client: tx },
      )
      return next
    })
    return { id, version: row.version, status: 'IGNORED' }
  }

  async restore(req: RequestWithContext, id: string, rawBody: unknown): Promise<{ id: string; version: number; status: 'PENDING' }> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_WRITE, {})
    const body = OpportunityRestoreBodySchema.parse(rawBody)
    const opportunity = await this.loadOpportunity(context.tenantId, scope, id)
    if (opportunity.status !== 'IGNORED') throw appError('DATA_CONDITION_FAILED', '只有“已忽略”的机会可以恢复', { details: { status: opportunity.status } })
    const row = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.reimbursementOpportunity, { id, tenantId: context.tenantId }, body.version, { status: 'PENDING', note: null }, { label: '赔付机会' })
      await this.audit.record(req, { action: 'REIMBURSEMENT_OPPORTUNITY_RESTORED', resourceType: 'ReimbursementOpportunity', resourceId: id }, { client: tx })
      return next
    })
    return { id, version: row.version, status: 'PENDING' }
  }
}
