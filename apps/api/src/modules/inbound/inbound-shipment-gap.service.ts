import { Injectable } from '@nestjs/common'
import { matchesGapFilter, shipmentGapsOf, ShipmentGapQuerySchema, type ShipmentGapResponse, type ShipmentGapRow } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { INBOUND_READ } from './inbound-common'

/** 最多扫描最近更新的多少个货件；超过时回答里标注“没有看完”。 */
const SCAN_LIMIT = 5000
const NOTE =
  '申报 = 亚马逊分仓方案里这个货件的预计件数；已发 = 货件各 SKU 的已发数量合计；签收 = 运营中心接收数量合计。三种差异两两相减（为正是前者多于后者）；签收相关的差异只在货件关闭后判定，已发或签收数据没有时显示“尚无记录”，不是 0。'

/** 货件三种数量差异汇总（P6-26，16 章第 5.1 节）：申报、已发、签收三列，加两两相减的三种差异，以及“申报大于签收”“已发大于签收”等快捷筛选。 */
@Injectable()
export class InboundShipmentGapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ShipmentGapResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, rawQuery)
    const query = ShipmentGapQuerySchema.parse(rawQuery)
    const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
    const where: Prisma.FbaInboundShipmentWhereInput = {
      plan: { tenantId: context.tenantId, ...storeWhere(scope) },
      ...(query.q ? { OR: [{ shipmentId: contains(query.q) }, { shipmentConfirmationId: contains(query.q) }, { plan: { name: contains(query.q) } }] } : {}),
    }
    const shipments = await this.prisma.fbaInboundShipment.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: SCAN_LIMIT,
      select: { id: true, planId: true, shipmentId: true, shipmentConfirmationId: true, status: true, destinationFc: true, unitsExpected: true, plan: { select: { name: true } } },
    })
    const sums =
      shipments.length > 0
        ? await this.prisma.shipmentItem.groupBy({
            by: ['planId', 'shipmentId'],
            where: { tenantId: context.tenantId, planId: { in: [...new Set(shipments.map(row => row.planId))] }, shipmentId: { in: [...new Set(shipments.map(row => row.shipmentId))] } },
            orderBy: [{ planId: 'asc' }, { shipmentId: 'asc' }],
            _sum: { shippedQty: true, receivedQty: true },
            _count: { _all: true, receivedQty: true },
            take: 20_000,
          })
        : []
    const byKey = new Map(sums.map(row => [`${row.planId}\u0000${row.shipmentId}`, row]))
    const rows: ShipmentGapRow[] = shipments.map(shipment => {
      const sum = byKey.get(`${shipment.planId}\u0000${shipment.shipmentId}`)
      const closed = shipment.status === 'CLOSED'
      const declared = shipment.unitsExpected > 0 ? shipment.unitsExpected : null
      const shipped = sum ? (sum._sum.shippedQty ?? 0) : null
      // 任何一行没有接收数据，签收合计就不完整，不显示（与货件页一致）
      const received = sum && sum._count.receivedQty === sum._count._all ? (sum._sum.receivedQty ?? 0) : null
      return {
        id: shipment.id,
        shipmentId: shipment.shipmentId,
        shipmentConfirmationId: shipment.shipmentConfirmationId,
        planId: shipment.planId,
        planName: shipment.plan.name,
        destinationFc: shipment.destinationFc,
        status: shipment.status,
        closed,
        declared,
        shipped,
        received,
        ...shipmentGapsOf({ declared, shipped, received, closed }),
      }
    })
    const matched = query.gap ? rows.filter(row => matchesGapFilter(row, query.gap!)) : rows
    const start = (query.page - 1) * query.pageSize
    return { items: matched.slice(start, start + query.pageSize), total: matched.length, page: query.page, pageSize: query.pageSize, truncated: shipments.length >= SCAN_LIMIT, note: NOTE }
  }
}
