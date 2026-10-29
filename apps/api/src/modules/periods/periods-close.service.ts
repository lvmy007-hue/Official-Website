import { Injectable } from '@nestjs/common'
import {
  METRIC_SNAPSHOT_KEYS,
  PERIOD_CLOSE,
  PERIOD_REOPEN,
  PERIOD_STATUS_LABEL,
  PeriodCloseBodySchema,
  PeriodReopenBodySchema,
  buildChecklist,
  diffSnapshots,
  isAllocationRuleBasis,
  monthStartDate,
  monthText,
  snapshotAllocationRules,
  statusAfterCheck,
  type PeriodCloseResult,
  type PeriodMutationResult,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { FxWriteService } from '../fx'
import { dateText } from '../overview'
import { actionsFor, bounds, checklistOf, loadPeriod, requireAllowed, statusOf, tenantZone } from './periods-common'
import { gatherEvals } from './periods-evidence'
import { loadBundle } from './periods-snapshot-load'
import { bundleOf } from './periods-view'

const LABEL = '关账期间'
const RESULT = { id: true, version: true, status: true } as const
const json = (value: unknown) => value as Prisma.InputJsonValue
const CLEARED = { approvalDecision: null, approvedBy: null, approvedAt: null, approvalComment: null }

// 期间关账的锁定与重新开账（07 章 7.12）。两个动作都要再次验证身份（写入口的 stepUp），都带版本号、在一个事务里完成并写审计。
// 锁定：复查完整性 → 取利润日表、汇率、成本版本三份快照 → 状态改为已关账、写快照、锁定期间内的汇率。快照只追加、从不修改。
// 重新开账：状态改为重新开账、解除本期间的汇率锁定（其他仍已关账且日期重叠的期间重新锁回）；利润日表恢复重算，差异报告在详情里实时对比上一份快照。
@Injectable()
export class PeriodsCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly fx: FxWriteService,
  ) {}

  async close(req: RequestWithContext, id: string, rawBody: unknown): Promise<PeriodCloseResult> {
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_CLOSE, {})
    const body = PeriodCloseBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const row = await loadPeriod(this.prisma, tenantId, scope, id)
    requireAllowed(actionsFor(row, context.userId, context.permissions), 'close')
    if (row.version !== body.version) {
      throw appError('CONFLICT', '关账期间已被他人修改，请刷新后查看最新内容，再决定是否锁定', { details: { currentVersion: row.version, expectedVersion: body.version } })
    }
    const { start, end } = bounds(row)
    const target = { tenantId, sellerAccountId: row.sellerAccountId, start, end, zone: await tenantZone(this.prisma, tenantId) }

    // 审批到锁定之间数据可能又变了（同步、补成本）：锁定前再查一遍，沿用仍然有效的确认放行
    const now = new Date()
    const checklist = buildChecklist(await gatherEvals(this.prisma, target), checklistOf(row.checklistJson), [], context.userId, now)
    if (!checklist.passed) {
      const status = statusAfterCheck(false, row.closeCount)
      await this.prisma.$transaction(async tx => {
        await updateWithVersion(
          tx.accountingPeriod,
          { id, tenantId },
          row.version,
          { status, checklistJson: json(checklist), checkedBy: context.userId, checkedAt: now, ...CLEARED },
          { label: LABEL, select: RESULT },
        )
        await this.audit.record(
          req,
          { action: 'PERIOD_CHECKED', resourceType: 'AccountingPeriod', resourceId: id, before: { status: row.status }, after: { status, passed: false }, reason: '锁定前复查没有通过' },
          { client: tx },
        )
      })
      const failed = checklist.items.filter(item => item.state !== 'PASS' && item.state !== 'ACKNOWLEDGED').map(item => item.label)
      throw appError('DATA_CONDITION_FAILED', `锁定前复查发现数据已经变化，这些检查项没有通过：${failed.join('、')}。期间已退回“${PERIOD_STATUS_LABEL[status]}”，请处理后重新检查`, {
        details: { failed: failed.join('、') },
      })
    }

    const bundle = await loadBundle(this.prisma, target)
    // 关账快照记录期间内每个月各费用项适用的分摊规则版本（P6-19）；之后修改规则不影响已关账月份
    const rules = await this.prisma.allocationRule.findMany({
      where: { tenantId, effectiveMonth: { lte: monthStartDate(end.slice(0, 7)) } },
      select: { id: true, feeItemId: true, basis: true, manualWeights: true, effectiveMonth: true, version: true },
      take: 5000,
    })
    const active = await loadActiveMetrics(this.prisma, tenantId)
    const dictionary = await this.prisma.metricVersion.findFirst({ where: { tenantId, kind: 'PROFIT_DICTIONARY', status: 'ACTIVE' }, select: { versionNo: true } })
    const allocation = snapshotAllocationRules(
      rules.flatMap(rule =>
        isAllocationRuleBasis(rule.basis)
          ? [{ id: rule.id, feeItemId: rule.feeItemId, basis: rule.basis, manualWeights: null, effectiveMonth: monthText(rule.effectiveMonth), version: rule.version }]
          : [],
      ),
      start,
      end,
    )
    // 其余各类口径版本（P6-31）：利润公式与业务口径连配置一起记，之后改了口径也能复现当时的数字；字典只记版本号
    const metricVersions = {
      ...allocation,
      [METRIC_SNAPSHOT_KEYS.formula]: { versionNo: active.formula.ref.versionNo, source: active.formula.ref.source, config: active.formula.config },
      [METRIC_SNAPSHOT_KEYS.rules]: { versionNo: active.rules.ref.versionNo, source: active.rules.ref.source, config: active.rules.config },
      [METRIC_SNAPSHOT_KEYS.dictionary]: { versionNo: dictionary?.versionNo ?? 0, source: dictionary ? 'VERSION' : 'DEFAULT' },
    }
    const revision = row.closeCount + 1
    const result = await this.prisma.$transaction(
      async tx => {
        const next = await updateWithVersion(
          tx.accountingPeriod,
          { id, tenantId },
          body.version,
          { status: 'CLOSED', checklistJson: json(checklist), closedBy: context.userId, closedAt: now, closeCount: { increment: 1 } },
          { label: LABEL, select: RESULT },
        )
        // 第二次及以后的锁定：生成与上一份快照的差异报告，随快照一起保存
        const previous = revision > 1 ? await tx.periodSnapshot.findFirst({ where: { periodId: id, revision: revision - 1 } }) : null
        const diff = previous ? diffSnapshots(bundleOf(previous), bundle) : null
        await tx.periodSnapshot.create({
          data: {
            tenantId,
            periodId: id,
            revision,
            profitSnapshotJson: json(bundle.profit),
            fxSnapshotJson: json(bundle.fx),
            costVersionSnapshotJson: json(bundle.costs),
            metricVersionSnapshotJson: json(metricVersions),
            ...(diff ? { diffJson: json(diff) } : {}),
            lockedBy: context.userId,
            lockedAt: now,
          },
        })
        const fxLocked = await this.fx.lockForPeriod(tx, tenantId, id, start, end)
        await this.audit.record(
          req,
          {
            action: 'PERIOD_CLOSED',
            resourceType: 'AccountingPeriod',
            resourceId: id,
            before: { status: row.status },
            after: { status: 'CLOSED', revision },
            detail: { revision, fxLocked, hasDiff: diff?.hasChanges ?? null, month: start.slice(0, 7), sellerAccountId: row.sellerAccountId },
          },
          { client: tx },
        )
        return { next, fxLocked }
      },
      { timeout: 120_000, maxWait: 30_000 },
    )
    return { id, version: result.next.version, status: 'CLOSED', statusLabel: PERIOD_STATUS_LABEL.CLOSED, revision, fxLocked: result.fxLocked }
  }

  async reopen(req: RequestWithContext, id: string, rawBody: unknown): Promise<PeriodMutationResult> {
    const { context, scope } = await this.context.authorizeScoped(req, PERIOD_REOPEN, {})
    const body = PeriodReopenBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const row = await loadPeriod(this.prisma, tenantId, scope, id)
    requireAllowed(actionsFor(row, context.userId, context.permissions), 'reopen')
    const { start, end } = bounds(row)
    const now = new Date()
    const saved = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(
        tx.accountingPeriod,
        { id, tenantId },
        body.version,
        { status: 'REOPENED', reopenedBy: context.userId, reopenedAt: now, reopenReason: body.reason, checklistJson: {}, checkedBy: null, checkedAt: null, ...CLEARED },
        { label: LABEL, select: RESULT },
      )
      const unlocked = await this.fx.unlockForPeriod(tx, tenantId, id)
      // 同一企业别的店铺、日期重叠且仍已关账的期间，其汇率锁定要锁回去（汇率是企业级的，不分店铺）
      const others = await tx.accountingPeriod.findMany({
        where: { tenantId, status: 'CLOSED', id: { not: id }, periodStart: { lte: row.periodEnd }, periodEnd: { gte: row.periodStart } },
        select: { id: true, periodStart: true, periodEnd: true },
        take: 200,
      })
      let relocked = 0
      for (const other of others) relocked += await this.fx.lockForPeriod(tx, tenantId, other.id, dateText(other.periodStart), dateText(other.periodEnd))
      await this.audit.record(
        req,
        {
          action: 'PERIOD_REOPENED',
          resourceType: 'AccountingPeriod',
          resourceId: id,
          before: { status: row.status, closeCount: row.closeCount },
          after: { status: 'REOPENED' },
          reason: body.reason,
          detail: { fxUnlocked: unlocked, fxRelocked: relocked, month: start.slice(0, 7), periodEnd: end, sellerAccountId: row.sellerAccountId },
        },
        { client: tx },
      )
      return next
    })
    return { id: saved.id, version: saved.version, status: statusOf(saved.status), statusLabel: PERIOD_STATUS_LABEL[statusOf(saved.status)] }
  }
}
