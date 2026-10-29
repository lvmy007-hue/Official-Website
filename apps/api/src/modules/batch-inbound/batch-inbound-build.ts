import {
  inboundDraftName,
  shipFromSummary,
  SHIP_FROM_PATH,
  US_MARKETPLACE_ID,
  INBOUND_DRAFT_TARGET,
  type ConvertedRecommendation,
  type InboundDraftGroup,
  type ShipFromOption,
  type ToInboundDraftsBody,
  type ToInboundDraftsPreview,
} from '@nova/api-contracts'
import type { Prisma, ReplenishmentBatch, ReplenishmentRecommendation, ShipFromAddress } from '@prisma/client'
import { appError } from '../../platform/http'
import { storeWhere, type ResolvedScope } from '../auth'
import type { ShipFromService } from '../ship-from'

type Client = Pick<Prisma.TransactionClient, 'replenishmentBatch' | 'replenishmentRecommendation' | 'replenishmentAction' | 'fbaInboundPlan' | 'fbaProduct' | 'sellerAccount' | 'shipFromAddress'>

/** 草稿里带的一行商品：商品信息取自商品目录（与手工新建入仓计划一致）。 */
export interface BuiltItem {
  rec: ReplenishmentRecommendation
  quantity: number
  asin: string
  fnsku: string | null
  title: string
}

export interface BuiltGroup {
  preview: InboundDraftGroup
  address: ShipFromAddress | null
  items: BuiltItem[]
}

export interface Built {
  batch: ReplenishmentBatch
  groups: BuiltGroup[]
  preview: ToInboundDraftsPreview
  /** 阻止确认的原因分类：转过的是冲突（409），其余是参数问题（422）。 */
  conflict: boolean
}

const optionOf = (row: ShipFromAddress): ShipFromOption => ({ id: row.id, name: row.name, summary: shipFromSummary(row), isDefault: row.isDefault })
const shortList = (values: readonly string[]) => `${values.slice(0, 5).join('、')}${values.length > 5 ? ` 等 ${values.length} 个` : ''}`

/**
 * 补货批次转入仓计划草稿的核心计算（预览与确认共用，保证“预览什么就生成什么”）：
 * 取范围内的建议 → 找出已转过草稿的 → 逐条定地址与数量 → 按“店铺 + 地址”分组 → 列出不能确认的原因。
 * 已转过的草稿后来被取消，则不算已转过，可以重新转。
 */
