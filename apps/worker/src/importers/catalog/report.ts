import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { decimal } from '../shared'

/** 在售商品报告：按店铺、站点、卖家 SKU 幂等写入。 */
export async function syncCatalogReport(
  ctx: ImportContext,
  rows: AsyncIterable<Row>,
  reportJob: { documentId: string | null; sellerAccountId: string | null },
  tenantId: string,
  marketplaceId: string,
): Promise<ImportResult> {
  if (!reportJob.documentId || !reportJob.sellerAccountId) throw new Error('CATALOG_REPORT_CONTEXT_MISSING')
  const sellerAccountId = reportJob.sellerAccountId
  return importRows(ctx, rows, async ({ prisma }, item) => {
    const sellerSku = String(item['seller-sku'] ?? item['seller_sku'] ?? '').trim()
    const asin = String(item.asin1 ?? item.asin ?? item['product-id'] ?? '').trim()
    if (!sellerSku || !asin) return 'ignored'
    const channel = String(item['fulfillment-channel'] ?? item['fulfillment_channel'] ?? 'AFN').trim()
    const status = String(item.status ?? 'ACTIVE')
      .trim()
      .toUpperCase()
    await prisma.fbaProduct.upsert({
      where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId, marketplaceId, sellerSku } },
      create: {
        tenantId,
        sellerAccountId,
        marketplaceId,
        asin,
        sellerSku,
        title: String(item['item-name'] ?? item.title ?? asin),
        listingStatus: status,
        fulfillmentChannel: channel,
        price: decimal(item.price),
        currency: String(item.currency ?? 'USD'),
        sourceUpdatedAt: new Date(),
      },
      update: { asin, title: String(item['item-name'] ?? item.title ?? asin), listingStatus: status, fulfillmentChannel: channel, price: decimal(item.price), sourceUpdatedAt: new Date() },
    })
    return 'imported'
  })
}
