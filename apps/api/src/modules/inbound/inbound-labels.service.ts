import { Injectable } from '@nestjs/common'
import {
  BOX_LABEL_KIND,
  BOX_NO_MAX_LENGTH,
  CustomLabelBodySchema,
  ITEM_LABEL_KIND,
  ITEM_LABEL_MAX,
  ITEM_LABEL_MAX_SKUS,
  ITEM_LABEL_SIZE_SPEC,
  ItemLabelBodySchema,
  LABEL_EXPORT_PATH,
  LABEL_MAX_BOXES,
  LABEL_PAPER_SPEC,
  LABEL_TEMPLATE_ACTIONS,
  LABEL_TEMPLATE_READ,
  boxContentFacts,
  boxLabelLines,
  formatBoxNo,
  itemLabelsTotal,
  type BoxLabelJob,
  type ItemLabelJob,
  type ItemLabelLine,
  type LabelGenerateResponse,
} from '@nova/api-contracts'
import type { FbaInboundPlan, FbaInboundShipment } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { ExportsService } from '../exports'
import { LabelTemplatesService } from '../label-templates'
import { INBOUND_WRITE, loadPlan, record } from './inbound-common'

const asItems = (value: unknown) =>
  (Array.isArray(value) ? value : []).map(record).flatMap(item => (typeof item.sku === 'string' && typeof item.quantity === 'number' ? [{ sku: item.sku, quantity: item.quantity }] : []))
/** 条码只能编 ASCII 可打印字符；FNSKU 不符合的当作“没有可用的 FNSKU”。 */
const barcodeOk = (value: string | null | undefined): value is string => typeof value === 'string' && /^[\x20-\x7E]+$/.test(value)
const listSkus = (skus: readonly string[]) => `${skus.slice(0, 10).join('、')}${skus.length > 10 ? ` 等 ${skus.length} 个` : ''}`