export async function buildInboundDrafts(client: Client, shipFrom: ShipFromService, args: { tenantId: string; scope: ResolvedScope; batchId: string; body: ToInboundDraftsBody }): Promise<Built> {
  const { tenantId, scope, batchId, body } = args
  const batch = await client.replenishmentBatch.findFirst({ where: { id: batchId, tenantId } })
  if (!batch) throw appError('RESOURCE_NOT_FOUND', '补货批次不存在')
  const ids = body.items.map(item => item.recommendationId)
  const recs = await client.replenishmentRecommendation.findMany({ where: { tenantId, batchId, id: { in: ids }, ...storeWhere(scope) } })
  if (recs.length !== ids.length) throw appError('RESOURCE_NOT_FOUND', '有补货建议不存在或不在当前数据范围内')
  const recOf = new Map(recs.map(rec => [rec.id, rec]))

  const storeIds = [...new Set(recs.map(rec => rec.sellerAccountId))]
  const [stores, addresses, products, done] = await Promise.all([
    client.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: 500 }),
    shipFrom.activeByStores(tenantId, storeIds, client),
    client.fbaProduct.findMany({
      where: { tenantId, sellerAccountId: { in: storeIds }, marketplaceId: US_MARKETPLACE_ID, sellerSku: { in: [...new Set(recs.map(rec => rec.sku))] } },
      select: { sellerAccountId: true, sellerSku: true, asin: true, fnsku: true, title: true },
      take: 2000,
    }),
    client.replenishmentAction.findMany({
      where: { tenantId, batchId, action: 'INBOUND_DRAFT', status: 'DONE', targetDocType: INBOUND_DRAFT_TARGET, recommendationId: { in: ids } },
      select: { recommendationId: true, targetDocId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    }),
  ])
  const storeName = new Map(stores.map(store => [store.id, store.displayName]))
  const productOf = new Map(products.map(item => [`${item.sellerAccountId}|${item.sellerSku}`, item]))

  // 已转过：每条建议取最近一次的草稿；草稿已取消的不算
  const planIds = [...new Set(done.map(item => item.targetDocId).filter((value): value is string => Boolean(value)))]
  const plans = planIds.length ? await client.fbaInboundPlan.findMany({ where: { tenantId, id: { in: planIds } }, select: { id: true, name: true, stage: true }, take: 2000 }) : []
  const planOf = new Map(plans.map(plan => [plan.id, plan]))
  const convertedBy = new Map<string, ConvertedRecommendation>()
  for (const item of done) {
    if (convertedBy.has(item.recommendationId) || !item.targetDocId) continue
    const plan = planOf.get(item.targetDocId)
    if (!plan || plan.stage === 'CANCELLED') continue
    convertedBy.set(item.recommendationId, {
      recommendationId: item.recommendationId,
      sku: (recOf.get(item.recommendationId) as ReplenishmentRecommendation).sku,
      planId: plan.id,
      planName: plan.name,
      planStage: plan.stage,
    })
  }
  const converted = [...convertedBy.values()].sort((a, b) => a.sku.localeCompare(b.sku))

  const blockers: string[] = []
  const zeroQty: string[] = []
  const noProduct: string[] = []
  const buckets = new Map<string, { sellerAccountId: string; address: ShipFromAddress | null; items: BuiltItem[]; previews: InboundDraftGroup['items'] }>()
  for (const item of body.items) {
    const rec = recOf.get(item.recommendationId) as ReplenishmentRecommendation
    const options = addresses.get(rec.sellerAccountId) ?? []
    let address: ShipFromAddress | null = options.find(option => option.isDefault) ?? null
    if (item.shipFromAddressId) {
      address = options.find(option => option.id === item.shipFromAddressId) ?? null
      if (!address) throw appError('VALIDATION_FAILED', `SKU ${rec.sku} 选的发货地址不属于这个店铺或已停用`, { fieldErrors: { items: [`${rec.sku} 选的发货地址不可用`] } })
    }
    const quantity = item.qty ?? rec.recommendedQty
    if (quantity <= 0) zeroQty.push(rec.sku)
    const product = productOf.get(`${rec.sellerAccountId}|${rec.sku}`)
    if (!product) noProduct.push(rec.sku)
    const key = `${rec.sellerAccountId}|${address?.id ?? 'none'}`
    const bucket = buckets.get(key) ?? { sellerAccountId: rec.sellerAccountId, address, items: [], previews: [] }
    bucket.items.push({ rec, quantity, asin: product?.asin ?? rec.asin, fnsku: product?.fnsku ?? null, title: product?.title ?? rec.sku })
    bucket.previews.push({
      recommendationId: rec.id,
      sku: rec.sku,
      asin: rec.asin,
      title: product?.title ?? null,
      recommendedQty: rec.recommendedQty,
      quantity,
      edited: quantity !== rec.recommendedQty,
    })
    buckets.set(key, bucket)
  }

  const groupsPerStore = new Map<string, number>()
  for (const bucket of buckets.values()) if (bucket.address) groupsPerStore.set(bucket.sellerAccountId, (groupsPerStore.get(bucket.sellerAccountId) ?? 0) + 1)
  const groups: BuiltGroup[] = [...buckets.entries()]
    .map(([key, bucket]) => {
      const name = storeName.get(bucket.sellerAccountId) ?? bucket.sellerAccountId
      const options = (addresses.get(bucket.sellerAccountId) ?? []).map(optionOf)
      bucket.items.sort((a, b) => a.rec.sku.localeCompare(b.rec.sku))
      bucket.previews.sort((a, b) => a.sku.localeCompare(b.sku))
      const preview: InboundDraftGroup = {
        key,
        sellerAccountId: bucket.sellerAccountId,
        storeName: name,
        address: bucket.address ? optionOf(bucket.address) : null,
        addressOptions: options,
        items: bucket.previews,
        skuCount: bucket.items.length,
        totalUnits: bucket.items.reduce((sum, item) => sum + Math.max(0, item.quantity), 0),
        planName: inboundDraftName(batch.batchNo, name, (groupsPerStore.get(bucket.sellerAccountId) ?? 0) > 1 ? (bucket.address?.name ?? null) : null),
      }
      return { preview, address: bucket.address, items: bucket.items }
    })
    .sort((a, b) => a.preview.storeName.localeCompare(b.preview.storeName) || (a.preview.address?.name ?? '').localeCompare(b.preview.address?.name ?? ''))

  if (converted.length)
    blockers.push(`有 ${converted.length} 条建议已经转过入仓计划草稿（${shortList(converted.map(item => `${item.sku} 在「${item.planName}」`))}），请取消勾选；想重新转，先到入仓计划页取消那份草稿`)
  let noOptions = false
  for (const group of groups) {
    if (group.address) continue
    if (group.preview.addressOptions.length === 0) {
      noOptions = true
      blockers.push(`店铺「${group.preview.storeName}」还没有可用的发货地址，请先到“发货地址”页新增`)
    } else blockers.push(`店铺「${group.preview.storeName}」没有默认发货地址，请为这 ${group.preview.skuCount} 条建议选择一个发货地址，或到“发货地址”页设置默认地址`)
  }
  if (zeroQty.length) blockers.push(`这些 SKU 的建议补货量为 0，请填写数量或取消勾选：${shortList(zeroQty)}`)
  if (noProduct.length) blockers.push(`这些 SKU 不在商品目录里，不能入仓：${shortList(noProduct)}`)

  return {
    batch,
    groups,
    conflict: converted.length > 0,
    preview: {
      dryRun: true,
      batchId,
      batchNo: batch.batchNo,
      groups: groups.map(group => group.preview),
      converted,
      canConfirm: groups.length > 0 && blockers.length === 0,
      blockers,
      remedy: noOptions ? { label: '去设置发货地址', path: SHIP_FROM_PATH } : null,
    },
  }
}
