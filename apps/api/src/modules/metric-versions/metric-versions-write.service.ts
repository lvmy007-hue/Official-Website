import { Injectable } from '@nestjs/common'
import {
  BUSINESS_RULES_WRITE,
  BUSINESS_RULE_LABEL,
  BusinessRuleBodySchema,
  BusinessRuleKeyParamSchema,
  BusinessRuleValueSchemas,
  FINANCE_POLICY_WRITE,
  METRIC_KIND_LABEL,
  METRIC_VERSION_ACTIONS,
  MetricDecisionBodySchema,
  ProfitFormulaBodySchema,
  describeFormulaChanges,
  describeRuleChanges,
  readBusinessRules,
  readFormulaConfig,
  sameFormula,
  type BusinessRulesConfig,
  type MetricDecisionResult,
  type MetricKind,
  type MetricSubmitResult,
  type ProfitFormulaConfig,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ApprovalsRegistryService } from '../approval-registry'
import { ContextService } from '../auth'
import { cleanConfig, VERSION_SELECT, withMeta } from './metric-versions-common'

const LABEL = '口径版本'
const stateConflict = (message: string) => appError('DATA_CONDITION_FAILED', message)
const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

interface Submission {
  kind: MetricKind
  /** 提交后的完整配置（不含审批信息）。 */
  config: object
  before: object
  changes: string[]
  clientVersion: number
  reason: string
  permission: string
}

