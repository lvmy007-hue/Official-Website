import { EVENT_SCOPED_OBJECT_TYPES, type EventScopedObjectType } from '@nova/api-contracts'
import { appError, type ApiContext } from '../../platform/http'
import type { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, storeWhere } from '../auth'
import type { ResolvedScope } from '../auth'
import type { EventTarget } from './events-types'

// 事件对象的解析：店铺、商品、库存记录、广告活动要在成员的数据范围内找到才算存在（范围外按“不存在”处理，不泄露）；
// 其余对象类型（待办、预警、采购单……）只看事件表，读权限由 EntityAccessService 判定。

const NOT_FOUND = '对象不存在，或不在你的数据范围内'

export const isScopedObjectType = (type: string): type is EventScopedObjectType => (EVENT_SCOPED_OBJECT_TYPES as readonly string[]).includes(type)

const plain = (objectType: string, objectId: string): EventTarget => ({ objectType, objectId, storeId: null, asin: null, sku: null, adsProfileId: null, externalCampaignId: null })

export async function resolveScopedTarget(prisma: PrismaService, context: ApiContext, scope: ResolvedScope, objectType: EventScopedObjectType, objectId: string): Promise<EventTarget> {
  const base = plain(objectType, objectId)
  const tenantId = context.tenantId
  if (objectType === 'STORE') {
    // 范围条件的键也是 id，展开会盖掉前面的 id，所以要放进 AND
    const store = await prisma.sellerAccount.findFirst({ where: { tenantId, AND: [{ id: objectId }, storeWhere(scope, 'id')] }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', NOT_FOUND)
    return { ...base, storeId: store.id }
  }
  if (objectType === 'ASIN') {
    const product = await prisma.fbaProduct.findFirst({ where: { id: objectId, tenantId, ...storeWhere(scope) }, select: { sellerAccountId: true, asin: true, sellerSku: true } })
    if (!product) throw appError('RESOURCE_NOT_FOUND', NOT_FOUND)
    return { ...base, storeId: product.sellerAccountId, asin: product.asin || null, sku: product.sellerSku || null }
  }
  if (objectType === 'INVENTORY') {
    const record = await prisma.fbaInventoryRecord.findFirst({ where: { id: objectId, tenantId, ...storeWhere(scope) }, select: { sellerAccountId: true, asin: true, sellerSku: true } })
    if (!record) throw appError('RESOURCE_NOT_FOUND', NOT_FOUND)
    return { ...base, storeId: record.sellerAccountId, asin: record.asin || null, sku: record.sellerSku || null }
  }
  const campaign = await prisma.adsCampaign.findFirst({ where: { id: objectId, tenantId, ...adsRelationWhere(scope) }, select: { adsProfileId: true, externalCampaignId: true } })
  if (!campaign) throw appError('RESOURCE_NOT_FOUND', NOT_FOUND)
  return { ...base, adsProfileId: campaign.adsProfileId, externalCampaignId: campaign.externalCampaignId }
}

export const genericTarget = plain
