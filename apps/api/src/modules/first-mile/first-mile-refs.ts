import type { FirstMileItemInput } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError } from '../../platform/http'

// 运单引用的校验：货代、国内仓、入仓货件编号、采购单都必须是本企业真实存在的对象。写运单（新建与修改）共用。

type Client = Pick<Prisma.TransactionClient, 'freightForwarder' | 'warehouse' | 'fbaInboundShipment' | 'purchaseOrder'>

const fieldError = (field: string, message: string) => appError('VALIDATION_FAILED', message, { fieldErrors: { [field]: [message] } })

/** 预估依据的渠道：必须是本企业使用中的渠道，并且它的物流商也在使用中。 */
export async function assertChannelUsable(tx: Pick<Prisma.TransactionClient, 'carrierChannel'>, tenantId: string, channelId: string): Promise<void> {
  const channel = await tx.carrierChannel.findFirst({ where: { id: channelId, tenantId }, select: { status: true, carrier: { select: { status: true } } } })
  if (!channel) throw fieldError('carrierChannelId', '渠道不存在')
  if (channel.status !== 'ACTIVE' || channel.carrier.status !== 'ACTIVE') throw fieldError('carrierChannelId', '这个渠道或它的物流商已停用，请换一个')
}

export async function assertShipmentRefs(
  tx: Client,
  tenantId: string,
  refs: { forwarderId?: string; requireActiveForwarder: boolean; warehouseId?: string | null; linkedInboundShipmentIds?: readonly string[]; items?: readonly FirstMileItemInput[] },
): Promise<void> {
  if (refs.forwarderId) {
    const forwarder = await tx.freightForwarder.findFirst({ where: { id: refs.forwarderId, tenantId }, select: { status: true } })
    if (!forwarder) throw fieldError('forwarderId', '货代不存在')
    if (refs.requireActiveForwarder && forwarder.status !== 'ACTIVE') throw fieldError('forwarderId', '这个货代已停用，请换一个或先恢复合作')
  }
  if (refs.warehouseId) {
    const warehouse = await tx.warehouse.findFirst({ where: { id: refs.warehouseId, tenantId, kind: 'DOMESTIC', status: 'ACTIVE' }, select: { id: true } })
    if (!warehouse) throw fieldError('warehouseId', '所选仓库不存在或不是有效的国内仓')
  }
  const linked = [...new Set(refs.linkedInboundShipmentIds ?? [])]
  if (linked.length > 0) {
    const found = await tx.fbaInboundShipment.findMany({ where: { shipmentId: { in: linked }, plan: { tenantId } }, select: { shipmentId: true }, take: 200 })
    const missing = linked.filter(id => !found.some(row => row.shipmentId === id))
    if (missing.length > 0) throw fieldError('linkedInboundShipmentIds', `找不到入仓货件：${missing.slice(0, 5).join('、')}（入仓货件同步后才能关联）`)
  }
  const orderIds = [...new Set((refs.items ?? []).flatMap(item => (item.purchaseOrderId ? [item.purchaseOrderId] : [])))]
  if (orderIds.length > 0) {
    const orders = await tx.purchaseOrder.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true }, take: 200 })
    if (orders.length !== orderIds.length) throw fieldError('items', '明细里有采购单不存在')
  }
}
