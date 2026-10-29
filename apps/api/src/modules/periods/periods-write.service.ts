import { Injectable } from '@nestjs/common'
import {
  PERIOD_CLOSE,
  PERIOD_MONTH_LIMIT_YEARS,
  PERIOD_STATUS_LABEL,
  PeriodApproveBodySchema,
  PeriodCheckBodySchema,
  PeriodCreateBodySchema,
  buildChecklist,
  earliestMonth,
  monthPeriodOf,
  needlessAcknowledgements,
  periodEnded,
  statusAfterCheck,
  statusAfterReject,
  type PeriodCheckResult,
  type PeriodMutationResult,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ApprovalsRegistryService } from '../approval-registry'
import { assertStoreInScope, ContextService } from '../auth'
import { todayIn } from '../overview'
import { actionsFor, bounds, checklistOf, checklistView, loadPeriod, requireAllowed, statusOf, tenantZone } from './periods-common'
import { gatherEvals } from './periods-evidence'

const LABEL = '关账期间'
const RESULT = { id: true, version: true, status: true } as const
const mutation = (row: { id: string; version: number; status: string }): PeriodMutationResult => ({
  id: row.id,
  version: row.version,
  status: statusOf(row.status),
  statusLabel: PERIOD_STATUS_LABEL[statusOf(row.status)],
})

