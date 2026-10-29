import { Injectable } from '@nestjs/common'
import {
  InboundBoxesBodySchema,
  InboundCancelBodySchema,
  InboundCostsBodySchema,
  InboundPlanCreateBodySchema,
  InboundVersionBodySchema,
  US_MARKETPLACE_ID,
  inboundPlanActions,
  isInboundStage,
  validateBoxes,
  type InboundAction,
  type InboundActionResponse,
  type InboundBoxInput,
} from '@nova/api-contracts'
import { Prisma, type FbaInboundPlan } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, assertStoreInScope } from '../auth'
import { ConnectionsService } from '../connections'
import { INBOUND_WRITE, loadPlan, singlePlanRow } from './inbound-common'
import { InboundJobsService } from './inbound-jobs.service'

/** 在保存箱子的同一个事务里还要做的事（例如把外部货号记进映射表）；返回的内容并入审计详情。 */
export type BoxesTxHook = (tx: Prisma.TransactionClient) => Promise<Record<string, unknown>>

const pad = (value: number) => String(value).padStart(3, '0')

// 入仓计划里不调用亚马逊的写入：创建草稿、保存箱内物品、填写自理成本与估算、标记已发货、本地取消。
// 都要求权限与乐观锁版本号，都写审计；不受写入开关控制（没有任何数据发给亚马逊）。
@Injectable()
export class InboundDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly connections: ConnectionsService,
    private readonly audit: AuditWriter,
    private readonly jobs: InboundJobsService,
  ) {}

  private allowed(plan: FbaInboundPlan, action: InboundAction) {
    const stage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
    const state = inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt })[action]
    if (!state.allowed) throw appError('CONFLICT', state.reason ?? '当前状态不允许这个操作', { details: { stage, pendingOp: plan.pendingOp } })
  }

  private async saved(plan: FbaInboundPlan): Promise<InboundActionResponse> {
    return { plan: await singlePlanRow(this.prisma, plan), state: 'SAVED', jobId: null, operationId: null }
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = InboundPlanCreateBodySchema.parse(rawBody)
    let sellerAccountId = body.sellerAccountId
    if (!sellerAccountId) {
      const connection = await this.connections.authorizedSpConnection(context.tenantId)
      sellerAccountId = (await this.connections.sellerAccountOf(context.tenantId, connection))?.id
      if (!sellerAccountId) throw appError('CONFLICT', '创建入仓计划前，需要先完成卖家授权', { details: { step: 'CONNECTION', remedyPath: '/app/connections' } })
    }
    assertStoreInScope(scope, sellerAccountId)
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: sellerAccountId, tenantId: context.tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    // 商品信息（ASIN、FNSKU、标题）取自商品目录；目录里没有的 SKU 不能入仓
    const products = await this.prisma.fbaProduct.findMany({
      where: { tenantId: context.tenantId, sellerAccountId: store.id, marketplaceId: US_MARKETPLACE_ID, sellerSku: { in: body.items.map(item => item.sku) } },
      select: { sellerSku: true, asin: true, fnsku: true, title: true },
      take: 500,
    })
    const unknown = body.items.filter(item => !products.some(product => product.sellerSku === item.sku)).map(item => item.sku)
    if (unknown.length > 0)
      throw appError('VALIDATION_FAILED', `这些 SKU 不在商品目录里：${unknown.slice(0, 10).join('、')}${unknown.length > 10 ? ' 等' : ''}`, {
        fieldErrors: { items: unknown.map(sku => `${sku} 不在商品目录里`) },
      })
    const plan = await this.prisma.$transaction(async tx => {
      const created = await tx.fbaInboundPlan.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: store.id,
          marketplaceId: US_MARKETPLACE_ID,
          name: body.name,
          status: 'DRAFT',
          stage: 'DRAFT',
          sourceAddress: JSON.stringify(body.sourceAddress),
          sourceType: body.sourceType,
          sourceRefId: body.sourceRefId,
          totalUnits: body.items.reduce((sum, item) => sum + item.quantity, 0),
          createdBy: context.userId,
        },
      })
      await tx.inboundPlanItem.createMany({
        data: body.items.map(item => {
          const product = products.find(candidate => candidate.sellerSku === item.sku)
          return {
            tenantId: context.tenantId,
            planId: created.id,
            sku: item.sku,
            quantity: item.quantity,
            expiry: item.expiry ? new Date(`${item.expiry}T00:00:00Z`) : null,
            asin: product?.asin,
            fnsku: product?.fnsku,
            productName: product?.title,
          }
        }),
      })
      await this.audit.record(
        req,
        {
          action: 'FBA_INBOUND_PLAN_CREATED',
          resourceType: 'FbaInboundPlan',
          resourceId: created.id,
          after: { name: created.name, stage: created.stage, units: created.totalUnits, source: body.sourceType },
          detail: { skuCount: body.items.length },
        },
        { client: tx },
      )
      return created
    })
    return this.saved(plan)
  }

  /** 保存箱内物品（整体替换）：不要求已经对齐，提交给亚马逊前才强制校验；箱号缺省时自动编号。 */
  async saveBoxes(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = InboundBoxesBodySchema.parse(rawBody)
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    this.allowed(plan, 'SAVE_BOXES')
    return this.replaceBoxes(req, plan, body.version, body.boxes, 'FBA_INBOUND_BOXES_SAVED')
  }

  /** 整体替换计划的箱子（手工保存与文件导入共用）：校验箱号不重复、SKU 都在计划里，缺箱号的自动编号；在一个事务里带版本号落库并写审计。 */
  async replaceBoxes(
    req: RequestWithContext,
    plan: FbaInboundPlan,
    version: number,
    boxes: InboundBoxInput[],
    action: string,
    extra: Record<string, unknown> = {},
    beforeCommit?: BoxesTxHook,
  ): Promise<InboundActionResponse> {
    const given = boxes.flatMap(box => (box.boxId ? [box.boxId] : []))
    const dup = given.find((boxId, index) => given.indexOf(boxId) !== index)
    if (dup) throw appError('VALIDATION_FAILED', `箱号 ${dup} 重复`, { fieldErrors: { boxes: [`箱号 ${dup} 重复`] } })
    const items = await this.prisma.inboundPlanItem.findMany({ where: { tenantId: plan.tenantId, planId: plan.id }, select: { sku: true, quantity: true }, take: 500 })
    const unknown = validateBoxes(items, boxes).unknownSkus
    if (unknown.length > 0) throw appError('VALIDATION_FAILED', `这些 SKU 不在计划里：${unknown.slice(0, 10).join('、')}`, { fieldErrors: { boxes: unknown.map(sku => `${sku} 不在计划里`) } })
    let counter = 0
    const nextId = () => {
      let boxId: string
      do boxId = `BOX-${pad(++counter)}`
      while (given.includes(boxId))
      return boxId
    }
    const rows = boxes.map(box => ({
      tenantId: plan.tenantId,
      planId: plan.id,
      boxId: box.boxId ?? nextId(),
      packingGroupId: box.packingGroupId ?? null,
      quantity: box.quantity,
      weightLb: box.weightLb,
      lengthIn: box.lengthIn,
      widthIn: box.widthIn,
      heightIn: box.heightIn,
      contentJson: box.items as unknown as Prisma.InputJsonValue,
    }))
    const updated = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.fbaInboundPlan, { id: plan.id, tenantId: plan.tenantId }, version, {}, { label: '入仓计划' })
      await tx.inboundBox.deleteMany({ where: { tenantId: plan.tenantId, planId: plan.id } })
      await tx.inboundBox.createMany({ data: rows })
      const hooked = beforeCommit ? await beforeCommit(tx) : {}
      await this.audit.record(
        req,
        { action, resourceType: 'FbaInboundPlan', resourceId: plan.id, detail: { boxLines: rows.length, boxes: rows.reduce((sum, row) => sum + row.quantity, 0), ...extra, ...hooked } },
        { client: tx },
      )
      return next
    })
    return this.saved(updated)
  }

  /** 填写卖家自理的预处理与贴标费用、分仓方案总成本的估算参数。 */
  async costs(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = InboundCostsBodySchema.parse(rawBody)
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const data: Prisma.FbaInboundPlanUncheckedUpdateManyInput = {
      ...(body.prepCost !== undefined ? { prepCost: body.prepCost } : {}),
      ...(body.labelCost !== undefined ? { labelCost: body.labelCost } : {}),
      ...(body.estimate !== undefined ? { estimateJson: body.estimate as Prisma.InputJsonValue } : {}),
    }
    const updated = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.fbaInboundPlan, { id: plan.id, tenantId: plan.tenantId }, body.version, data as Record<string, unknown>, { label: '入仓计划' })
      await this.audit.record(
        req,
        {
          action: 'FBA_INBOUND_COSTS_UPDATED',
          resourceType: 'FbaInboundPlan',
          resourceId: plan.id,
          before: { prepCost: plan.prepCost, labelCost: plan.labelCost, estimate: plan.estimateJson },
          after: { prepCost: next.prepCost, labelCost: next.labelCost, estimate: next.estimateJson },
        },
        { client: tx },
      )
      return next
    })
    return this.saved(updated)
  }

  /** 标记已发货：只在我方推进状态（亚马逊没有“发货”操作，CR-007），需要标签已打印。 */
  async markShipped(req: RequestWithContext, id: string, rawBody: unknown): Promise<InboundActionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    const body = InboundVersionBodySchema.parse(rawBody)
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    this.allowed(plan, 'MARK_SHIPPED')
    return this.advance(req, plan, body.version, { stage: 'SHIPPED', shippedAt: new Date() }, 'FBA_INBOUND_MARKED_SHIPPED')
  }

  async cancelLocal(req: RequestWithContext, _context: ApiContext, plan: FbaInboundPlan, rawBody: unknown): Promise<InboundActionResponse> {
    const body = InboundCancelBodySchema.parse(rawBody)
    this.allowed(plan, 'CANCEL')
    return this.advance(req, plan, body.version, { stage: 'CANCELLED', status: 'CANCELLED' }, 'FBA_INBOUND_PLAN_CANCELLED', body.reason)
  }

  async cancelRemote(req: RequestWithContext, context: ApiContext, plan: FbaInboundPlan, rawBody: unknown): Promise<InboundActionResponse> {
    const body = InboundCancelBodySchema.parse(rawBody)
    return this.jobs.enqueue(req, context, plan, { action: 'CANCEL', operation: 'CANCEL_PLAN', version: body.version, audit: { action: 'FBA_INBOUND_PLAN_CANCELLED', reason: body.reason } })
  }

  private async advance(
    req: RequestWithContext,
    plan: FbaInboundPlan,
    version: number,
    data: Prisma.FbaInboundPlanUncheckedUpdateManyInput,
    action: string,
    reason?: string,
  ): Promise<InboundActionResponse> {
    const updated = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.fbaInboundPlan, { id: plan.id, tenantId: plan.tenantId }, version, data as Record<string, unknown>, { label: '入仓计划' })
      await this.audit.record(
        req,
        { action, resourceType: 'FbaInboundPlan', resourceId: plan.id, before: { stage: plan.stage }, after: { stage: next.stage }, ...(reason ? { reason } : {}) },
        { client: tx },
      )
      return next
    })
    return this.saved(updated)
  }
}
