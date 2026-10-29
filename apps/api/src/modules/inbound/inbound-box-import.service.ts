import { Injectable } from '@nestjs/common'
import {
  BOX_TEMPLATE_KINDS,
  InboundBoxImportBodySchema,
  boxTemplateOf,
  inboundPlanActions,
  isBoxTemplateKind,
  isInboundStage,
  parseBoxFile,
  type BoxTemplateResponse,
  type InboundBoxImportResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { InboundDraftService } from './inbound-draft.service'
import { INBOUND_READ, INBOUND_WRITE, loadPlan } from './inbound-common'

// 装箱表格文件模板（P6-10）：下载两种模板，导入时逐行校验，一行有错整份拒绝、重复行跳过、SKU 必须在计划里。
// 导入与手工保存走同一个落库函数（整体替换、乐观锁、写审计），所以状态要求也一样：只有“装箱方案已确认”的计划能改箱子。
@Injectable()
export class InboundBoxImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly drafts: InboundDraftService,
  ) {}

  /** 模板：`kind` 是白名单（混装、原厂包装），其余按不存在处理（404）。 */
  async template(req: RequestWithContext, kind: string): Promise<BoxTemplateResponse> {
    await this.context.authorizeScoped(req, INBOUND_READ, {})
    if (!isBoxTemplateKind(kind)) throw appError('RESOURCE_NOT_FOUND', `没有这种装箱模板（可用：${BOX_TEMPLATE_KINDS.join('、')}）`)
    return boxTemplateOf(kind)
  }

  async importBoxes(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundBoxImportResponse> {
    // 权限检查先于参数校验：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = InboundBoxImportBodySchema.parse(rawBody)
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const stage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
    const state = inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt }).SAVE_BOXES
    if (!state.allowed) throw appError('CONFLICT', state.reason ?? '当前状态不允许改装箱', { details: { stage, pendingOp: plan.pendingOp } })
    const items = await this.prisma.inboundPlanItem.findMany({ where: { tenantId: plan.tenantId, planId: plan.id }, select: { sku: true }, take: 500 })
    const parsed = parseBoxFile(
      body.content,
      body.kind,
      items.map(item => item.sku),
    )
    if (parsed.errors.length > 0) {
      const lines = parsed.errors.map(error => (error.line > 0 ? `第 ${error.line} 行：${error.message}` : error.message))
      throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: lines } })
    }
    const saved = await this.drafts.replaceBoxes(req, plan, body.version, parsed.boxes, 'FBA_INBOUND_BOXES_IMPORTED', {
      fileName: body.fileName,
      kind: body.kind,
      rows: parsed.rows,
      skippedRows: parsed.skipped.length,
    })
    return {
      plan: saved.plan,
      state: 'SAVED',
      imported: {
        boxTypes: parsed.boxes.length,
        boxes: parsed.boxes.reduce((sum, box) => sum + box.quantity, 0),
        units: parsed.boxes.reduce((sum, box) => sum + box.quantity * box.items.reduce((inner, item) => inner + item.quantity, 0), 0),
      },
      skipped: parsed.skipped,
    }
  }
}
