import { Injectable } from '@nestjs/common'
import {
  INBOUND_OP_LABEL,
  INBOUND_OP_STATUS_LABEL,
  INBOUND_STAGES,
  INBOUND_STAGE_LABEL,
  INBOUND_STEP_CHAIN,
  InboundListQuerySchema,
  inboundFlowSteps,
  inboundPlanActions,
  inboundStageIndex,
  isInboundStage,
  voidWindowOf,
  type InboundAction,
  type InboundCostsView,
  type InboundException,
  type InboundItemView,
  type InboundLabelView,
  type InboundLabelsResponse,
  type InboundOp,
  type InboundOpStatus,
  type InboundOperationView,
  type InboundOverview,
  type InboundPlanListResponse,
  type InboundStage,
  type LabelPrintStat,
  type PlacementEstimate,
} from '@nova/api-contracts'
import { Prisma, type FbaInboundPlan } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ObjectStorageService, storageAppError } from '../../platform/storage'
import { ActionGuardService } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { INBOUND_READ, LABEL_LINK_TTL_SECONDS, inboundFreshness, iso, loadPlan, nextDeadlines, num, planRowOf, record, singlePlanRow, storeNames, writeStatus, writeStatuses } from './inbound-common'

const NEXT_ACTION: Partial<Record<InboundStage, { action: InboundAction; text: string }>> = {
  DRAFT: { action: 'ELIGIBILITY', text: '先做资格预检，确认每个 SKU 都能入仓' },
  ELIGIBILITY: { action: 'SUBMIT', text: '把计划提交到亚马逊，创建入仓计划' },
  CREATED: { action: 'GENERATE_PACKING', text: '生成装箱方案，比较后确认一个' },
  PACKING_CONFIRMED: { action: 'SAVE_BOXES', text: '填写每个箱子里装了什么，核对无误后提交给亚马逊' },
  PACKING_INFO_SUBMITTED: { action: 'GENERATE_PLACEMENT', text: '生成分仓方案，按总成本比较后确认一个' },
  PLACEMENT_CONFIRMED: { action: 'GENERATE_TRANSPORT', text: '为每个货件生成运输方案，选择承运并确认' },
  TRANSPORT_CONFIRMED: { action: 'PRINT_LABELS', text: '打印箱标签与商品标签' },
  LABELS_PRINTED: { action: 'MARK_SHIPPED', text: '货物交给承运商后标记已发货，并回填追踪号' },
  SHIPPED: { action: 'UPDATE_TRACKING', text: '回填追踪号，等待运营中心接收' },
}
const STAGE_NOTE: Partial<Record<InboundStage, string>> = {
  RECEIVING: '运营中心正在接收，无需操作',
  DISCREPANCY: '货件已关闭但收到的数量与发出的不一致，请看“接收与差异”，需要时到亚马逊后台提交差异申诉',
  COMPLETED: '计划已完结',
  CANCELLED: '计划已取消',
}
const CANCEL_NOTE = '取消入仓计划：运输方案确认后，小包裹 24 小时内、零担与整车 1 小时内可以作废；超过窗口不能取消，货件需要按亚马逊规则处理。'
const FINAL = ['COMPLETED', 'CANCELLED']

