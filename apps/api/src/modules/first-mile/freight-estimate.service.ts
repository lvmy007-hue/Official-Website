import { Injectable } from '@nestjs/common'
import { CARRIER_ACTIONS, EstimateBodySchema, estimateFreight, FillItemsBodySchema, type BillingMode, type EstimateResponse, type FillItemsResult, type RateTier } from '@nova/api-contracts'
import { FREIGHT_ESTIMATE_RULES, stripSensitiveFields } from '../../platform/field-filter'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { dayText, FM_READ, FM_WRITE, stateConflict, todayText } from './first-mile-common'

const RATE_LIMIT = 2000

/** 预估与批量补录（P6-26）：预估只读计算、不落库；采用预估是运单修改（PATCH，带渠道与金额）。 */
@Injectable()
export class FreightEstimateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async estimate(req: RequestWithContext, id: string, rawBody: unknown): Promise<EstimateResponse> {
    const context = await this.context.authorize(req, FM_READ)
    const body = EstimateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const shipment = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, include: { items: true } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    const channelId = body.channelId ?? shipment.carrierChannelId
    if (!channelId) throw appError('VALIDATION_FAILED', '请先选择渠道', { fieldErrors: { channelId: ['请选择渠道'] } })
    const channel = await this.prisma.carrierChannel.findFirst({ where: { id: channelId, tenantId }, include: { carrier: { select: { name: true } }, rates: { take: RATE_LIMIT } } })
    if (!channel) throw appError('RESOURCE_NOT_FOUND', '渠道不存在')
    const tiers: RateTier[] = channel.rates.map(rate => ({
      id: rate.id,
      region: rate.region,
      weightFrom: Number(rate.weightFrom),
      weightTo: rate.weightTo === null ? null : Number(rate.weightTo),
      unitPrice: Number(rate.unitPrice),
      currency: rate.currency,
      billingMode: rate.billingMode as BillingMode,
      effectiveFrom: dayText(rate.effectiveFrom) as string,
      effectiveTo: dayText(rate.effectiveTo),
    }))
    const on = todayText()
    const estimate = estimateFreight({
      items: shipment.items.map(item => ({
        sku: item.sku,
        quantity: item.quantity,
        weightKg: item.weightKg === null ? null : Number(item.weightKg),
        volumeCbm: item.volumeCbm === null ? null : Number(item.volumeCbm),
      })),
      channel: { volumetricDivisor: Number(channel.volumetricDivisor), splitFactor: Number(channel.splitFactor) },
      tiers,
      region: body.region,
      on,
      shipmentCurrency: shipment.currency,
    })
    const response: EstimateResponse = { channelId, channelName: channel.name, carrierName: channel.carrier.name, region: body.region, on, estimate }
    return stripSensitiveFields(response, context.permissions, FREIGHT_ESTIMATE_RULES)
  }

  /** 批量补录：只补空着的重量与体积，已有值不覆盖；费用已分摊后不能改（按体积、重量分摊用的就是这两列）。 */
  async fill(req: RequestWithContext, id: string, rawBody: unknown): Promise<FillItemsResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FillItemsBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const shipment = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, include: { items: true, _count: { select: { allocations: true } } } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    if (shipment._count.allocations > 0) throw stateConflict('费用已分摊，请先撤销分摊再补录重量与体积')
    const bySku = new Map(shipment.items.map(item => [item.sku, item]))
    const absent = body.rows.filter(row => !bySku.has(row.sku)).map(row => row.sku)
    if (absent.length > 0) throw appError('VALIDATION_FAILED', `运单明细里没有这些 SKU：${absent.slice(0, 5).join('、')}`, { fieldErrors: { rows: absent.slice(0, 5) } })
    const changes = body.rows.flatMap(row => {
      const item = bySku.get(row.sku)
      if (!item) return []
      const data = {
        ...(item.weightKg === null && row.weightKg != null ? { weightKg: row.weightKg } : {}),
        ...(item.volumeCbm === null && row.volumeCbm != null ? { volumeCbm: row.volumeCbm } : {}),
      }
      return Object.keys(data).length ? [{ itemId: item.id, sku: row.sku, data }] : []
    })
    if (changes.length === 0) throw appError('VALIDATION_FAILED', '没有可补录的内容：这些 SKU 的重量与体积已经有值，或没有填数', { fieldErrors: { rows: ['没有可补录的内容'] } })
    const after = await this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.firstMileShipment, { id, tenantId }, body.version, {}, { label: '头程运单' })
      for (const change of changes) await tx.firstMileShipmentItem.updateMany({ where: { id: change.itemId, tenantId, shipmentId: id }, data: change.data })
      await this.audit.record(
        req,
        { action: CARRIER_ACTIONS.itemsFilled, resourceType: 'FirstMileShipment', resourceId: id, detail: { filled: changes.length, skus: changes.slice(0, 20).map(change => change.sku) } },
        { client: tx },
      )
      return row
    })
    return { id, version: after.version, filled: changes.length }
  }
}
