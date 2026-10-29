import { Injectable } from '@nestjs/common'
import { ALLOCATION_RULE_ACTIONS, ALLOCATION_RULE_WRITE, AllocationRuleCreateBodySchema, AllocationRuleUpdateBodySchema, monthStartDate, monthText, type AllocationRuleRow } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { loadFeeItems, lockedMonths, requireFeeItem, ruleRow, toWeights } from './allocation-rules-common'

const LOCKED_MESSAGE = (month: string) => `${month} 所在的期间已关账，规则不会对已关账的数字生效；请先在关账页重开该期间，再修改规则`
const RECOMPUTE_NOTE = '新规则在利润日表下一次重算（每 6 小时近 45 天）后生效；已关账的月份不重算。'

/**
 * 费用分摊规则的新建与修改（P6-19）。需要 finance.policy.write；已关账月份的规则不能新建或修改（要先重开关账）。
 * 冻结稿写“修改走审批”，审批流（ApprovalRequest）在后续工作包交付；本包先直接生效并写审计，见 CR-128。
 */
@Injectable()
export class AllocationRulesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async view(tenantId: string, userId: string | null, record: Parameters<typeof ruleRow>[0], now: Date): Promise<AllocationRuleRow> {
    const items = await loadFeeItems(this.prisma, tenantId, userId, now)
    const item = items.find(candidate => candidate.id === record.feeItemId)
    const locked = await lockedMonths(this.prisma, tenantId, [monthText(record.effectiveMonth)])
    return ruleRow(record, item, locked.has(monthText(record.effectiveMonth)))
  }

  async create(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<{ rule: AllocationRuleRow; recomputeNote: string }> {
    const context = await this.context.authorize(req, ALLOCATION_RULE_WRITE)
    const body = AllocationRuleCreateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    await requireFeeItem(this.prisma, tenantId, context.userId, body.feeItemId, now)
    if ((await lockedMonths(this.prisma, tenantId, [body.effectiveMonth])).has(body.effectiveMonth)) throw appError('DATA_CONDITION_FAILED', LOCKED_MESSAGE(body.effectiveMonth))
    const record = await this.prisma.$transaction(async tx => {
      const exists = await tx.allocationRule.findFirst({ where: { tenantId, feeItemId: body.feeItemId, effectiveMonth: monthStartDate(body.effectiveMonth) }, select: { id: true } })
      if (exists) throw appError('CONFLICT', `这个费用项在 ${body.effectiveMonth} 已经有一条规则，请直接修改它`)
      const created = await tx.allocationRule.create({
        data: {
          tenantId,
          feeItemId: body.feeItemId,
          basis: body.basis,
          manualWeights: body.basis === 'MANUAL' ? (body.manualWeights as Prisma.InputJsonObject) : Prisma.DbNull,
          effectiveMonth: monthStartDate(body.effectiveMonth),
          createdBy: context.userId,
        },
      })
      await this.audit.record(
        req,
        {
          action: ALLOCATION_RULE_ACTIONS.created,
          resourceType: 'AllocationRule',
          resourceId: created.id,
          before: null,
          after: { feeItemId: body.feeItemId, basis: body.basis, effectiveMonth: body.effectiveMonth, skuCount: body.manualWeights ? Object.keys(body.manualWeights).length : 0 },
        },
        { client: tx },
      )
      return created
    })
    return { rule: await this.view(tenantId, context.userId, record, now), recomputeNote: RECOMPUTE_NOTE }
  }

  async update(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<{ rule: AllocationRuleRow; recomputeNote: string }> {
    const context = await this.context.authorize(req, ALLOCATION_RULE_WRITE)
    const body = AllocationRuleUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const before = await this.prisma.allocationRule.findFirst({ where: { id: body.id, tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '分摊规则不存在')
    const month = monthText(before.effectiveMonth)
    if ((await lockedMonths(this.prisma, tenantId, [month])).has(month)) throw appError('DATA_CONDITION_FAILED', LOCKED_MESSAGE(month))
    const record = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(
        tx.allocationRule,
        { id: body.id, tenantId },
        body.version,
        { basis: body.basis, manualWeights: body.basis === 'MANUAL' ? (body.manualWeights as Prisma.InputJsonObject) : Prisma.DbNull },
        { label: '分摊规则' },
      )
      await this.audit.record(
        req,
        {
          action: ALLOCATION_RULE_ACTIONS.updated,
          resourceType: 'AllocationRule',
          resourceId: body.id,
          before: { basis: before.basis, version: before.version, skuCount: Object.keys(toWeights(before.manualWeights) ?? {}).length },
          after: { basis: next.basis, version: next.version, skuCount: body.manualWeights ? Object.keys(body.manualWeights).length : 0 },
        },
        { client: tx },
      )
      return next
    })
    return { rule: await this.view(tenantId, context.userId, record, now), recomputeNote: RECOMPUTE_NOTE }
  }
}