// 入仓计划的读取：列表（含状态看板与异常队列）、计划概览、操作时间线、标签。没有数据的数字显示为空，不补 0。
@Injectable()
export class InboundReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly objects: ObjectStorageService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<InboundPlanListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, rawQuery)
    const query = InboundListQuerySchema.parse(rawQuery)
    const now = new Date()
    const base: Prisma.FbaInboundPlanWhereInput = { tenantId: context.tenantId, ...storeWhere(scope) }
    const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
    const where: Prisma.FbaInboundPlanWhereInput = {
      ...base,
      ...(query.stage ? { stage: query.stage } : {}),
      ...(query.q ? { OR: [{ name: contains(query.q) }, { externalPlanId: contains(query.q) }, { planItems: { some: { sku: contains(query.q) } } }] } : {}),
    }
    const [rows, total, board, trouble, freshness, write] = await Promise.all([
      this.prisma.fbaInboundPlan.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.fbaInboundPlan.count({ where }),
      this.prisma.fbaInboundPlan.groupBy({ by: ['stage'], where: base, _count: { _all: true } }),
      this.prisma.fbaInboundPlan.findMany({
        where: {
          ...base,
          OR: [
            { stage: 'DISCREPANCY' },
            { lastErrorCode: { not: null }, pendingOp: null, stage: { notIn: FINAL } },
            { stage: { in: ['CREATED', 'PACKING_INFO_SUBMITTED', 'TRANSPORT_CONFIRMED', 'LABELS_PRINTED'] } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      inboundFreshness(this.prisma, context.tenantId, scope, now),
      writeStatus(this.guard, context, 'sw.inbound.plan.create'),
    ])
    const ids = rows.map(row => row.id)
    const [names, counts, deadlines, troubleDeadlines] = await Promise.all([
      storeNames(
        this.prisma,
        context.tenantId,
        rows.map(row => row.sellerAccountId),
      ),
      ids.length ? this.prisma.inboundPlanItem.groupBy({ by: ['planId'], where: { tenantId: context.tenantId, planId: { in: ids } }, _count: { _all: true } }) : [],
      nextDeadlines(this.prisma, context.tenantId, rows, now),
      nextDeadlines(this.prisma, context.tenantId, trouble, now),
    ])
    return {
      items: rows.map(row =>
        planRowOf(row, { storeName: names.get(row.sellerAccountId) ?? '', skuCount: counts.find(item => item.planId === row.id)?._count._all ?? 0, deadline: deadlines.get(row.id) ?? null }),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total,
      board: INBOUND_STAGES.map(stage => ({ stage, label: INBOUND_STAGE_LABEL[stage], count: board.find(item => item.stage === stage)?._count._all ?? 0 })),
      exceptions: this.exceptions(trouble, troubleDeadlines, now),
      write,
      freshness,
    }
  }

  /** 异常队列：差异处理中、操作失败、48 小时内到期（方案过期或作废窗口）。按时间从近到远。 */
  private exceptions(plans: FbaInboundPlan[], deadlines: Awaited<ReturnType<typeof nextDeadlines>>, now: Date): InboundException[] {
    const soon = now.getTime() + 48 * 3_600_000
    const result: InboundException[] = []
    for (const plan of plans) {
      if (plan.stage === 'DISCREPANCY') result.push({ kind: 'DISCREPANCY', planId: plan.id, planName: plan.name, message: '货件已关闭，收到的数量与发出的不一致', at: iso(plan.updatedAt) })
      else if (plan.lastErrorCode && !plan.pendingOp && !FINAL.includes(plan.stage))
        result.push({ kind: 'OP_FAILED', planId: plan.id, planName: plan.name, message: plan.lastErrorMessage ?? '上一次操作失败', at: iso(plan.updatedAt) })
      const deadline = deadlines.get(plan.id)
      if (deadline && new Date(deadline.at).getTime() <= soon) {
        const text = deadline.kind === 'VOID_WINDOW' ? '作废窗口即将结束' : deadline.kind === 'PLACEMENT_EXPIRES' ? '分仓方案即将过期' : '装箱方案即将过期'
        result.push({ kind: 'EXPIRING', planId: plan.id, planName: plan.name, message: text, at: deadline.at })
      }
    }
    return result.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).slice(0, 50)
  }

  async overview(req: RequestWithContext, id: string): Promise<InboundOverview> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const now = new Date()
    const tenantId = context.tenantId
    const stage: InboundStage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
    const [row, items, checks, packing, placement, transport, offeredPacking, offeredPlacement, write] = await Promise.all([
      singlePlanRow(this.prisma, plan, now),
      this.prisma.inboundPlanItem.findMany({ where: { tenantId, planId: plan.id }, orderBy: { sku: 'asc' }, take: 500 }),
      this.prisma.inboundEligibilityCheck.findMany({ where: { tenantId, planId: plan.id }, orderBy: { checkedAt: 'desc' }, take: 2000 }),
      this.prisma.packingOption.findFirst({ where: { tenantId, planId: plan.id, confirmed: true } }),
      this.prisma.placementOption.findFirst({ where: { tenantId, planId: plan.id, confirmed: true } }),
      this.prisma.transportOption.findMany({ where: { tenantId, planId: plan.id, confirmed: true }, take: 200 }),
      this.prisma.packingOption.aggregate({ where: { tenantId, planId: plan.id, status: 'OFFERED' }, _min: { expiresAt: true } }),
      this.prisma.placementOption.aggregate({ where: { tenantId, planId: plan.id, status: 'OFFERED' }, _min: { expiresAt: true } }),
      writeStatuses(this.guard, context, plan.sellerAccountId),
    ])
    const latest = new Map<string, (typeof checks)[number]>()
    for (const check of checks) if (!latest.has(check.sku)) latest.set(check.sku, check)
    const itemViews: InboundItemView[] = items.map(item => {
      const check = latest.get(item.sku)
      return {
        sku: item.sku,
        fnsku: item.fnsku,
        asin: item.asin,
        productName: item.productName,
        quantity: item.quantity,
        expiry: item.expiry ? item.expiry.toISOString().slice(0, 10) : null,
        prepInstruction: item.prepInstruction,
        eligibility: check ? { eligible: check.eligible, reasonCodes: check.reasonCodes, checkedAt: check.checkedAt.toISOString() } : null,
      }
    })
    const index = inboundStageIndex(stage)
    const stageChain = INBOUND_STEP_CHAIN.map(step => ({
      stage: step,
      label: INBOUND_STAGE_LABEL[step],
      state: stage === 'CANCELLED' ? ('TODO' as const) : inboundStageIndex(step) < index ? ('DONE' as const) : step === stage ? ('CURRENT' as const) : ('TODO' as const),
    }))
    const hint = NEXT_ACTION[stage]
    const pending = plan.pendingOp as InboundOp | null
    const costs = this.costs(plan, { packing, placement, transport })
    return {
      plan: row,
      address: this.address(plan.sourceAddress),
      steps: inboundFlowSteps({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt, lastErrorMessage: plan.lastErrorMessage }, now),
      stageChain,
      nextAction: pending
        ? { action: null, text: `亚马逊正在处理：${INBOUND_OP_LABEL[pending] ?? pending}，完成前不能做其他操作` }
        : hint
          ? { action: hint.action, text: hint.text }
          : { action: null, text: STAGE_NOTE[stage] ?? '' },
      actions: inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt }, now),
      deadlines: { placementExpiresAt: iso(offeredPlacement._min.expiresAt), packingExpiresAt: iso(offeredPacking._min.expiresAt), voidWindow: voidWindowOf(plan.voidDeadlineAt, now) },
      items: itemViews,
      eligibilitySummary: { checked: latest.size, ineligible: [...latest.values()].filter(check => !check.eligible).length, unchecked: items.filter(item => !latest.has(item.sku)).length },
      costs,
      write,
      cancelNote: CANCEL_NOTE,
    }
  }

  private address(raw: string): Record<string, unknown> | null {
    try {
      return record(JSON.parse(raw))
    } catch {
      return null
    }
  }

  /** 费用汇总：只合计已知项，缺哪项列哪项；分仓费与运输费要等方案确认后才有。 */
  private costs(
    plan: FbaInboundPlan,
    picked: {
      packing: { fees: Prisma.Decimal | null; discounts: Prisma.Decimal | null } | null
      placement: { fees: Prisma.Decimal; discounts: Prisma.Decimal } | null
      transport: Array<{ cost: Prisma.Decimal | null }>
    },
  ): InboundCostsView {
    const missing: string[] = []
    const packingFee = picked.packing ? (picked.packing.fees === null ? null : num(picked.packing.fees)! - (num(picked.packing.discounts) ?? 0)) : null
    if (picked.packing && packingFee === null) missing.push('装箱费（亚马逊没有给出金额或币种不一致）')
    const placementFee = picked.placement ? num(picked.placement.fees) : null
    const placementDiscount = picked.placement ? num(picked.placement.discounts) : null
    if (!picked.placement) missing.push('分仓费（分仓方案尚未确认）')
    const known = picked.transport.filter(option => option.cost !== null)
    const transportCost = known.length > 0 && known.length === picked.transport.length ? known.reduce((sum, option) => sum + num(option.cost)!, 0) : null
    if (picked.transport.length === 0) missing.push('运输费（运输方案尚未确认）')
    else if (transportCost === null) missing.push('运输费（部分货件没有报价，例如使用自己的承运商）')
    const prepCost = num(plan.prepCost)
    const labelCost = num(plan.labelCost)
    if (prepCost === null) missing.push('预处理费用（卖家自理，未填写）')
    if (labelCost === null) missing.push('贴标费用（卖家自理，未填写）')
    const parts = [packingFee, placementFee === null ? null : placementFee - (placementDiscount ?? 0), transportCost, prepCost, labelCost].filter((value): value is number => value !== null)
    return {
      currency: plan.costCurrency,
      packingFee,
      placementFee,
      placementDiscount,
      transportCost,
      prepCost,
      labelCost,
      estimate: plan.estimateJson ? (plan.estimateJson as PlacementEstimate) : null,
      knownTotal: parts.length ? Math.round(parts.reduce((sum, value) => sum + value, 0) * 100) / 100 : null,
      missing,
    }
  }

  async operations(req: RequestWithContext, id: string): Promise<{ operations: InboundOperationView[] }> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const rows = await this.prisma.inboundOperation.findMany({ where: { tenantId: context.tenantId, planId: plan.id }, orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: 200 })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.requestedBy),
    )
    return {
      operations: rows.map(row => ({
        id: row.id,
        operation: row.operation as InboundOp,
        operationLabel: INBOUND_OP_LABEL[row.operation as InboundOp] ?? row.operation,
        amazonOperationId: row.operationId,
        status: row.status as InboundOpStatus,
        statusLabel: INBOUND_OP_STATUS_LABEL[row.status as InboundOpStatus] ?? row.status,
        problems: Array.isArray(row.problemsJson) ? (row.problemsJson as InboundOperationView['problems']) : [],
        errorCode: row.errorCode,
        requestedBy: nameOrFormer(names, row.requestedBy),
        startedAt: row.startedAt.toISOString(),
        finishedAt: iso(row.finishedAt),
      })),
    }
  }

  /** 标签：每个打印任务一行，已生成的给 5 分钟有效的下载链接。 */
  async labels(req: RequestWithContext, id: string): Promise<InboundLabelsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const jobs = await this.prisma.labelPrintJob.findMany({ where: { tenantId: context.tenantId, planId: plan.id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 200 })
    const labels: InboundLabelView[] = []
    for (const job of jobs) {
      let url: string | null = null
      if (job.status === 'READY' && job.objectKey) {
        try {
          url = (await this.objects.forTenant(context.tenantId).signDownload(job.objectKey, LABEL_LINK_TTL_SECONDS)).url
        } catch (error) {
          throw storageAppError(error)
        }
      }
      labels.push({
        id: job.id,
        kind: job.kind === 'ITEM' ? 'ITEM' : 'BOX',
        shipmentId: job.shipmentId,
        status: job.status,
        statusLabel: { QUEUED: '排队中', GENERATING: '生成中', READY: '可下载', FAILED: '失败' }[job.status] ?? job.status,
        pageType: job.pageType,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt.toISOString(),
        url,
      })
    }
    return {
      labels,
      note: '箱标签由亚马逊生成（PDF）。在它的基础上可以按标签模板生成自定义箱标签（亚马逊标签不改动，另附一张文字页，热敏纸也可以追加在空白区）；商品标签（FNSKU）由系统按货件明细生成条码 PDF。生成的文件在导出中心下载。',
      printStats: await this.printStats(context.tenantId, plan.id, jobs),
    }
  }

  /** 按货件统计：箱数、已取到亚马逊箱标签的纸张类型、自定义箱标签与商品标签各生成过几次（只数成功生成的文件）。 */
  private async printStats(tenantId: string, planId: string, jobs: ReadonlyArray<{ shipmentId: string | null; kind: string; status: string; pageType: string | null }>): Promise<LabelPrintStat[]> {
    const [shipments, logs] = await Promise.all([
      this.prisma.fbaInboundShipment.findMany({
        where: { planId },
        select: { id: true, shipmentId: true, shipmentConfirmationId: true, boxCount: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
      this.prisma.labelPrintLog.groupBy({ by: ['shipmentId', 'kind'], where: { tenantId, planId }, _count: { _all: true }, _max: { printedAt: true } }),
    ])
    return shipments.map(shipment => {
      const own = logs.filter(item => item.shipmentId === shipment.id)
      const count = (kind: string) => own.filter(item => item.kind === kind).reduce((sum, item) => sum + item._count._all, 0)
      const latest = own.reduce<Date | null>((best, item) => (item._max.printedAt && (!best || item._max.printedAt > best) ? item._max.printedAt : best), null)
      const ready = jobs.filter(job => job.shipmentId === shipment.shipmentId && job.kind === 'BOX' && job.status === 'READY' && job.pageType)
      return {
        shipmentRowId: shipment.id,
        shipmentId: shipment.shipmentConfirmationId ?? shipment.shipmentId,
        boxes: shipment.boxCount,
        customCount: count('BOX_CUSTOM'),
        itemCount: count('ITEM'),
        lastPrintedAt: iso(latest),
        readyPageTypes: [...new Set(ready.map(job => job.pageType!))],
      }
    })
  }
}