// 利润公式与业务口径的提交和审批（P6-31）：提交形成“待审批”的新版本 → 另一位有“修改财务口径”权限的成员审批 → 通过后立即成为生效版本并替换旧版本。
// 同一类型同一时刻只有一份待审批的修改；发起人自己驳回算撤回；审批通过前不改变任何数字。
@Injectable()
export class MetricVersionsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly approvals: ApprovalsRegistryService,
  ) {}

  async submitFormula(req: RequestWithContext, rawBody: unknown): Promise<MetricSubmitResult> {
    const context = await this.context.authorize(req, FINANCE_POLICY_WRITE)
    const body = ProfitFormulaBodySchema.parse(rawBody)
    const next = readFormulaConfig({ gross: body.gross, denominator: body.denominator }) as ProfitFormulaConfig
    const active = await loadActiveMetrics(this.prisma, context.tenantId)
    const changes = describeFormulaChanges(active.formula.config, next)
    if (sameFormula(active.formula.config, next)) throw appError('VALIDATION_FAILED', '与当前生效的利润公式完全相同，没有需要修改的内容', { fieldErrors: { gross: ['与当前生效的公式完全相同'] } })
    return this.submit(req, context, {
      kind: 'PROFIT_FORMULA',
      config: next,
      before: active.formula.config,
      changes,
      clientVersion: body.version,
      reason: body.reason,
      permission: FINANCE_POLICY_WRITE,
    })
  }

  async submitRule(req: RequestWithContext, rawKey: unknown, rawBody: unknown): Promise<MetricSubmitResult> {
    const context = await this.context.authorize(req, BUSINESS_RULES_WRITE)
    const key = BusinessRuleKeyParamSchema.parse(rawKey)
    const body = BusinessRuleBodySchema.parse(rawBody)
    const parsed = BusinessRuleValueSchemas[key].safeParse(body.value)
    if (!parsed.success)
      throw appError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? `${BUSINESS_RULE_LABEL[key]}的取值不合法`, { fieldErrors: { value: parsed.error.issues.map(issue => issue.message) } })
    const active = await loadActiveMetrics(this.prisma, context.tenantId)
    const next = readBusinessRules({ ...active.rules.config, [key]: parsed.data }) as BusinessRulesConfig
    const changes = describeRuleChanges(active.rules.config, next)
    if (changes.length === 0) throw appError('VALIDATION_FAILED', `${BUSINESS_RULE_LABEL[key]}与当前生效的口径完全相同，没有需要修改的内容`, { fieldErrors: { value: ['与当前生效的口径完全相同'] } })
    return this.submit(req, context, { kind: 'BUSINESS_RULES', config: next, before: active.rules.config, changes, clientVersion: body.version, reason: body.reason, permission: BUSINESS_RULES_WRITE })
  }

  private async submit(req: RequestWithContext, context: { tenantId: string; userId: string }, input: Submission): Promise<MetricSubmitResult> {
    const { tenantId } = context
    const summary = input.changes.join('；')
    const saved = await this.prisma
      .$transaction(async tx => {
        const latest = await tx.metricVersion.findFirst({ where: { tenantId, kind: input.kind }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
        const latestNo = latest?.versionNo ?? 0
        if (input.clientVersion !== latestNo)
          throw appError('CONFLICT', `${METRIC_KIND_LABEL[input.kind]}刚刚被他人修改，请刷新后再提交`, { details: { currentVersion: latestNo, expectedVersion: input.clientVersion } })
        const pending = await tx.metricVersion.findFirst({ where: { tenantId, kind: input.kind, status: 'PENDING_APPROVAL' }, select: { versionNo: true } })
        if (pending) throw stateConflict(`已有一份待审批的修改（第 ${pending.versionNo} 版）：请先审批通过、驳回或撤回，再提交新的修改`)
        const row = await tx.metricVersion.create({
          data: { tenantId, kind: input.kind, versionNo: latestNo + 1, status: 'PENDING_APPROVAL', createdBy: context.userId, config: withMeta(input.config, { reason: input.reason, summary }) },
          select: { id: true, versionNo: true, version: true },
        })
        await this.audit.record(
          req,
          {
            action: METRIC_VERSION_ACTIONS.submitted,
            resourceType: 'MetricVersion',
            resourceId: row.id,
            before: { kind: input.kind, ...input.before },
            after: { kind: input.kind, versionNo: row.versionNo, ...input.config },
            reason: input.reason,
            detail: { summary, permission: input.permission },
          },
          { client: tx },
        )
        // P6-27：同一个事务里登记到审批收件箱（业务口径与利润公式共用“利润公式与业务口径变更”类型，用对象类型区分）
        await this.approvals.register(tx, {
          tenantId,
          type: 'PROFIT_FORMULA',
          objectType: `MetricVersion:${input.kind}`,
          objectId: row.id,
          title: `${METRIC_KIND_LABEL[input.kind]}变更：第 ${row.versionNo} 版`,
          summary: [{ label: '修改原因', value: input.reason }, ...input.changes.slice(0, 20).map((text, index) => ({ label: `变更 ${index + 1}`, value: text }))],
          requesterId: context.userId,
          approverPermission: FINANCE_POLICY_WRITE,
        })
        return row
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw appError('CONFLICT', `${METRIC_KIND_LABEL[input.kind]}刚刚被他人修改，请刷新后再提交`)
        throw error
      })
    return {
      kind: input.kind,
      versionNo: saved.versionNo,
      version: saved.version,
      status: 'PENDING_APPROVAL',
      message: `已提交第 ${saved.versionNo} 版${METRIC_KIND_LABEL[input.kind]}，等待另一位有权限的成员审批；审批通过前不会生效`,
    }
  }

  async decide(req: RequestWithContext, id: string, rawBody: unknown, now: Date = new Date()): Promise<MetricDecisionResult> {
    const context = await this.context.authorize(req, FINANCE_POLICY_WRITE)
    const body = MetricDecisionBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const row = await this.prisma.metricVersion.findFirst({ where: { id, tenantId }, select: VERSION_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '口径版本不存在')
    const kind = row.kind as MetricKind
    if (row.status !== 'PENDING_APPROVAL') throw stateConflict(`第 ${row.versionNo} 版已不在待审批状态，不能再审批`)
    const approved = body.decision === 'APPROVED'
    if (approved && row.createdBy === context.userId) throw stateConflict('发起人不能审批自己的修改，需要另一位有“修改财务口径”权限的成员审批')
    const withdrawn = !approved && row.createdBy === context.userId
    const clean = cleanConfig(row.config) as object
    const previousMeta = (row.config as { _meta?: object })._meta ?? {}
    const decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' = approved ? 'APPROVED' : withdrawn ? 'WITHDRAWN' : 'REJECTED'
    const meta = { ...previousMeta, decision, comment: body.comment || null, decidedAt: now.toISOString() }
    await this.prisma.$transaction(async tx => {
      const olds = approved ? await tx.metricVersion.findMany({ where: { tenantId, kind, status: 'ACTIVE' }, select: { id: true, version: true, versionNo: true }, take: 10 }) : []
      for (const old of olds) await updateWithVersion(tx.metricVersion, { id: old.id, tenantId }, old.version, { status: 'RETIRED' }, { label: LABEL })
      await updateWithVersion(
        tx.metricVersion,
        { id: row.id, tenantId },
        body.version,
        approved
          ? { status: 'ACTIVE', approvedBy: context.userId, effectiveFrom: now, config: withMeta(clean, meta) }
          : { status: 'RETIRED', approvedBy: context.userId, config: withMeta(clean, meta) },
        { label: LABEL },
      )
      await this.audit.record(
        req,
        {
          action: approved ? METRIC_VERSION_ACTIONS.approved : METRIC_VERSION_ACTIONS.rejected,
          resourceType: 'MetricVersion',
          resourceId: row.id,
          before: { status: 'PENDING_APPROVAL', kind, versionNo: row.versionNo, replacedVersionNos: olds.map(old => old.versionNo) },
          after: { status: approved ? 'ACTIVE' : 'RETIRED', kind, versionNo: row.versionNo, ...clean },
          reason: body.comment || undefined,
          detail: { decision, withdrawn },
        },
        { client: tx },
      )
      // P6-27：回写审批收件箱（撤回记为已撤回）
      await this.approvals.resolve(tx, {
        tenantId,
        type: 'PROFIT_FORMULA',
        objectType: `MetricVersion:${kind}`,
        objectId: row.id,
        outcome: approved ? 'APPROVED' : withdrawn ? 'CANCELLED' : 'REJECTED',
        userId: context.userId,
        comment: body.comment,
        now,
      })
    })
    const name = METRIC_KIND_LABEL[kind]
    if (approved) return { kind, versionNo: row.versionNo, status: 'ACTIVE', message: `第 ${row.versionNo} 版${name}已生效；全站相关数字按新口径显示，已关账月份的快照不受影响` }
    return { kind, versionNo: row.versionNo, status: 'RETIRED', message: withdrawn ? `已撤回第 ${row.versionNo} 版${name}` : `已驳回第 ${row.versionNo} 版${name}` }
  }
}
