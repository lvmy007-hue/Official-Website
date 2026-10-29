import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { LABEL_TEMPLATE_ACTIONS } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { InboundBoxImportService } from './inbound-box-import.service'
import { InboundDraftService } from './inbound-draft.service'
import { InboundLabelsService } from './inbound-labels.service'
import { InboundOptionsService } from './inbound-options.service'
import { InboundPackingListService } from './inbound-packing-list.service'
import { InboundReadService } from './inbound-read.service'
import { InboundShipmentGapService } from './inbound-shipment-gap.service'
import { InboundShipmentsService } from './inbound-shipments.service'
import { InboundWriteService } from './inbound-write.service'

const PERMISSION = 'inbound.plan.write'

// 入仓计划（P2a-12，06 章 6.11；freeze/api.md 第九节）。查询参数类型必须直接写 Record<string, string>，不能起别名，否则所有请求返回 422。
// 写接口都带乐观锁版本号；要调用亚马逊的依次通过：权限 → 店铺连接 → 写入开关（生成方案、资格预检、取标签不受开关控制）。
@UseGuards(AuthGuard)
@Controller('inbound')
export class InboundPlansController {
  constructor(
    private readonly read: InboundReadService,
    private readonly options: InboundOptionsService,
    private readonly shipments: InboundShipmentsService,
    private readonly drafts: InboundDraftService,
    private readonly writes: InboundWriteService,
    private readonly boxImport: InboundBoxImportService,
    private readonly packingList: InboundPackingListService,
    private readonly labelJobs: InboundLabelsService,
    private readonly gaps: InboundShipmentGapService,
  ) {}

  // 装箱表格文件模板：静态路径，与 `plans/:id` 不冲突
  @Get('box-templates/:kind')
  async boxTemplate(@Req() req: RequestWithContext, @Param('kind') kind: string) {
    return ok(await this.boxImport.template(req, kind), req)
  }

  @Get('plans')
  async plans(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.read.list(req, query), req)
  }

  @Write({ action: 'FBA_INBOUND_PLAN_CREATED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans')
  async create(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.drafts.create(req, body), req)
  }

  @Get('plans/:id')
  async overview(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.read.overview(req, id), req)
  }

  @Get('plans/:id/options')
  async planOptions(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.options.options(req, id), req)
  }

  @Get('plans/:id/boxes')
  async boxes(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.options.boxes(req, id), req)
  }

  @Get('plans/:id/shipments')
  async planShipments(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.options.shipments(req, id), req)
  }

  @Get('plans/:id/operations')
  async operations(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.read.operations(req, id), req)
  }

  @Get('plans/:id/labels')
  async labels(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.read.labels(req, id), req)
  }

  @Write({ action: 'FBA_INBOUND_ELIGIBILITY_CHECKED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/eligibility')
  async eligibility(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.eligibility(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_PLAN_SUBMITTED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/submit')
  async submit(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.submit(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_PACKING_OPTION', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/packing-options')
  async packingOptions(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.packingOptions(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_BOXES_SAVED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Put('plans/:id/boxes')
  async saveBoxes(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.drafts.saveBoxes(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_BOXES_IMPORTED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/boxes/import')
  async importBoxes(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.boxImport.importBoxes(req, id, body), req)
  }

  // 供应商装箱单：预览只读不改数据（不写审计），应用整体替换箱子并写审计（P6-11）
  @Write({ action: 'FBA_INBOUND_PACKING_LIST_PREVIEWED', resourceType: 'FbaInboundPlan', permission: PERMISSION, audit: false })
  @HttpCode(200)
  @Post('plans/:id/packing-list/parse')
  async parsePackingList(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.packingList.parse(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_PACKING_LIST_APPLIED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/packing-list/apply')
  async applyPackingList(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.packingList.apply(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_PACKING_INFO_SUBMITTED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/packing-info')
  async packingInfo(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.packingInfo(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_PLACEMENT_OPTION', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/placement-options')
  async placementOptions(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.placementOptions(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_TRANSPORT_OPTION', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/transport-options')
  async transportOptions(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.transportOptions(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_DELIVERY_WINDOW', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/delivery-windows')
  async deliveryWindows(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.deliveryWindows(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_LABELS_REQUESTED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/labels/print-jobs')
  async labelPrintJobs(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.labelPrintJobs(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_COSTS_UPDATED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Patch('plans/:id/costs')
  async costs(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.drafts.costs(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_MARKED_SHIPPED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/confirm')
  async markShipped(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.drafts.markShipped(req, id, body), req)
  }

  @Write({ action: 'FBA_INBOUND_PLAN_CANCELLED', resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/cancel')
  async cancel(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.cancel(req, id, body), req)
  }

  @Get('shipments')
  async shipmentList(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.shipments.list(req, query), req)
  }

  // 三种数量差异汇总：静态路径必须在 shipments/:id 之前（P6-26）
  @Get('shipments/discrepancies')
  async shipmentGaps(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.gaps.list(req, query), req)
  }

  @Get('shipments/:id')
  async shipment(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.shipments.detail(req, id), req)
  }

  @Get('shipments/:id/discrepancies')
  async discrepancies(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.shipments.discrepancies(req, id), req)
  }

  @Get('shipments/:id/timeline')
  async timeline(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.shipments.timeline(req, id), req)
  }

  @Write({ action: 'FBA_INBOUND_TRACKING_UPDATED', resourceType: 'FbaInboundShipment', permission: PERMISSION })
  @Patch('shipments/:id/tracking')
  async tracking(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.writes.tracking(req, id, body), req)
  }

  // 自定义箱标签与商品标签（P6-12）：本地生成 PDF，不调用亚马逊写接口，不受写入开关控制；返回导出任务，文件在导出中心下载
  @Write({ action: LABEL_TEMPLATE_ACTIONS.boxRequested, resourceType: 'FbaInboundShipment', permission: PERMISSION })
  @Post('shipments/:id/labels/custom')
  async customLabels(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.labelJobs.custom(req, id, body), req)
  }

  @Write({ action: LABEL_TEMPLATE_ACTIONS.itemRequested, resourceType: 'FbaInboundPlan', permission: PERMISSION })
  @Post('plans/:id/item-labels')
  async itemLabels(@Req() req: RequestWithContext, @Param('id') id: string, @Body() body: unknown) {
    return ok(await this.labelJobs.items(req, id, body), req)
  }
}
