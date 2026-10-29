import { US_MARKETPLACE_ID, inboundStageIndex, isInboundStage, shippingModeOf, voidDeadlineOf, type InboundStage } from '@nova/api-contracts'
import { Prisma, type FbaInboundPlan } from '@prisma/client'
import type { InboundApi } from '../../connectors/inbound-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { ImportContext } from '../../types'
import {
  parseBoxIds,
  parseGroupItems,
  parsePackingOptions,
  parsePlacementOptions,
  parsePlan,
  parseReceived,
  parseShipment,
  parseShipmentItems,
  parseTransportOptions,
  parseWindows,
  type ParsedShipment,
} from './v2024-parse'
import { deriveReceiving } from './receiving-derive'

// 入仓计划同步器（importers.md I-07，P2a-12）：把亚马逊上进行中的计划拉回来——装箱方案、分仓方案、货件与明细、运输方案、送达时间窗、接收数量。
// 只拉“当前阶段需要看的”东西（装箱方案只在确认前，运输方案只在分仓确认后、运输确认前），避免每 30 分钟对每个计划做几十次调用。
// 写操作（创建、确认、取消）的结果由操作流程回写，同步器只负责校正与补全；亚马逊侧计划作废时，我方计划同步为“已取消”。

export interface InboundSyncScope {
  tenantId: string
  sellerAccountId: string
}
const MAX_PLANS = 200
const MAX_SHIPMENT_DETAILS = 60
const OPEN_STAGES: InboundStage[] = ['CREATED', 'PACKING_CONFIRMED', 'PACKING_INFO_SUBMITTED', 'PLACEMENT_CONFIRMED', 'TRANSPORT_CONFIRMED', 'LABELS_PRINTED', 'SHIPPED', 'RECEIVING', 'DISCREPANCY']
/** 已经在亚马逊开始接收（或更晚）的货件状态：说明货已经发出。 */
const RECEIVING_STATUSES = ['CHECKED_IN', 'RECEIVING', 'DELIVERED', 'CLOSED']
const json = (value: unknown) => (value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue))
const stageAtLeast = (plan: Pick<FbaInboundPlan, 'stage'>, stage: InboundStage) => isInboundStage(plan.stage) && inboundStageIndex(plan.stage) >= inboundStageIndex(stage)

export async function syncInboundPlans(ctx: ImportContext, api: InboundApi, scope: InboundSyncScope, options: { planId?: string; now?: Date } = {}) {
  const { prisma, logger } = ctx
  const plans = await prisma.fbaInboundPlan.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, externalPlanId: { not: null }, ...(options.planId ? { id: options.planId } : { stage: { in: OPEN_STAGES } }) },
    orderBy: { updatedAt: 'desc' },
    take: MAX_PLANS,
  })
  let imported = 0
  let failed = 0
  let firstError: unknown
  for (const plan of plans) {
    try {
      imported += await syncOnePlan(ctx, api, plan, options.now ?? new Date())
    } catch (error) {
      if (options.planId) throw error
      failed += 1
      firstError ??= error
      logger.warn({ ...scope, planId: plan.id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, 'inbound plan sync failed')
    }
  }
  if (plans.length > 0 && failed === plans.length) throw firstError
  return { imported, plans: plans.length, failed }
}

