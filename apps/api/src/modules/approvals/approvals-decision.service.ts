import { Injectable } from '@nestjs/common'
import {
  APPROVAL_REQUEST_STATUS_LABEL,
  APPROVAL_TYPE_LABEL,
  FINANCE_POLICY_STEP_UP,
  ApprovalDecisionBodySchema,
  ApprovalIdParamSchema,
  type ApprovalDecisionBody,
  type ApprovalDecisionResult,
  type ApprovalType,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { StepUpService } from '../../platform/write'
import { ContextService } from '../auth'
import { FinancePolicyWriteService } from '../finance-policy'
import { MetricVersionsWriteService } from '../metric-versions'
import { PeriodsWriteService } from '../periods'
import { relatedTo, statusOf, typeOf, type ApprovalRecord } from './approvals-read.service'

const stateConflict = (message: string) => appError('DATA_CONDITION_FAILED', message)
const missing = () => appError('RESOURCE_NOT_FOUND', '审批单不存在，或与你无关')

interface Decider {
  /** 需要再次验证身份的动作（与原模块的审批接口一致）。 */
  stepUp?: typeof FINANCE_POLICY_STEP_UP
  run: (req: RequestWithContext, row: ApprovalRecord, body: ApprovalDecisionBody) => Promise<void>
}

// 在收件箱里处理审批（P6-27，freeze/api.md POST /approvals/:id/decision）：不重写任何审批规则，而是把请求转给单据原来的审批服务
// （财务口径、口径版本、期间关账）。原服务负责权限、发起人与审批人分离、乐观锁、生效或回滚，并在同一个事务里回写本表；
// 所以从原页面和从收件箱审批的效果完全一致。收件箱自己只多做三件事：确认与你有关、确认还在待处理、校验收件箱记录的版本号。
@Injectable()
export class ApprovalsDecisionService {
  private readonly deciders: Partial<Record<ApprovalType, Decider>>

  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly stepUp: StepUpService,
    policies: FinancePolicyWriteService,
    metrics: MetricVersionsWriteService,
    periods: PeriodsWriteService,
  ) {
    const common = (body: ApprovalDecisionBody, version: number) => ({ decision: body.decision, comment: body.comment, version })
    this.deciders = {
      FINANCE_POLICY: {
        stepUp: FINANCE_POLICY_STEP_UP,
        run: async (req, row, body) => {
          const version = await this.prisma.financePolicyVersion.findFirst({ where: { id: row.objectId, tenantId: row.tenantId }, select: { versionNo: true, version: true } })
          if (!version) throw appError('RESOURCE_NOT_FOUND', '口径版本不存在')
          await policies.decide(req, version.versionNo, common(body, version.version))
        },
      },
      PROFIT_FORMULA: {
        stepUp: FINANCE_POLICY_STEP_UP,
        run: async (req, row, body) => {
          const version = await this.prisma.metricVersion.findFirst({ where: { id: row.objectId, tenantId: row.tenantId }, select: { version: true } })
          if (!version) throw appError('RESOURCE_NOT_FOUND', '口径版本不存在')
          await metrics.decide(req, row.objectId, common(body, version.version))
        },
      },
      PERIOD_CLOSE: {
        run: async (req, row, body) => {
          const period = await this.prisma.accountingPeriod.findFirst({ where: { id: row.objectId, tenantId: row.tenantId }, select: { version: true } })
          if (!period) throw appError('RESOURCE_NOT_FOUND', '关账期间不存在')
          await periods.approve(req, row.objectId, { ...common(body, period.version), comment: body.comment || undefined })
        },
      },
    }
  }

  async decide(req: RequestWithContext, rawId: unknown, rawBody: unknown): Promise<ApprovalDecisionResult> {
    const context = await this.context.resolve(req)
    const id = ApprovalIdParamSchema.parse(rawId)
    const body = ApprovalDecisionBodySchema.parse(rawBody)
    const { tenantId, userId } = context
    const row = await this.prisma.approvalRequest.findFirst({ where: { id, tenantId, AND: [relatedTo(userId)] } })
    if (!row) throw missing()
    const type = typeOf(row.type)
    if (row.status !== 'PENDING') throw stateConflict(`这张审批已经是“${APPROVAL_REQUEST_STATUS_LABEL[statusOf(row.status)]}”，不能再处理`)
    const isRequester = row.requesterId === userId
    if (!isRequester && !row.approverIds.includes(userId)) throw appError('TENANT_ACCESS_DENIED', '你不是这张单据的审批人，只能查看')
    if (isRequester && type === 'PERIOD_CLOSE') throw stateConflict('发起关账检查的人不能审批，也不能撤回；需要撤销时重新做一次完整性检查即可')
    if (body.decision === 'APPROVED' && isRequester) throw stateConflict('发起人不能审批自己的单据，需要另一位有审批权限的成员处理')
    if (row.version !== body.version) {
      throw appError('CONFLICT', '这张审批刚刚被更新，请刷新后再处理', { details: { currentVersion: row.version, expectedVersion: body.version } })
    }
    const decider = this.deciders[type]
    if (!decider) throw stateConflict(`“${APPROVAL_TYPE_LABEL[type]}”还没有接入收件箱审批，请到原页面处理`)
    // 原服务里的再次验证身份由控制器声明；这里替它做同样的检查，并把验证记录写进审计
    if (decider.stepUp) req.stepUpId = await this.stepUp.require(context, decider.stepUp)
    await decider.run(req, row, body)
    const fresh = await this.prisma.approvalRequest.findFirst({ where: { id, tenantId }, select: { status: true } })
    const status = statusOf(fresh?.status ?? row.status)
    const withdrawn = status === 'CANCELLED'
    return {
      id,
      status,
      statusLabel: APPROVAL_REQUEST_STATUS_LABEL[status],
      message: status === 'APPROVED' ? `已通过：${row.title}` : withdrawn ? `已撤回：${row.title}` : status === 'REJECTED' ? `已驳回：${row.title}` : `已处理：${row.title}`,
    }
  }
}
