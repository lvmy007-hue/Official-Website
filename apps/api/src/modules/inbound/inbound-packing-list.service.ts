import { Injectable } from '@nestjs/common'
import { hasPermission } from '@nova/authz'
import {
  PACKING_MAX_ROWS,
  PackingListApplyBodySchema,
  PackingListParseBodySchema,
  SKU_ALIAS_ACTIONS,
  SKU_ALIAS_MANAGE,
  finishPacking,
  inboundPlanActions,
  isInboundStage,
  packingMatchKeys,
  parseCsvTable,
  preparePacking,
  resolvePacking,
  type PackingApplyResponse,
  type PackingListApplyBody,
  type PackingListParseBody,
  type PackingPreviewResponse,
} from '@nova/api-contracts'
import type { FbaInboundPlan } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { readXlsx, XlsxError } from '../../platform/xlsx-reader'
import { ContextService, type ResolvedScope } from '../auth'
import { PackingMappingService, SkuAliasService } from '../sku-alias'
import { InboundDraftService } from './inbound-draft.service'
import { INBOUND_WRITE, loadPlan } from './inbound-common'

const REMEMBER_BLOCKED = '你没有维护外部货号映射的权限，不能记住这些对应关系；取消“记住”后可以继续应用'
const BASE64 = /^[A-Za-z0-9+/=\s]+$/
/** XLSX 解压后的体积保护：装箱单不会大，超过就按异常文件处理。 */
const XLSX_LIMITS = { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxRows: PACKING_MAX_ROWS + 100, maxCols: 80 }

const fail = (message: string): never => {
  throw appError('VALIDATION_FAILED', message, { fieldErrors: { content: [message] } })
}

interface Prepared {
  plan: FbaInboundPlan
  analysis: PackingPreviewResponse
  planSkus: Set<string>
}

