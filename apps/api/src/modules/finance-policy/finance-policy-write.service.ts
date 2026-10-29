import { Injectable } from '@nestjs/common'
import {
  FINANCE_POLICY_WRITE,
  FinancePolicyApprovalBodySchema,
  FinancePolicySubmitBodySchema,
  FinancePolicyVersionParamSchema,
  INVENTORY_COSTING_SETTING,
  POLICY_STATUS_LABEL,
  changedPolicyKeys,
  describePolicyChanges,
  policyEffectiveIssue,
  policyValuesOf,
  type PolicyDecisionResult,
  type PolicyStatus,
  type PolicySubmitResult,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ApprovalsRegistryService } from '../approval-registry'
import { ContextService } from '../auth'
import { currentOf, frozenMessage, frozenPeriodOf, isUniqueViolation, loadFrozenPeriods, POLICY_SELECT, tenantToday, valuesOf, type Db } from './finance-policy-common'

const LABEL = '财务口径版本'
const stateConflict = (message: string) => appError('DATA_CONDITION_FAILED', message)

// 财务口径的写入（P2b-15）：提交修改（待审批）→ 另一位有权限的成员审批（通过后立即生效并替换旧版本，驳回或撤回则作废）。
// 两个接口都要先查权限、再校验参数、再看数据状态；都要再次验证身份（控制器上声明），都写审计。
// 生效日不能落在关账中或已关账的期间里：这些期间的利润日表不再重算，口径只对未关账的日期起作用。
@Injectable()
export class FinancePolicyWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly approvals: ApprovalsRegistryService,
  ) {}

  async submit(req: RequestWithContext, rawBody: unknown, now: Date = new Date()): Promise<PolicySubmitResult> {
    const context = await this.context.authorize(req, FINANCE_POLICY_WRITE)
    const body = FinancePolicySubmitBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const today = await tenantToday(this.prisma, tenantId, now)
    const issue = policyEffectiveIssue(body.effectiveFrom, today)
    if (issue) throw appError('VALIDATION_FAILED', issue, { fieldErrors: { effectiveFrom: [issue] } })
    const frozen = frozenPeriodOf(await loadFrozenPeriods(this.prisma, tenantId), body.effectiveFrom)
    if (frozen) throw stateConflict(frozenMessage(body.effectiveFrom, frozen))
    const next = policyValuesOf(body)
    const saved = await this.prisma
      .$transaction(async tx => {
        const latest = await tx.financePolicyVersion.findFirst({ where: { tenantId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
        const latestNo = latest?.versionNo ?? 0
        if (body.version !== latestNo) throw appError('CONFLICT', '财务口径刚刚被他人修改，请刷新后再提交', { details: { currentVersion: latestNo, expectedVersion: body.version } })
        const pending = await tx.financePolicyVersion.findFirst({ where: { tenantId, status: 'PENDING' }, select: { versionNo: true } })
        if (pending) throw stateConflict(`已有一份待审批的修改（第 ${pending.versionNo} 版）：请先审批通过、驳回或撤回，再提交新的修改`)
        const current = await currentOf(tx, tenantId)
        // 已经有生效版本时，完全相同的修改没有意义；还没有任何版本时允许把默认口径正式登记一次
        if (current.source === 'VERSION' && changedPolicyKeys(current.values, next).length === 0) {
          throw appError('VALIDATION_FAILED', '与当前生效的口径完全相同，没有需要修改的内容', { fieldErrors: { inventoryCostMethod: ['与当前生效的口径完全相同'] } })
        }
        const row = await tx.financePolicyVersion.create({
          data: { tenantId, versionNo: latestNo + 1, effectiveFrom: new Date(`${body.effectiveFrom}T00:00:00Z`), ...next, status: 'PENDING', reason: body.reason, createdBy: context.userId },
          select: { id: true, versionNo: true, version: true },
        })
        await this.audit.record(
          req,
          {
            action: 'FINANCE_POLICY_SUBMITTED',
            resourceType: 'FinancePolicyVersion',
            resourceId: row.id,
            before: { versionNo: current.versionNo, ...current.values },
            after: { versionNo: row.versionNo, effectiveFrom: body.effectiveFrom, ...next },
            reason: body.reason,
            detail: { summary: describePolicyChanges(current.values, next) },
          },
          { client: tx },
        )
        // P6-27：同一个事务里登记到审批收件箱
        const changes = describePolicyChanges(current.values, next)
        await this.approvals.register(tx, {
          tenantId,
          type: 'FINANCE_POLICY',
          objectType: 'FinancePolicyVersion',
          objectId: row.id,
          title: `财务口径变更：第 ${row.versionNo} 版`,
          summary: [
            { label: '生效日期', value: body.effectiveFrom },
            { label: '修改原因', value: body.reason },
            ...(changes.length > 0 ? changes.map((text, index) => ({ label: `变更 ${index + 1}`, value: text })) : [{ label: '变更', value: '把默认口径正式登记为第 1 版' }]),
          ],
          requesterId: context.userId,
          approverPermission: FINANCE_POLICY_WRITE,
        })
        return row
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw appError('CONFLICT', '财务口径刚刚被他人修改，请刷新后再提交')
        throw error
      })
    return { versionNo: saved.versionNo, version: saved.version, status: 'PENDING', message: `已提交第 ${saved.versionNo} 版口径修改，等待另一位有权限的成员审批；审批通过前不会生效` }
  }

  async decide(req: RequestWithContext, rawVersionNo: unknown, rawBody: unknown, now: Date = new Date()): Promise<PolicyDecisionResult> {
    const context = await this.context.authorize(req, FINANCE_POLICY_WRITE)
    const versionNo = FinancePolicyVersionParamSchema.parse(rawVersionNo)
    const body = FinancePolicyApprovalBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const row = await this.prisma.financePolicyVersion.findFirst({ where: { tenantId, versionNo }, select: POLICY_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '口径版本不存在')
    if (row.status !== 'PENDING') throw stateConflict(`第 ${versionNo} 版已是“${POLICY_STATUS_LABEL[row.status as PolicyStatus]}”，不能再审批`)
    const approved = body.decision === 'APPROVED'
    if (approved && row.createdBy === context.userId) throw stateConflict('发起人不能审批自己的修改，需要另一位有“修改财务口径”权限的成员审批')
    const frozenPeriods = await loadFrozenPeriods(this.prisma, tenantId)
    const day = row.effectiveFrom.toISOString().slice(0, 10)
    const frozen = approved ? frozenPeriodOf(frozenPeriods, day) : null
    if (frozen) throw stateConflict(`${frozenMessage(day, frozen)}（提交后该期间被关账了，请驳回这份修改，改到未关账的日期重新提交）`)
    const values = valuesOf(row)
    const result = await this.prisma.$transaction(async tx => {
      const current = await currentOf(tx, tenantId)
      if (approved) {
        const olds = await tx.financePolicyVersion.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true, version: true, versionNo: true }, take: 100 })
        for (const old of olds) await updateWithVersion(tx.financePolicyVersion, { id: old.id, tenantId }, old.version, { status: 'REPLACED', replacedAt: now }, { label: LABEL })
        await updateWithVersion(
          tx.financePolicyVersion,
          { id: row.id, tenantId },
          body.version,
          { status: 'ACTIVE', decidedBy: context.userId, decidedAt: now, decisionComment: body.comment || null },
          { label: LABEL },
        )
        await this.syncInventoryCosting(tx, tenantId, context.userId, values.inventoryCostMethod)
      } else {
        await updateWithVersion(
          tx.financePolicyVersion,
          { id: row.id, tenantId },
          body.version,
          { status: 'REJECTED', decidedBy: context.userId, decidedAt: now, decisionComment: body.comment },
          { label: LABEL },
        )
      }
      const withdrawn = !approved && row.createdBy === context.userId
      await this.audit.record(
        req,
        {
          action: approved ? 'FINANCE_POLICY_APPROVED' : 'FINANCE_POLICY_REJECTED',
          resourceType: 'FinancePolicyVersion',
          resourceId: row.id,
          before: { status: 'PENDING', activeVersionNo: current.versionNo, ...current.values },
          after: { status: approved ? 'ACTIVE' : 'REJECTED', versionNo, effectiveFrom: day, ...values },
          reason: body.comment || undefined,
          detail: {
            summary: describePolicyChanges(current.values, values),
            withdrawn,
            frozenPeriodsUnaffected: approved ? frozenPeriods.length : undefined,
            settingSynced: approved ? INVENTORY_COSTING_SETTING : undefined,
          },
        },
        { client: tx },
      )
      // P6-27：回写审批收件箱（撤回记为已撤回）
      await this.approvals.resolve(tx, {
        tenantId,
        type: 'FINANCE_POLICY',
        objectType: 'FinancePolicyVersion',
        objectId: row.id,
        outcome: approved ? 'APPROVED' : withdrawn ? 'CANCELLED' : 'REJECTED',
        userId: context.userId,
        comment: body.comment,
        now,
      })
      return { withdrawn }
    })
    if (approved) return { versionNo, status: 'ACTIVE', message: `第 ${versionNo} 版口径已生效；利润日表按新口径重算（最长 6 小时），关账中与已关账的期间不受影响` }
    return { versionNo, status: 'REJECTED', message: result.withdrawn ? `已撤回第 ${versionNo} 版口径修改` : `已驳回第 ${versionNo} 版口径修改` }
  }

  /** 把存货计价写进企业设置：worker 的利润计价与商品成本页的库存成本估算都读这一项。 */
  private async syncInventoryCosting(tx: Db, tenantId: string, userId: string, method: string): Promise<void> {
    const existing = await tx.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: INVENTORY_COSTING_SETTING }, select: { id: true } })
    if (existing) await tx.tenantSetting.update({ where: { id: existing.id }, data: { valueJson: method, updatedBy: userId, version: { increment: 1 } } })
    else await tx.tenantSetting.create({ data: { tenantId, key: INVENTORY_COSTING_SETTING, valueJson: method, scope: 'TENANT', updatedBy: userId } })
  }
}
