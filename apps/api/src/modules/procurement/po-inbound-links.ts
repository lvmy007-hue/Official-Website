import { INBOUND_STAGE_LABEL, type PoInboundPlanLink } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'

// 采购单与入仓计划的关联：数据里没有直接的外键，只能顺着头程运单走——采购单 → 头程运单明细 → 运单上登记的入仓货件编号 → 入仓货件 → 入仓计划。
// 所以只有登记过头程运单、并把亚马逊货件编号关联到运单上的采购单才会出现入仓计划；这是推算，页面上写明依据，不当作采购单的直接关联。

export const INBOUND_LINK_BASIS = '依据：这张采购单的头程运单上登记的入仓货件；没有登记头程运单与货件的采购单不会出现在这里。'

export async function inboundPlanLinks(prisma: PrismaService, tenantId: string, shipmentIds: readonly string[]): Promise<PoInboundPlanLink[]> {
  const ids = [...new Set(shipmentIds)]
  if (ids.length === 0) return []
  const rows = await prisma.fbaInboundShipment.findMany({
    where: { shipmentId: { in: ids }, plan: { tenantId } },
    select: { shipmentId: true, plan: { select: { id: true, name: true, stage: true } } },
    orderBy: { shipmentId: 'asc' },
    take: 200,
  })
  const byPlan = new Map<string, PoInboundPlanLink>()
  for (const row of rows) {
    const found = byPlan.get(row.plan.id)
    if (found) found.shipmentIds.push(row.shipmentId)
    else
      byPlan.set(row.plan.id, {
        id: row.plan.id,
        name: row.plan.name,
        stage: row.plan.stage,
        stageLabel: INBOUND_STAGE_LABEL[row.plan.stage as keyof typeof INBOUND_STAGE_LABEL] ?? row.plan.stage,
        shipmentIds: [row.shipmentId],
      })
  }
  return [...byPlan.values()]
}
