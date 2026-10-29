import { Injectable } from '@nestjs/common'
import { AWD_SHIPMENT_STATUS_LABEL, type AwdTabResponse } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { awdFreshness, dateText, viewState } from './awd-common'

const OPEN_SHIPMENT_STATUSES = ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'RECEIVING', 'DELIVERED']

// 库存详情“上游仓储”页签的数据：某店铺某 SKU 在 AWD 的最近一次库存快照，以及还没有完结的入库货件。
// 权限与数据范围由库存详情接口先行校验，这里只按店铺与 SKU 取数。
@Injectable()
export class AwdInventoryDetailService {
  constructor(private readonly prisma: PrismaService) {}

  async forSku(tenantId: string, scope: ResolvedScope, input: { sellerAccountId: string; sku: string }): Promise<AwdTabResponse> {
    const { sellerAccountId, sku } = input
    const [snapshot, items, freshness] = await Promise.all([
      this.prisma.awdInventory.findFirst({ where: { tenantId, sellerAccountId, sku }, orderBy: { snapshotDate: 'desc' } }),
      this.prisma.awdShipmentItem.findMany({ where: { tenantId, sellerAccountId, sku }, take: 500 }),
      awdFreshness(this.prisma, tenantId, { ...scope, unrestricted: false, sellerAccountIds: [sellerAccountId] }),
    ])
    const shipments = items.length
      ? await this.prisma.awdInboundShipment.findMany({
          where: { tenantId, sellerAccountId, shipmentId: { in: items.map(item => item.shipmentId) }, status: { in: OPEN_SHIPMENT_STATUSES } },
          orderBy: { amazonUpdatedAt: { sort: 'desc', nulls: 'last' } },
          take: 50,
        })
      : []
    const orders = shipments.some(shipment => shipment.orderId)
      ? await this.prisma.awdInboundOrder.findMany({
          where: { tenantId, sellerAccountId, orderId: { in: shipments.flatMap(shipment => (shipment.orderId ? [shipment.orderId] : [])) } },
          select: { id: true, orderId: true },
          take: 100,
        })
      : []
    const inboundShipments = shipments.map(shipment => {
      const item = items.find(entry => entry.shipmentId === shipment.shipmentId)
      return {
        id: shipment.id,
        shipmentId: shipment.shipmentId,
        orderRowId: orders.find(order => order.orderId === shipment.orderId)?.id ?? null,
        status: shipment.status,
        statusLabel: AWD_SHIPMENT_STATUS_LABEL[shipment.status as keyof typeof AWD_SHIPMENT_STATUS_LABEL] ?? '未知状态',
        expectedQty: item?.expectedQty ?? null,
        receivedQty: item?.receivedQty ?? null,
        unit: item?.unit ?? null,
      }
    })
    const hasData = snapshot !== null || inboundShipments.length > 0
    const view = viewState(freshness, hasData)
    // 同步成功但这个 SKU 没有记录：如实说“这个 SKU 在 AWD 没有记录”，不显示 0
    const note = view.state === 'NO_DATA' ? '这个 SKU 在亚马逊仓储分销（AWD）里没有记录' : view.note
    return {
      state: view.state,
      note,
      snapshotDate: dateText(snapshot?.snapshotDate),
      stock: snapshot
        ? {
            onhandQty: snapshot.onhandQty,
            availableQty: snapshot.availableQty,
            reservedForReplenishment: snapshot.reservedForReplenishment,
            inboundToAwdQty: snapshot.inboundToAwdQty,
            outboundToFbaInTransit: snapshot.outboundToFbaInTransit,
            expiryDate: dateText(snapshot.expiryDate),
            expirations: Array.isArray(snapshot.expirationJson) ? (snapshot.expirationJson as NonNullable<AwdTabResponse['stock']>['expirations']) : [],
          }
        : null,
      inboundShipments,
      freshness,
    }
  }
}