// 期间关账的写入（07 章 7.12）：创建期间、完整性检查、审批。锁定与重新开账在 periods-close.service.ts。
// 每个写入都先查权限再校验参数；改状态一律带版本号（乐观锁）并在同一个事务里写审计。
@Injectable()
export class PeriodsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly approvals: ApprovalsRegistryService,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown): Promise<PeriodMutationResult> {
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_CLOSE, {})
    const body = PeriodCreateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    assertStoreInScope(scope, body.sellerAccountId)
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.sellerAccountId, tenantId }, select: { id: true, displayName: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    const month = monthPeriodOf(body.month)
    if (!month) throw appError('VALIDATION_FAILED', '月份格式应为 YYYY-MM', { fieldErrors: { month: ['月份格式应为 YYYY-MM'] } })
    const today = todayIn(await tenantZone(this.prisma, tenantId))
    // 期间必须已经结束（按企业口径时区），否则数据还在产生，关账没有意义
    if (!periodEnded(month.end, today)) throw appError('VALIDATION_FAILED', '这个月份还没有结束，不能创建关账期间', { fieldErrors: { month: ['还没有结束的月份不能关账'] } })
    if (body.month < earliestMonth(today, PERIOD_MONTH_LIMIT_YEARS)) {
      throw appError('VALIDATION_FAILED', `只能创建最近 ${PERIOD_MONTH_LIMIT_YEARS} 年内的期间`, { fieldErrors: { month: ['月份太早'] } })
    }
    const saved = await this.prisma
      .$transaction(async tx => {
        const row = await tx.accountingPeriod.create({
          data: { tenantId, sellerAccountId: store.id, periodStart: new Date(`${month.start}T00:00:00Z`), periodEnd: new Date(`${month.end}T00:00:00Z`), createdBy: context.userId },
          select: RESULT,
        })
        await this.audit.record(
          req,
          {
            action: 'PERIOD_CREATED',
            resourceType: 'AccountingPeriod',
            resourceId: row.id,
            after: { sellerAccountId: store.id, storeName: store.displayName, month: body.month, periodStart: month.start, periodEnd: month.end },
          },
          { client: tx },
        )
        return row
      })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === 'P2002') throw appError('CONFLICT', `${store.displayName} ${body.month} 的关账期间已经存在，请到列表里打开`)
        throw error
      })
    return mutation(saved)
  }

  async check(req: RequestWithContext, id: string, rawBody: unknown): Promise<PeriodCheckResult> {
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_CLOSE, {})
    const body = PeriodCheckBodySchema.parse(rawBody ?? {})
    const tenantId = context.tenantId
    const row = await loadPeriod(this.prisma, tenantId, scope, id)
    requireAllowed(actionsFor(row, context.userId, context.permissions), 'check')
    const { start, end } = bounds(row)
    const evals = await gatherEvals(this.prisma, { tenantId, sellerAccountId: row.sellerAccountId, start, end, zone: await tenantZone(this.prisma, tenantId) })
    const requests = body.acknowledgements ?? []
    const needless = needlessAcknowledgements(evals, requests)
    if (needless.length > 0) throw appError('VALIDATION_FAILED', '只有没通过的检查项才需要确认放行', { fieldErrors: { acknowledgements: [`这些检查项已通过，不需要确认：${needless.join('、')}`] } })

    const now = new Date()
    const checklist = buildChecklist(evals, checklistOf(row.checklistJson), requests, context.userId, now)
    const status = statusAfterCheck(checklist.passed, row.closeCount)
    const saved = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(
        tx.accountingPeriod,
        { id, tenantId },
        row.version,
        {
          status,
          checklistJson: checklist as unknown as Prisma.InputJsonValue,
          checkedBy: context.userId,
          checkedAt: now,
          approvalDecision: null,
          approvedBy: null,
          approvedAt: null,
          approvalComment: null,
        },
        { label: LABEL, select: RESULT },
      )
      await this.audit.record(
        req,
        {
          action: 'PERIOD_CHECKED',
          resourceType: 'AccountingPeriod',
          resourceId: id,
          before: { status: row.status },
          after: { status, passed: checklist.passed, states: Object.fromEntries(checklist.items.map(item => [item.key, item.state])) },
          detail: { acknowledged: checklist.items.filter(item => item.state === 'ACKNOWLEDGED').map(item => ({ key: item.key, note: item.acknowledgement?.note, value: item.value })) },
        },
        { client: tx },
      )
      // P6-27：检查通过 → 登记待审批；再次检查没通过 → 作废之前待处理的审批（需要重新检查）
      const { start: periodStart, end: periodEnd } = bounds(row)
      const target = { tenantId, type: 'PERIOD_CLOSE', objectType: 'AccountingPeriod', objectId: id } as const
      if (status === 'CLOSING') {
        await this.approvals.register(tx, {
          ...target,
          title: `${row.sellerAccount.displayName} ${periodStart.slice(0, 7)} 关账审批`,
          summary: [
            { label: '店铺', value: row.sellerAccount.displayName },
            { label: '期间', value: `${periodStart} 至 ${periodEnd}` },
            { label: '完整性检查', value: '已通过' },
            ...(checklist.items.some(item => item.state === 'ACKNOWLEDGED')
              ? [
                  {
                    label: '确认放行的检查项',
                    value: checklist.items
                      .filter(item => item.state === 'ACKNOWLEDGED')
                      .map(item => item.key)
                      .join('、'),
                  },
                ]
              : []),
          ],
          requesterId: context.userId,
          approverPermission: PERIOD_CLOSE,
        })
      } else {
        await this.approvals.resolve(tx, { ...target, outcome: 'CANCELLED', userId: context.userId, comment: '重新检查没有通过，原审批作废', now })
      }
      return next
    })
    const names = await memberNames(
      this.prisma,
      tenantId,
      checklist.items.map(item => item.acknowledgement?.by),
    )
    return { ...mutation(saved), passed: checklist.passed, checklist: checklistView(checklist, names) ?? checklist }
  }

  async approve(req: RequestWithContext, id: string, rawBody: unknown): Promise<PeriodMutationResult> {
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_CLOSE, {})
    const body = PeriodApproveBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const row = await loadPeriod(this.prisma, tenantId, scope, id)
    requireAllowed(actionsFor(row, context.userId, context.permissions), 'approve')
    const approved = body.decision === 'APPROVED'
    const now = new Date()
    const status = approved ? statusOf(row.status) : statusAfterReject(row.closeCount)
    const saved = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(
        tx.accountingPeriod,
        { id, tenantId },
        body.version,
        { status, approvalDecision: body.decision, approvedBy: context.userId, approvedAt: now, approvalComment: body.comment || null },
        { label: LABEL, select: RESULT },
      )
      await this.audit.record(
        req,
        {
          action: approved ? 'PERIOD_APPROVED' : 'PERIOD_REJECTED',
          resourceType: 'AccountingPeriod',
          resourceId: id,
          before: { status: row.status, checkedBy: row.checkedBy },
          after: { status, decision: body.decision },
          reason: body.comment || undefined,
        },
        { client: tx },
      )
      // P6-27：回写审批收件箱
      await this.approvals.resolve(tx, {
        tenantId,
        type: 'PERIOD_CLOSE',
        objectType: 'AccountingPeriod',
        objectId: id,
        outcome: approved ? 'APPROVED' : 'REJECTED',
        userId: context.userId,
        comment: body.comment,
        now,
      })
      return next
    })
    return mutation(saved)
  }
}