export async function syncOnePlan(ctx: ImportContext, api: InboundApi, plan: FbaInboundPlan, now: Date): Promise<number> {
  const { prisma } = ctx
  const externalId = plan.externalPlanId as string
  const tenantId = plan.tenantId
  let rows = 0
  const remote = parsePlan(await api.getPlan(externalId))
  if (remote.status === 'VOIDED' && !plan.pendingOp && plan.stage !== 'CANCELLED') {
    await prisma.fbaInboundPlan.update({ where: { id: plan.id }, data: { status: remote.status, stage: 'CANCELLED', sourceUpdatedAt: now, version: { increment: 1 } } })
    return 1
  }
  const updates: Prisma.FbaInboundPlanUncheckedUpdateInput = { status: remote.status, sourceUpdatedAt: now, syncedAt: now }

  // 装箱方案（确认之前要比较，确认之后要知道选了哪个）
  if (stageAtLeast(plan, 'CREATED') && !stageAtLeast(plan, 'PACKING_INFO_SUBMITTED')) {
    const { options } = parsePackingOptions(await api.listPackingOptions(externalId))
    for (const option of options) {
      const data = {
        status: option.status,
        fees: option.fees,
        discounts: option.discounts,
        currency: option.currency,
        expiresAt: option.expiresAt,
        confirmed: option.status === 'ACCEPTED',
        configsJson: json(option.configs),
      }
      await prisma.packingOption.upsert({
        where: { planId_packingOptionId: { planId: plan.id, packingOptionId: option.packingOptionId } },
        create: { tenantId, planId: plan.id, packingOptionId: option.packingOptionId, ...data },
        update: data,
      })
      const stored = await prisma.packingGroup.findMany({ where: { planId: plan.id, packingOptionId: option.packingOptionId }, select: { packingGroupId: true }, take: 500 })
      for (const groupId of option.groupIds.filter(id => !stored.some(row => row.packingGroupId === id))) {
        const items = parseGroupItems(await api.listPackingGroupItems(externalId, groupId))
        await prisma.packingGroup.create({ data: { tenantId, planId: plan.id, packingOptionId: option.packingOptionId, packingGroupId: groupId, itemsJson: items } })
      }
      rows += 1
    }
    const accepted = options.find(option => option.status === 'ACCEPTED')
    if (accepted) updates.selectedPackingOptionId = accepted.packingOptionId
  }

  // 货件详情缓存：分仓方案与货件列表共用，同一货件只读一次
  const details = new Map<string, { shipment: ParsedShipment | null; items: ReturnType<typeof parseShipmentItems> }>()
  const detailOf = async (shipmentId: string) => {
    const cached = details.get(shipmentId)
    if (cached) return cached
    if (details.size >= MAX_SHIPMENT_DETAILS) return { shipment: null, items: [] }
    const entry = { shipment: parseShipment(await api.getShipment(externalId, shipmentId)), items: parseShipmentItems(await api.listShipmentItems(externalId, shipmentId)) }
    details.set(shipmentId, entry)
    return entry
  }

  // 分仓方案
  let acceptedPlacement: { placementOptionId: string; shipmentIds: string[] } | null = null
  if (stageAtLeast(plan, 'PACKING_INFO_SUBMITTED')) {
    const { options } = parsePlacementOptions(await api.listPlacementOptions(externalId))
    for (const option of options) {
      const shipments = stageAtLeast(plan, 'PLACEMENT_CONFIRMED') && option.status !== 'ACCEPTED' ? [] : await Promise.all(option.shipmentIds.map(async id => ({ id, detail: await detailOf(id) })))
      const shipmentsJson = shipments.map(({ id, detail }) => ({
        shipmentId: id,
        destinationFc: detail.shipment?.destinationFc ?? null,
        units: detail.shipment ? detail.items.reduce((sum, item) => sum + item.quantity, 0) : null,
      }))
      const data = {
        shipmentCount: option.shipmentIds.length,
        fees: option.fees,
        discounts: option.discounts,
        currency: option.currency,
        expiresAt: option.expiresAt,
        status: option.status,
        confirmed: option.status === 'ACCEPTED',
      }
      const existing = await prisma.placementOption.findUnique({
        where: { planId_placementOptionId: { planId: plan.id, placementOptionId: option.placementOptionId } },
        select: { shipmentsJson: true },
      })
      const keep = shipmentsJson.length === 0 && existing ? existing.shipmentsJson : shipmentsJson
      await prisma.placementOption.upsert({
        where: { planId_placementOptionId: { planId: plan.id, placementOptionId: option.placementOptionId } },
        create: { tenantId, planId: plan.id, placementOptionId: option.placementOptionId, ...data, shipmentsJson: json(keep) as Prisma.InputJsonValue },
        update: { ...data, shipmentsJson: json(keep) as Prisma.InputJsonValue },
      })
      rows += 1
      if (option.status === 'ACCEPTED') acceptedPlacement = { placementOptionId: option.placementOptionId, shipmentIds: option.shipmentIds }
    }
    if (acceptedPlacement) updates.selectedPlacementOptionId = acceptedPlacement.placementOptionId
  }

  // 货件与明细、运输方案、送达时间窗
  const shipmentIds = acceptedPlacement?.shipmentIds ?? (stageAtLeast(plan, 'PLACEMENT_CONFIRMED') ? remote.shipmentIds : [])
  const shipments: ParsedShipment[] = []
  for (const shipmentId of shipmentIds) {
    const { shipment, items } = await detailOf(shipmentId)
    if (!shipment) continue
    shipments.push(shipment)
    const total = items.reduce((sum, item) => sum + item.quantity, 0)
    let boxIds: string[] = []
    try {
      boxIds = parseBoxIds(await api.listShipmentBoxes(externalId, shipmentId))
    } catch (error) {
      // 货件的箱子还没有生成时亚马逊返回 4xx：没有箱子编号而已，不是同步失败
      if (!(error instanceof UpstreamHttpError) || error.status >= 500 || error.status === 429) throw error
    }
    shipment.trackingJson = { ...(shipment.trackingJson ?? {}), boxIds }
    const data = {
      status: shipment.status,
      destinationFc: shipment.destinationFc,
      shipmentConfirmationId: shipment.confirmationId,
      placementOption: shipment.placementOptionId,
      selectedTransportOptionId: shipment.selectedTransportOptionId,
      selectedWindowId: shipment.selectedWindowId,
      trackingNumber: shipment.trackingNumber,
      trackingJson: json(shipment.trackingJson),
      unitsExpected: total,
      sourceUpdatedAt: now,
    }
    await prisma.fbaInboundShipment.upsert({ where: { planId_shipmentId: { planId: plan.id, shipmentId } }, create: { planId: plan.id, shipmentId, ...data }, update: data })
    for (const item of items) {
      await prisma.shipmentItem.upsert({
        where: { planId_shipmentId_sku: { planId: plan.id, shipmentId, sku: item.sku } },
        create: { tenantId, planId: plan.id, shipmentId, sku: item.sku, fnsku: item.fnsku, shippedQty: item.quantity },
        update: { fnsku: item.fnsku, shippedQty: item.quantity },
      })
    }
    rows += 1
  }
  if (acceptedPlacement && plan.stage === 'PLACEMENT_CONFIRMED') rows += await syncTransport(ctx, api, plan, acceptedPlacement, shipments)
  if (shipments.length > 0) updates.shipmentCount = shipments.length

  // 接收数量（v0 接口）：货件确认号拿到之后才查
  let receivedAny = false
  let allClosed = shipments.length > 0
  let anyDiscrepancy = false
  if (stageAtLeast(plan, 'TRANSPORT_CONFIRMED')) {
    for (const shipment of shipments) {
      allClosed = allClosed && shipment.status === 'CLOSED'
      if (!shipment.confirmationId || !RECEIVING_STATUSES.includes(shipment.status)) continue
      const received = parseReceived(await api.receivedItems(shipment.confirmationId, US_MARKETPLACE_ID))
      const closed = shipment.status === 'CLOSED'
      let sum = 0
      for (const row of received) {
        if (row.received === null) continue
        sum += row.received
        const discrepancy = closed && row.shipped !== null ? row.shipped - row.received : null
        if (discrepancy) anyDiscrepancy = true
        await prisma.shipmentItem.updateMany({ where: { planId: plan.id, shipmentId: shipment.shipmentId, sku: row.sku }, data: { receivedQty: row.received, discrepancyQty: discrepancy } })
      }
      receivedAny = receivedAny || sum > 0
      const current = await prisma.fbaInboundShipment.findUnique({
        where: { planId_shipmentId: { planId: plan.id, shipmentId: shipment.shipmentId } },
        select: { id: true, receivedFirstAt: true, receivedDoneAt: true },
      })
      await prisma.fbaInboundShipment.update({
        where: { planId_shipmentId: { planId: plan.id, shipmentId: shipment.shipmentId } },
        data: {
          unitsReceived: sum,
          discrepancyQuantity: closed
            ? Math.max(
                0,
                received.reduce((total, row) => total + (row.shipped !== null && row.received !== null ? Math.max(0, row.shipped - row.received) : 0), 0),
              )
            : 0,
          ...(sum > 0 && !current?.receivedFirstAt ? { receivedFirstAt: now } : {}),
          ...(closed && !current?.receivedDoneAt ? { receivedDoneAt: now } : {}),
        },
      })
      // 关闭后的货件：落接收差异与（过了等待期的）赔付机会（P2a-13）；单个货件出错不拖垮整个计划的同步
      if (closed && current) {
        try {
          await deriveReceiving(prisma, {
            tenantId,
            sellerAccountId: plan.sellerAccountId,
            planId: plan.id,
            shipmentRowId: current.id,
            shipmentId: shipment.shipmentId,
            closed,
            closedAt: current.receivedDoneAt ?? now,
            rows: received,
            now,
          })
        } catch (error) {
          ctx.logger.warn({ planId: plan.id, shipmentId: shipment.shipmentId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, 'receiving discrepancy derive failed')
        }
      }
      rows += 1
    }
  }

  // 货发出之后的状态：开始接收 → 接收中；全部关闭 → 完结（有差异则差异处理中）
  const started = shipments.some(shipment => RECEIVING_STATUSES.includes(shipment.status)) || receivedAny
  if (started && stageAtLeast(plan, 'TRANSPORT_CONFIRMED') && !plan.pendingOp) {
    updates.stage = allClosed ? (anyDiscrepancy ? 'DISCREPANCY' : 'COMPLETED') : plan.stage === 'DISCREPANCY' ? 'DISCREPANCY' : 'RECEIVING'
    if (!plan.shippedAt) updates.shippedAt = now
  }
  await prisma.fbaInboundPlan.update({ where: { id: plan.id }, data: updates })
  return rows + 1
}

async function syncTransport(ctx: ImportContext, api: InboundApi, plan: FbaInboundPlan, placement: { placementOptionId: string; shipmentIds: string[] }, shipments: ParsedShipment[]): Promise<number> {
  const { prisma } = ctx
  const externalId = plan.externalPlanId as string
  let rows = 0
  const options = parseTransportOptions(await api.listTransportOptions(externalId, { placementOptionId: placement.placementOptionId }))
  for (const option of options) {
    const data = {
      carrier: option.carrier,
      mode: option.mode,
      solution: option.solution,
      cost: option.cost,
      currency: option.currency,
      etaJson: json(option.eta),
      preconditionsJson: json(option.preconditions),
      voidableUntil: option.voidableUntil,
      expiresAt: option.expiresAt,
      confirmed: shipments.some(shipment => shipment.shipmentId === option.shipmentId && shipment.selectedTransportOptionId === option.transportOptionId),
    }
    await prisma.transportOption.upsert({
      where: { planId_shipmentId_transportOptionId: { planId: plan.id, shipmentId: option.shipmentId, transportOptionId: option.transportOptionId } },
      create: { tenantId: plan.tenantId, planId: plan.id, shipmentId: option.shipmentId, transportOptionId: option.transportOptionId, ...data },
      update: data,
    })
    rows += 1
  }
  for (const shipment of shipments) {
    let windows: ReturnType<typeof parseWindows> = []
    try {
      windows = parseWindows(await api.listWindows(externalId, shipment.shipmentId))
    } catch (error) {
      // 没有生成过送达时间窗（或该运输方案不需要）时亚马逊返回 4xx：不是同步失败
      if (!(error instanceof UpstreamHttpError) || error.status >= 500 || error.status === 429) throw error
    }
    for (const window of windows) {
      const data = {
        deliveryWindowOptionId: window.optionId,
        windowEnd: window.end,
        availabilityType: window.availabilityType,
        availabilityExpiresAt: window.validUntil,
        confirmed: shipment.selectedWindowId === window.optionId,
      }
      await prisma.deliveryWindow.upsert({
        where: { planId_shipmentId_windowStart: { planId: plan.id, shipmentId: shipment.shipmentId, windowStart: window.start } },
        create: { tenantId: plan.tenantId, planId: plan.id, shipmentId: shipment.shipmentId, windowStart: window.start, ...data },
        update: data,
      })
      rows += 1
    }
  }
  return rows
}

/** 运输方案确认后的作废截止：取已确认方案报价里的 voidableUntil，没有就按运输方式加窗口时长。 */
export async function transportVoidDeadline(ctx: ImportContext, planId: string, confirmedAt: Date) {
  const confirmed = await ctx.prisma.transportOption.findMany({ where: { planId, confirmed: true }, take: 200 })
  const modes = confirmed.map(option => shippingModeOf(option.mode))
  // 多个货件取最早的截止时间（任何一个超时都意味着整个计划不能再整体取消）
  const deadlines = confirmed.map((option, index) => voidDeadlineOf(confirmedAt, modes[index], option.voidableUntil)).filter((value): value is Date => value !== null)
  const mode = modes.includes('SPD') ? (modes.every(item => item === 'SPD') ? 'SPD' : 'LTL') : (modes.find(Boolean) ?? null)
  return { shippingMode: mode, deadline: deadlines.length ? new Date(Math.min(...deadlines.map(value => value.getTime()))) : voidDeadlineOf(confirmedAt, mode) }
}