// 自定义箱标签与商品标签（P6-12，16 章 5.1、5.2 节）：都是本地生成 PDF，不调用亚马逊写接口、不受写入开关控制；
// 生成放在后台任务里，结果走导出中心（文件保留期、下载权限、审计都沿用导出任务）。
// 这里只做业务校验并整理任务快照（模板、箱号、箱内内容、纸张）：快照存进导出任务，之后改模板不影响已经发起的任务。
@Injectable()
export class InboundLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly templates: LabelTemplatesService,
    private readonly exportsService: ExportsService,
  ) {}

  /** 权限：入仓写入（@Write 已预检）、入仓查看（worker 生成时要求）、导出权限（文件在导出中心）；计划必须在数据范围内。 */
  private async open(req: RequestWithContext) {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_WRITE, {})
    this.context.require(context, LABEL_TEMPLATE_READ)
    this.context.require(context, 'export.create')
    return { context, scope }
  }

  /** 本货件之前的货件一共多少个箱子：每个货件的箱号接着上一个货件往下编（货件按创建先后排）。 */
  private async boxesBefore(shipment: FbaInboundShipment): Promise<number> {
    const siblings = await this.prisma.fbaInboundShipment.findMany({
      where: { planId: shipment.planId },
      select: { id: true, boxCount: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    })
    let total = 0
    for (const sibling of siblings) {
      if (sibling.id === shipment.id) break
      total += sibling.boxCount ?? 0
    }
    return total
  }

  async custom(req: RequestWithContext, shipmentRowId: string, rawBody: unknown): Promise<LabelGenerateResponse> {
    const { context, scope } = await this.open(req)
    const body = CustomLabelBodySchema.parse(rawBody)
    const target = await this.prisma.fbaInboundShipment.findFirst({ where: { id: shipmentRowId, plan: { tenantId: context.tenantId } } })
    if (!target) throw appError('RESOURCE_NOT_FOUND', '货件不存在')
    const plan = await loadPlan(this.prisma, context.tenantId, scope, target.planId)
    const template = await this.templates.resolve(context.tenantId, body.templateId)
    const spec = LABEL_PAPER_SPEC[template.paper]
    const boxCount = target.boxCount ?? 0
    if (boxCount < 1) throw appError('CONFLICT', '这个货件还没有箱数（运输方案确认后才有），暂时不能生成箱标签')
    if (boxCount > LABEL_MAX_BOXES) throw appError('VALIDATION_FAILED', `一个货件最多生成 ${LABEL_MAX_BOXES} 个箱子的标签，这个货件有 ${boxCount} 个`)
    const base = await this.prisma.labelPrintJob.findFirst({
      where: { tenantId: context.tenantId, planId: plan.id, shipmentId: target.shipmentId, kind: 'BOX', status: 'READY', pageType: spec.amazonPageType, objectKey: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { id: true },
    })
    if (!base) {
      throw appError('CONFLICT', `还没有取到“${spec.label}”的亚马逊箱标签：请先在“标签”页签点“获取箱标签”，页面类型选 ${spec.amazonPageType}，取到后再生成`, {
        details: { pageType: spec.amazonPageType, shipmentId: target.shipmentId },
      })
    }
    const planNo = plan.externalPlanId ?? plan.id.slice(-6)
    const startNumber = body.startNumber ?? template.boxNoRule.start + (await this.boxesBefore(target))
    const lastNo = formatBoxNo(template.boxNoRule, planNo, boxCount - 1, startNumber)
    if (lastNo.length > BOX_NO_MAX_LENGTH)
      throw appError('VALIDATION_FAILED', `箱号太长（最多 ${BOX_NO_MAX_LENGTH} 个字符），请缩短模板里的前缀、后缀或位数`, { fieldErrors: { startNumber: ['起始序号过大，箱号超长'] } })
    const { facts, notes } = await this.contentFacts(context.tenantId, plan, target, boxCount)
    const firstLines = boxLabelLines(template.options, formatBoxNo(template.boxNoRule, planNo, 0, startNumber), facts)
    if (firstLines.length === 0 && !template.options.taskNamePage)
      throw appError('CONFLICT', '按这个模板没有任何内容可以追加到标签上（勾选的内容都不能确定，也没有勾选任务名称页），请调整模板后再生成', { details: { notes: notes.join('；') } })
    const payload: BoxLabelJob = {
      planId: plan.id,
      shipmentRowId: target.id,
      shipmentLabel: target.shipmentConfirmationId ?? target.shipmentId,
      destinationFc: target.destinationFc,
      planName: plan.name,
      planNo,
      baseLabelJobId: base.id,
      templateId: template.id,
      templateName: template.name,
      paper: template.paper,
      options: template.options,
      boxNoRule: template.boxNoRule,
      boxCount,
      startNumber,
      facts,
      notes,
    }
    const job = await this.exportsService.enqueueDocument(req, context, {
      kind: BOX_LABEL_KIND,
      filterSummary: `自定义箱标签：${target.shipmentConfirmationId ?? target.shipmentId} · ${boxCount} 箱 · 模板“${template.name}”（${spec.label}）`,
      payload: payload as unknown as Record<string, unknown>,
      scope: { unrestricted: scope.unrestricted, storeIds: scope.sellerAccountIds },
      audit: {
        action: LABEL_TEMPLATE_ACTIONS.boxRequested,
        resourceType: 'FbaInboundShipment',
        resourceId: target.id,
        detail: { planId: plan.id, templateId: template.id, paper: template.paper, boxCount, startNumber },
      },
    })
    return this.response(job, notes)
  }

  /** 箱内内容：只有能确定时才给（见 boxContentFacts）；品名与 FNSKU 取自入仓计划里的商品。 */
  private async contentFacts(tenantId: string, plan: FbaInboundPlan, shipment: FbaInboundShipment, boxCount: number) {
    const [boxes, shipmentItems, planItems] = await Promise.all([
      this.prisma.inboundBox.findMany({ where: { tenantId, planId: plan.id }, select: { quantity: true, contentJson: true }, take: 5000 }),
      this.prisma.shipmentItem.findMany({ where: { tenantId, planId: plan.id, shipmentId: shipment.shipmentId }, select: { sku: true, fnsku: true, shippedQty: true }, take: 1000 }),
      this.prisma.inboundPlanItem.findMany({ where: { tenantId, planId: plan.id }, select: { sku: true, fnsku: true, productName: true }, take: 1000 }),
    ])
    const names = new Map<string, { productName: string | null; fnsku: string | null }>()
    for (const item of planItems) names.set(item.sku, { productName: item.productName, fnsku: item.fnsku })
    for (const item of shipmentItems) if (item.fnsku) names.set(item.sku, { productName: names.get(item.sku)?.productName ?? null, fnsku: item.fnsku })
    const result = boxContentFacts({
      boxes: boxes.map(box => ({ quantity: box.quantity, items: asItems(box.contentJson) })),
      shipmentItems: shipmentItems.map(item => ({ sku: item.sku, quantity: item.shippedQty })),
      boxCount,
      names,
    })
    return { facts: result.facts, notes: result.note ? [result.note] : [] }
  }

  async items(req: RequestWithContext, planId: string, rawBody: unknown): Promise<LabelGenerateResponse> {
    const { context, scope } = await this.open(req)
    const body = ItemLabelBodySchema.parse(rawBody)
    const plan = await loadPlan(this.prisma, context.tenantId, scope, planId)
    const shipment = body.shipmentId ? await this.prisma.fbaInboundShipment.findFirst({ where: { id: body.shipmentId, planId: plan.id } }) : null
    if (body.shipmentId && !shipment) throw appError('RESOURCE_NOT_FOUND', '货件不属于这个计划')
    const planItems = await this.prisma.inboundPlanItem.findMany({
      where: { tenantId: context.tenantId, planId: plan.id },
      select: { sku: true, fnsku: true, productName: true, quantity: true },
      orderBy: { sku: 'asc' },
      take: 1000,
    })
    const byPlan = new Map(planItems.map(item => [item.sku, item]))
    const source = shipment
      ? (
          await this.prisma.shipmentItem.findMany({
            where: { tenantId: context.tenantId, planId: plan.id, shipmentId: shipment.shipmentId },
            select: { sku: true, fnsku: true, shippedQty: true },
            orderBy: { sku: 'asc' },
            take: 1000,
          })
        ).map(item => ({
          sku: item.sku,
          fnsku: item.fnsku ?? byPlan.get(item.sku)?.fnsku ?? null,
          quantity: item.shippedQty,
        }))
      : planItems.map(item => ({ sku: item.sku, fnsku: item.fnsku, quantity: item.quantity }))
    const wanted = source.filter(item => item.quantity > 0)
    if (wanted.length === 0) throw appError('CONFLICT', shipment ? '这个货件没有商品明细，不能生成商品标签' : '这个计划没有商品，不能生成商品标签')
    const usable = wanted.filter(item => barcodeOk(item.fnsku))
    const missing = wanted.filter(item => !barcodeOk(item.fnsku)).map(item => item.sku)
    const notes: string[] = []
    if (missing.length > 0) {
      if (!body.skipMissingFnsku)
        throw appError('CONFLICT', `这些 SKU 没有可用的 FNSKU，不能生成条码：${listSkus(missing)}；请先补全，或勾选“跳过没有 FNSKU 的商品”`, { details: { skus: missing.slice(0, 50).join(',') } })
      notes.push(`已跳过没有可用 FNSKU 的商品：${listSkus(missing)}`)
    }
    if (usable.length === 0) throw appError('CONFLICT', '所有商品都没有可用的 FNSKU，没有可生成的标签')
    if (usable.length > ITEM_LABEL_MAX_SKUS) throw appError('VALIDATION_FAILED', `一次最多 ${ITEM_LABEL_MAX_SKUS} 个 SKU，这次有 ${usable.length} 个，请按货件分开生成`)
    const titles = body.showTitle
      ? await this.titles(
          context.tenantId,
          plan.sellerAccountId,
          usable.map(item => item.sku),
          byPlan,
        )
      : new Map<string, string>()
    const lines: ItemLabelLine[] = usable.map(item => ({ sku: item.sku, fnsku: item.fnsku!, title: titles.get(item.sku) ?? null, quantity: item.quantity }))
    const total = itemLabelsTotal(lines)
    if (total > ITEM_LABEL_MAX) throw appError('VALIDATION_FAILED', `一次最多生成 ${ITEM_LABEL_MAX} 张商品标签，这次有 ${total} 张，请按货件分开生成`)
    const payload: ItemLabelJob = { planId: plan.id, shipmentRowId: shipment?.id ?? null, size: body.size, showTitle: body.showTitle, showCondition: body.showCondition, lines }
    const scopeText = shipment ? (shipment.shipmentConfirmationId ?? shipment.shipmentId) : '整个计划'
    const job = await this.exportsService.enqueueDocument(req, context, {
      kind: ITEM_LABEL_KIND,
      filterSummary: `商品标签：${plan.name} · ${scopeText} · ${total} 张（${ITEM_LABEL_SIZE_SPEC[body.size].label}）`,
      payload: payload as unknown as Record<string, unknown>,
      scope: { unrestricted: scope.unrestricted, storeIds: scope.sellerAccountIds },
      audit: {
        action: LABEL_TEMPLATE_ACTIONS.itemRequested,
        resourceType: 'FbaInboundPlan',
        resourceId: plan.id,
        detail: { shipmentId: shipment?.id ?? null, size: body.size, skus: lines.length, labels: total },
      },
    })
    return this.response(job, notes)
  }

  /** 品名：入仓计划里的商品名优先，没有的取商品目录里的标题。 */
  private async titles(tenantId: string, sellerAccountId: string, skus: readonly string[], byPlan: ReadonlyMap<string, { productName: string | null }>) {
    const result = new Map<string, string>()
    for (const sku of skus) {
      const name = byPlan.get(sku)?.productName
      if (name) result.set(sku, name)
    }
    const rest = skus.filter(sku => !result.has(sku))
    if (rest.length > 0) {
      const rows = await this.prisma.fbaProduct.findMany({ where: { tenantId, sellerAccountId, sellerSku: { in: [...rest] } }, select: { sellerSku: true, title: true }, take: rest.length })
      for (const row of rows) if (row.title) result.set(row.sellerSku, row.title)
    }
    return result
  }

  private response(job: { id: string; status: string; statusLabel: string; kindLabel: string }, notes: string[]): LabelGenerateResponse {
    return { exportId: job.id, status: job.status, statusLabel: job.statusLabel, kindLabel: job.kindLabel, notes: [...notes, `文件在导出中心生成，完成后到 ${LABEL_EXPORT_PATH} 下载`] }
  }
}