// 供应商装箱单匹配（P6-11，16 章 5）：把装箱单文件（CSV 或 XLSX）识别成箱子，逐行匹配计划里的 SKU，由人确认后整体写入计划的装箱。
// 规则：
//   - 预览（parse）与应用（apply）共用同一套识别与匹配（packages/api-contracts 的纯函数），行号与判断完全一致；应用时重新读文件，不信任前端传来的匹配结果，只接收人工决定（选 SKU、忽略、记住）；
//   - 应用与保存箱子、导入箱子同一个落库函数：状态要求“装箱方案已确认”、乐观锁、整体替换、写审计；
//   - “记住”要 skualias.manage：外部货号 → SKU 在同一个事务里写入映射表，与箱子一起成功或失败；
//   - 所有映射与计划商品各一次查出，没有逐行查库；候选只是提示，绝不自动采用。
@Injectable()
export class InboundPackingListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly drafts: InboundDraftService,
    private readonly aliases: SkuAliasService,
    private readonly mappings: PackingMappingService,
  ) {}

  private table(body: PackingListParseBody) {
    if (body.format === 'CSV') {
      if (body.content.startsWith('PK')) return fail('这个文件看起来是 Excel（.xlsx），请把文件类型选成 XLSX，或另存为 CSV')
      return { table: parseCsvTable(body.content), sheet: null as string | null, sheets: [] as string[] }
    }
    if (!BASE64.test(body.content)) return fail('XLSX 文件内容不是有效的 base64')
    try {
      const read = readXlsx(Buffer.from(body.content, 'base64'), { sheet: body.sheet ?? null, limits: XLSX_LIMITS })
      return { table: read.table, sheet: read.sheet, sheets: read.sheets }
    } catch (error) {
      if (error instanceof XlsxError) return fail(error.message)
      throw error
    }
  }

  private async prepare(context: ApiContext, scope: ResolvedScope, id: string, body: PackingListParseBody | PackingListApplyBody): Promise<Prepared> {
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const { table, sheet, sheets } = this.table(body)
    const supplierId = body.supplierId ?? null
    const supplier = supplierId ? await this.prisma.supplier.findFirst({ where: { id: supplierId, tenantId: context.tenantId }, select: { id: true, code: true, name: true } }) : null
    if (supplierId && !supplier) throw appError('VALIDATION_FAILED', '供应商不存在', { fieldErrors: { supplierId: ['供应商不存在'] } })
    const [saved, items, existingBoxTypes] = await Promise.all([
      this.mappings.savedFor(context.tenantId, supplierId),
      this.prisma.inboundPlanItem.findMany({
        where: { tenantId: plan.tenantId, planId: plan.id },
        select: { sku: true, fnsku: true, asin: true, productName: true },
        orderBy: { sku: 'asc' },
        take: 500,
      }),
      this.prisma.inboundBox.count({ where: { tenantId: plan.tenantId, planId: plan.id } }),
    ])
    const prepared = preparePacking({
      table,
      headerLine: body.headerLine ?? null,
      columns: body.columns ?? null,
      savedColumns: saved?.columns ?? null,
      units: body.units ?? null,
      savedUnits: saved?.units ?? null,
    })
    const refs = await this.aliases.lookup(context.tenantId, supplierId, packingMatchKeys(prepared))
    const analysis = finishPacking(prepared, { items, aliases: refs, supplierId, defaults: body.defaults ?? null })
    const stage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
    const state = inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt }).SAVE_BOXES
    const canRemember = hasPermission(context.permissions, SKU_ALIAS_MANAGE)
    return {
      plan,
      planSkus: new Set(items.map(item => item.sku)),
      analysis: {
        ...analysis,
        planId: plan.id,
        fileName: body.fileName,
        format: body.format,
        sheet,
        sheets,
        supplier,
        savedMapping: saved !== null,
        canApply: state.allowed,
        applyBlockedReason: state.allowed ? null : state.reason,
        existingBoxTypes,
        canRemember,
        rememberBlockedReason: canRemember ? null : REMEMBER_BLOCKED,
      },
    }
  }

  async parse(req: RequestWithContext, id: string, rawBody: unknown): Promise<PackingPreviewResponse> {
    // 权限检查先于参数校验：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = PackingListParseBodySchema.parse(rawBody)
    return (await this.prepare(context, scope, id, body)).analysis
  }

  async apply(req: RequestWithContext, id: string, rawBody: unknown): Promise<PackingApplyResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = PackingListApplyBodySchema.parse(rawBody)
    const { plan, analysis, planSkus } = await this.prepare(context, scope, id, body)
    if (!analysis.canApply) throw appError('CONFLICT', analysis.applyBlockedReason ?? '当前状态不允许改装箱', { details: { stage: plan.stage, pendingOp: plan.pendingOp } })
    if (analysis.fatal || analysis.missingFields.length > 0) {
      const message = analysis.fatal ?? `还有必需的列没有对应上：${analysis.missingFields.join('、')}`
      throw appError('VALIDATION_FAILED', message, { fieldErrors: { content: [message] } })
    }
    const resolved = resolvePacking(analysis.rows, body.decisions, planSkus, body.defaults ?? null)
    if (resolved.blockers.length > 0) throw appError('VALIDATION_FAILED', '装箱单还有问题，没有写入任何数据', { fieldErrors: { content: resolved.blockers } })
    if (resolved.remember.length > 0 && !analysis.canRemember) throw appError('TENANT_ACCESS_DENIED', REMEMBER_BLOCKED)

    const saved = await this.drafts
      .replaceBoxes(
        req,
        plan,
        body.version,
        resolved.boxes,
        SKU_ALIAS_ACTIONS.packingApplied,
        { fileName: body.fileName, format: body.format, supplierId: body.supplierId ?? null, rows: analysis.rows.length, ignoredRows: resolved.ignoredLines.length },
        async tx => {
          const remembered = await this.aliases.remember(tx, context.tenantId, context.userId, body.supplierId ?? null, resolved.remember)
          return { aliasCreated: remembered.created, aliasUpdated: remembered.updated }
        },
      )
      .catch((error: unknown) => {
        // 同时有人记了同一个外部货号：整个事务回滚，箱子也没有写入
        if ((error as { code?: string } | null)?.code === 'P2002') throw appError('CONFLICT', '外部货号映射刚被别人改过，请重新预览后再应用')
        throw error
      })
    return {
      plan: saved.plan,
      state: 'SAVED',
      imported: {
        boxTypes: resolved.boxes.length,
        boxes: resolved.boxes.reduce((sum, box) => sum + box.quantity, 0),
        units: resolved.boxes.reduce((sum, box) => sum + box.quantity * box.items.reduce((inner, item) => inner + item.quantity, 0), 0),
      },
      ignored: resolved.ignoredLines.length,
      remembered: resolved.remember.length,
    }
  }
}
