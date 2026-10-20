import { PrismaClient } from '@prisma/client'
import { Queue, Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import pino from 'pino'
import { AmazonSpApiClient } from './amazon-sp-api'
import { AmazonAdsApiClient } from './amazon-ads-api'
import { collectFeeLines } from './fee-lines'
import { PII_RETENTION_DAYS, sealPii } from './pii-vault'

type SyncPayload = { syncJobId: string; requestId: string; marketplaceId?: string; fbaPlanId?: string; reportJobId?: string; reportType?: string; adsProfileId?: string; poll?: boolean; retry?: boolean }
type JsonObject = Record<string, unknown>

const prisma = new PrismaClient()
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['*.token', '*.secret', '*.encryptedRefreshToken'] })
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const syncQueue = new Queue<SyncPayload>('sync', { connection })
const mock = process.env.MOCK_CONNECTOR === 'true' && process.env.APP_MODE !== 'production'

async function markFailure(payload: SyncPayload, code: string) {
  await prisma.syncJob.update({ where: { id: payload.syncJobId }, data: { status: 'FAILED_PERMANENT', failureCode: code, finishedAt: new Date() } })
  if (payload.reportJobId) await prisma.fbaReportJob.update({ where: { id: payload.reportJobId }, data: { status: 'FAILED', failureCode: code } }).catch(() => undefined)
  if (payload.fbaPlanId) await prisma.fbaInboundPlan.update({ where: { id: payload.fbaPlanId }, data: { status: 'CREATE_FAILED' } }).catch(() => undefined)
}

async function syncInventory(client: AmazonSpApiClient, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  let nextToken: string | undefined
  let imported = 0
  do {
    const response = await client.getInventory(marketplaceId, nextToken)
    const payload = (response.payload ?? response) as JsonObject
    const summaries = Array.isArray(payload.inventorySummaries) ? payload.inventorySummaries as JsonObject[] : []
    for (const item of summaries) {
      const sellerSku = String(item.sellerSku ?? '').trim(); const asin = String(item.asin ?? '').trim()
      if (!sellerSku || !asin) continue
      const details = (item.inventoryDetails ?? {}) as JsonObject
      const reservedDetails = (details.reservedQuantity ?? {}) as JsonObject
      const unfulfillableDetails = (details.unfulfillableQuantity ?? {}) as JsonObject
      const fulfillable = Number(details.fulfillableQuantity ?? 0)
      const reserved = Number(reservedDetails.totalReservedQuantity ?? item.totalReservedQuantity ?? 0)
      const inboundWorking = countOf(details.inboundWorkingQuantity)
      const inboundShipped = countOf(details.inboundShippedQuantity)
      const inboundReceiving = countOf(details.inboundReceivingQuantity)
      const unfulfillable = Number(unfulfillableDetails.totalUnfulfillableQuantity ?? 0)
      const researching = Number(((details.researchingQuantity ?? {}) as JsonObject).totalResearchingQuantity ?? 0)
      await prisma.fbaInventoryRecord.upsert({
        where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId, marketplaceId, sellerSku } },
        create: { tenantId, sellerAccountId, marketplaceId, asin, sellerSku, fnsku: typeof item.fnsku === 'string' ? item.fnsku : undefined, fulfillableQuantity: fulfillable, reservedQuantity: reserved, inboundWorkingQuantity: inboundWorking, inboundShippedQuantity: inboundShipped, inboundReceivingQuantity: inboundReceiving, unfulfillableQuantity: unfulfillable, researchQuantity: researching, sourceUpdatedAt: new Date(), healthStatus: fulfillable < 20 ? 'LOW_STOCK' : 'HEALTHY' },
        update: { asin, fnsku: typeof item.fnsku === 'string' ? item.fnsku : undefined, fulfillableQuantity: fulfillable, reservedQuantity: reserved, inboundWorkingQuantity: inboundWorking, inboundShippedQuantity: inboundShipped, inboundReceivingQuantity: inboundReceiving, unfulfillableQuantity: unfulfillable, researchQuantity: researching, sourceUpdatedAt: new Date(), healthStatus: fulfillable < 20 ? 'LOW_STOCK' : 'HEALTHY' },
      })
    }
    imported += summaries.length
    const pagination = (payload.pagination ?? {}) as JsonObject
    const token = payload.nextToken ?? pagination.nextToken ?? response.nextToken
    nextToken = typeof token === 'string' && token.length > 0 ? token : undefined
  } while (nextToken)
  return imported
}

function countOf(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object') {
    const record = value as JsonObject
    const nested = Number(record.quantity ?? record.total ?? 0)
    return Number.isFinite(nested) ? nested : 0
  }
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}
function historyWindows(since: Date | null, windowDays: number) {
  const end = new Date(Date.now() - 2 * 60 * 1000)
  const earliest = end.getTime() - 730 * 86400000
  const start = since ? new Date(Math.max(since.getTime() - 2 * 86400000, earliest)) : new Date(earliest)
  const windows: Array<{ after: string; before: string }> = []
  for (let cursor = start.getTime(); cursor < end.getTime(); cursor += windowDays * 86400000) {
    const before = Math.min(end.getTime(), cursor + windowDays * 86400000)
    windows.push({ after: new Date(cursor).toISOString(), before: new Date(before).toISOString() })
  }
  return windows
}
async function syncOrders(client: AmazonSpApiClient, tenantId: string, sellerAccountId: string, marketplaceId: string, since?: Date | null) {
  let imported = 0
  const orderIds: Array<{ amazonOrderId: string; status: string }> = []
  for (const window of historyWindows(since ?? null, 90)) {
  let nextToken: string | undefined
  do {
    const response = await client.getOrders(marketplaceId, nextToken, { createdAfter: window.after, createdBefore: window.before })
    const payload = (response.payload ?? response) as JsonObject
    const orders = Array.isArray(payload.Orders) ? payload.Orders as JsonObject[] : []
    for (const item of orders) {
      const amazonOrderId = String(item.AmazonOrderId ?? '').trim()
      if (!amazonOrderId) continue
      const total = (item.OrderTotal ?? {}) as JsonObject
      const purchaseDate = new Date(String(item.PurchaseDate ?? new Date().toISOString()))
      const order = await prisma.order.upsert({
        where: { sellerAccountId_amazonOrderId: { sellerAccountId, amazonOrderId } },
        create: { tenantId, sellerAccountId, amazonOrderId, marketplaceId, purchaseDate: Number.isNaN(purchaseDate.getTime()) ? new Date() : purchaseDate, status: String(item.OrderStatus ?? 'UNKNOWN'), fulfillment: typeof item.FulfillmentChannel === 'string' ? item.FulfillmentChannel : undefined, currency: String(total.CurrencyCode ?? 'USD'), amount: total.Amount ? Number(total.Amount) : undefined, itemCount: 0, sourceUpdatedAt: new Date(), sourceRecordId: amazonOrderId },
        update: { marketplaceId, purchaseDate: Number.isNaN(purchaseDate.getTime()) ? new Date() : purchaseDate, status: String(item.OrderStatus ?? 'UNKNOWN'), fulfillment: typeof item.FulfillmentChannel === 'string' ? item.FulfillmentChannel : undefined, currency: String(total.CurrencyCode ?? 'USD'), amount: total.Amount ? Number(total.Amount) : undefined, sourceUpdatedAt: new Date() },
      })
      let itemToken: string | undefined
      let itemCount = 0
      do {
        const itemResponse = await client.getOrderItems(amazonOrderId, itemToken)
        const itemPayload = (itemResponse.payload ?? itemResponse) as JsonObject
        const orderItems = Array.isArray(itemPayload.OrderItems) ? itemPayload.OrderItems as JsonObject[] : []
        for (const line of orderItems) {
          const orderItemId = String(line.OrderItemId ?? (amazonOrderId + ':' + (line.SellerSKU ?? line.ASIN ?? itemCount))).trim()
          if (!orderItemId) continue
          const itemPrice = (line.ItemPrice ?? {}) as JsonObject
          await prisma.orderItem.upsert({
            where: { sellerAccountId_orderItemId: { sellerAccountId, orderItemId } },
            create: { tenantId, sellerAccountId, orderId: order.id, amazonOrderId, orderItemId, asin: typeof line.ASIN === 'string' ? line.ASIN : undefined, sellerSku: typeof line.SellerSKU === 'string' ? line.SellerSKU : undefined, title: typeof line.Title === 'string' ? line.Title : undefined, quantityOrdered: Number(line.QuantityOrdered ?? 0), quantityShipped: Number(line.QuantityShipped ?? 0), itemPrice: itemPrice.Amount ? Number(itemPrice.Amount) : undefined, currency: String(itemPrice.CurrencyCode ?? total.CurrencyCode ?? 'USD'), fulfillmentNetwork: typeof line.FulfillmentNetwork === 'string' ? line.FulfillmentNetwork : undefined, condition: typeof line.ConditionId === 'string' ? line.ConditionId : undefined, sourceUpdatedAt: new Date() },
            update: { orderId: order.id, asin: typeof line.ASIN === 'string' ? line.ASIN : undefined, sellerSku: typeof line.SellerSKU === 'string' ? line.SellerSKU : undefined, title: typeof line.Title === 'string' ? line.Title : undefined, quantityOrdered: Number(line.QuantityOrdered ?? 0), quantityShipped: Number(line.QuantityShipped ?? 0), itemPrice: itemPrice.Amount ? Number(itemPrice.Amount) : undefined, sourceUpdatedAt: new Date() },
          })
          itemCount += 1
        }
        const token = itemPayload.NextToken ?? itemResponse.NextToken
        itemToken = typeof token === 'string' && token.length > 0 ? token : undefined
      } while (itemToken)
      await prisma.order.update({ where: { id: order.id }, data: { itemCount } })
    }
    imported += orders.length
    for (const item of orders) {
      const amazonOrderId = String(item.AmazonOrderId ?? '').trim()
      if (amazonOrderId) orderIds.push({ amazonOrderId, status: String(item.OrderStatus ?? 'UNKNOWN') })
    }
    const token = payload.NextToken ?? response.NextToken
    nextToken = typeof token === 'string' && token.length > 0 ? token : undefined
  } while (nextToken)
  }
  return { imported, orderIds }
}

async function syncAdsProfiles(client: AmazonAdsApiClient, tenantId: string, connectionId: string) {
  const profiles = await client.getProfiles()
  let imported = 0
  for (const item of profiles) {
    const profileId = String(item.profileId ?? '')
    if (!profileId) continue
    const accountInfo = (item.accountInfo ?? {}) as JsonObject
    const countryCode = String(item.countryCode ?? 'US')
    const marketplaceId = String(item.marketplaceStringId ?? (countryCode === 'US' ? 'ATVPDKIKX0DER' : '')) || 'ATVPDKIKX0DER'
    const profile = await prisma.adsProfile.upsert({
      where: { tenantId_profileId: { tenantId, profileId } },
      create: {
        tenantId,
        profileId,
        accountId: typeof item.accountId === 'string' ? item.accountId : undefined,
        marketplaceId,
        countryCode,
        currencyCode: String(item.currencyCode ?? 'USD'),
        timezone: typeof item.timeZone === 'string' ? item.timeZone : typeof item.timezone === 'string' ? item.timezone : undefined,
        displayName: typeof accountInfo.name === 'string' ? accountInfo.name : `Amazon Ads · ${countryCode}`,
        sourceUpdatedAt: new Date(),
      },
      update: {
        accountId: typeof item.accountId === 'string' ? item.accountId : undefined,
        marketplaceId,
        countryCode,
        currencyCode: String(item.currencyCode ?? 'USD'),
        timezone: typeof item.timeZone === 'string' ? item.timeZone : typeof item.timezone === 'string' ? item.timezone : undefined,
        displayName: typeof accountInfo.name === 'string' ? accountInfo.name : undefined,
        status: 'ACTIVE',
        sourceUpdatedAt: new Date(),
      },
    })
    await prisma.platformConnection.update({ where: { id: connectionId }, data: { adsProfileId: profile.id, externalAccountId: profileId, lastSuccessfulSyncAt: new Date(), lastHealthCheckedAt: new Date(), lastErrorCode: null } })
    imported += 1
    try {
      const campaigns = await client.listCampaigns(profileId)
      for (const campaign of campaigns) {
        const externalCampaignId = String(campaign.campaignId ?? campaign.id ?? '')
        if (!externalCampaignId) continue
        await prisma.adsCampaign.upsert({
          where: { adsProfileId_externalCampaignId_adProduct: { adsProfileId: profile.id, externalCampaignId, adProduct: 'SPONSORED_PRODUCTS' } },
          create: {
            tenantId,
            adsProfileId: profile.id,
            externalCampaignId,
            adProduct: 'SPONSORED_PRODUCTS',
            name: String(campaign.name ?? externalCampaignId),
            state: String(campaign.state ?? 'UNKNOWN'),
            budget: campaign.budget && typeof campaign.budget === 'object' ? Number((campaign.budget as JsonObject).budget ?? 0) : typeof campaign.budget === 'number' ? campaign.budget : undefined,
            currency: String(campaign.budget && typeof campaign.budget === 'object' ? (campaign.budget as JsonObject).currencyCode ?? profile.currencyCode : profile.currencyCode),
            startDate: typeof campaign.startDate === 'string' ? new Date(campaign.startDate) : undefined,
            endDate: typeof campaign.endDate === 'string' ? new Date(campaign.endDate) : undefined,
            sourceUpdatedAt: new Date(),
            raw: JSON.parse(JSON.stringify(campaign)),
          },
          update: {
            name: String(campaign.name ?? externalCampaignId),
            state: String(campaign.state ?? 'UNKNOWN'),
            budget: campaign.budget && typeof campaign.budget === 'object' ? Number((campaign.budget as JsonObject).budget ?? 0) : typeof campaign.budget === 'number' ? campaign.budget : undefined,
            sourceUpdatedAt: new Date(),
            raw: JSON.parse(JSON.stringify(campaign)),
          },
        })
      }
    } catch (error) {
      logger.warn({ profileId, error: error instanceof Error ? error.message : String(error) }, 'Ads profile imported but campaign sync failed')
    }
  }
  return { imported, profiles: profiles.length }
}
async function syncFinance(client: AmazonSpApiClient, tenantId: string, sellerAccountId: string, marketplaceId: string, since?: Date | null) {
  let imported = 0
  for (const window of historyWindows(since ?? null, 179)) {
  let nextToken: string | undefined
  do {
    const response = await client.getFinancialEvents(nextToken, { postedAfter: window.after, postedBefore: window.before })
    const root = (response.payload ?? response) as JsonObject
    const eventsRoot = (root.FinancialEvents ?? root) as JsonObject
    for (const line of collectFeeLines(eventsRoot)) {
      const postedAt = Number.isNaN(line.postedAt.getTime()) ? new Date() : line.postedAt
      if (line.settlementId) await prisma.fbaSettlement.upsert({
        where: { sellerAccountId_externalSettlementId: { sellerAccountId, externalSettlementId: line.settlementId } },
        create: { tenantId, sellerAccountId, marketplaceId, externalSettlementId: line.settlementId, totalAmount: undefined, currency: line.currency, status: 'RECEIVED', sourceUpdatedAt: new Date(), raw: { eventType: line.eventType } },
        update: { currency: line.currency, sourceUpdatedAt: new Date() },
      })
      const settlement = line.settlementId ? await prisma.fbaSettlement.findUnique({ where: { sellerAccountId_externalSettlementId: { sellerAccountId, externalSettlementId: line.settlementId } } }) : null
      await prisma.fbaFeeEvent.upsert({
        where: { sellerAccountId_sourceEventId: { sellerAccountId, sourceEventId: line.sourceEventId } },
        create: { tenantId, sellerAccountId, marketplaceId, settlementId: line.settlementId, amazonOrderId: line.amazonOrderId, asin: line.asin, sellerSku: line.sellerSku, eventType: line.eventType, amount: line.amount, currency: line.currency, postedAt, description: line.description, sourceEventId: line.sourceEventId, sourceUpdatedAt: new Date() },
        update: { amount: line.amount, currency: line.currency, postedAt, eventType: line.eventType, sourceUpdatedAt: new Date() },
      })
      await prisma.fbaFinancialTransaction.upsert({
        where: { sellerAccountId_externalTransactionId: { sellerAccountId, externalTransactionId: line.sourceEventId } },
        create: { tenantId, sellerAccountId, settlementId: settlement?.id, marketplaceId, externalTransactionId: line.sourceEventId, amazonOrderId: line.amazonOrderId, transactionType: line.eventType, transactionStatus: 'POSTED', amount: line.amount, currency: line.currency, postedAt, description: line.description, raw: { eventType: line.eventType, amount: line.amount, currency: line.currency }, sourceUpdatedAt: new Date() },
        update: { amount: line.amount, currency: line.currency, transactionType: line.eventType, postedAt, sourceUpdatedAt: new Date() },
      })
      imported += 1
    }
    const token = root.NextToken ?? response.NextToken
    nextToken = typeof token === 'string' && token.length > 0 ? token : undefined
  } while (nextToken)
  }
  return { imported }
}
async function syncOrderPii(client: AmazonSpApiClient, sellerAccountId: string, orders: Array<{ amazonOrderId: string; status: string }>) {
  const needsToken: string[] = []
  for (const order of orders) {
    const existing = await prisma.order.findUnique({ where: { sellerAccountId_amazonOrderId: { sellerAccountId, amazonOrderId: order.amazonOrderId } }, select: { piiCiphertext: true, status: true, piiExpiresAt: true } })
    if (existing?.piiCiphertext && existing.status === order.status && existing.piiExpiresAt && existing.piiExpiresAt > new Date()) continue
    if (existing?.piiCiphertext) {
      const shippedAt = order.status === 'Shipped' ? new Date() : undefined
      const piiExpiresAt = order.status === 'Canceled' ? new Date() : shippedAt ? new Date(shippedAt.getTime() + PII_RETENTION_DAYS * 86400000) : (existing.piiExpiresAt ?? new Date(Date.now() + 90 * 86400000))
      await prisma.order.update({ where: { sellerAccountId_amazonOrderId: { sellerAccountId, amazonOrderId: order.amazonOrderId } }, data: { shippedAt, piiExpiresAt } })
      continue
    }
    needsToken.push(order.amazonOrderId)
  }
  for (let index = 0; index < needsToken.length; index += 50) {
    const chunk = needsToken.slice(index, index + 50)
    const tokenResponse = await client.createRestrictedDataToken(chunk)
    const tokenRecord = (tokenResponse.payload ?? tokenResponse) as JsonObject
    const restricted = typeof tokenRecord.restrictedDataToken === 'string' ? tokenRecord.restrictedDataToken : ''
    if (!restricted) throw new Error('RDT_NOT_RETURNED')
    for (const amazonOrderId of chunk) {
      const response = await client.getOrder(amazonOrderId, restricted)
      const payload = (response.payload ?? response) as JsonObject
      const buyer = (payload.BuyerInfo ?? {}) as JsonObject
      const ship = (payload.ShippingAddress ?? {}) as JsonObject
      const pii = {
        buyerName: typeof buyer.BuyerName === 'string' ? buyer.BuyerName : typeof ship.Name === 'string' ? ship.Name : undefined,
        buyerEmail: typeof buyer.BuyerEmail === 'string' ? buyer.BuyerEmail : undefined,
        buyerPhone: typeof ship.Phone === 'string' ? ship.Phone : undefined,
        addressLine1: typeof ship.AddressLine1 === 'string' ? ship.AddressLine1 : undefined,
        city: typeof ship.City === 'string' ? ship.City : undefined,
        state: typeof ship.StateOrProvinceCode === 'string' ? ship.StateOrProvinceCode : undefined,
        postalCode: typeof ship.PostalCode === 'string' ? ship.PostalCode : undefined,
        country: typeof ship.CountryCode === 'string' ? ship.CountryCode : undefined,
      }
      if (!Object.values(pii).some(Boolean)) continue
      const status = String(payload.OrderStatus ?? '')
      const shipRaw = payload.EarliestShipDate ?? payload.LatestShipDate ?? payload.LastUpdateDate
      const parsedShip = shipRaw ? new Date(String(shipRaw)) : null
      const shippedAt = status === 'Shipped' ? (parsedShip && !Number.isNaN(parsedShip.getTime()) ? parsedShip : new Date()) : null
      const purchase = payload.PurchaseDate ? new Date(String(payload.PurchaseDate)) : null
      const purchasedAt = purchase && !Number.isNaN(purchase.getTime()) ? purchase : new Date()
      const agedOut = purchasedAt.getTime() + 90 * 86400000 < Date.now()
      const piiExpiresAt = status === 'Canceled' || agedOut ? new Date() : shippedAt ? new Date(shippedAt.getTime() + PII_RETENTION_DAYS * 86400000) : new Date(purchasedAt.getTime() + 90 * 86400000)
      await prisma.order.update({ where: { sellerAccountId_amazonOrderId: { sellerAccountId, amazonOrderId } }, data: { piiCiphertext: sealPii(JSON.stringify(pii)), shippedAt, piiExpiresAt } })
    }
  }
}
function reportRows(text: string) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length < 2) return [] as JsonObject[]
  const headers = lines[0].split('\t').map(item => item.trim())
  return lines.slice(1).map(line => {
    const values = line.split('\t')
    return headers.reduce<JsonObject>((row, header, index) => { row[header] = values[index] ?? ''; return row }, {})
  })
}
function decimal(value: unknown) { const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(parsed) ? parsed : undefined }
async function syncCatalogReport(text: string, reportJob: { documentId: string | null; sellerAccountId: string | null }, tenantId: string, marketplaceId: string) {
  if (!reportJob.documentId || !reportJob.sellerAccountId) throw new Error('CATALOG_REPORT_CONTEXT_MISSING')
  const document = { text }
  let imported = 0
  for (const item of reportRows(document.text)) {
    const sellerSku = String(item['seller-sku'] ?? item['seller_sku'] ?? '').trim()
    const asin = String(item.asin1 ?? item.asin ?? item['product-id'] ?? '').trim()
    if (!sellerSku || !asin) continue
    const channel = String(item['fulfillment-channel'] ?? item['fulfillment_channel'] ?? 'AFN').trim()
    const status = String(item.status ?? 'ACTIVE').trim().toUpperCase()
    await prisma.fbaProduct.upsert({
      where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId: reportJob.sellerAccountId, marketplaceId, sellerSku } },
      create: { tenantId, sellerAccountId: reportJob.sellerAccountId, marketplaceId, asin, sellerSku, title: String(item['item-name'] ?? item.title ?? asin), listingStatus: status, fulfillmentChannel: channel, price: decimal(item.price), currency: String(item.currency ?? 'USD'), sourceUpdatedAt: new Date() },
      update: { asin, title: String(item['item-name'] ?? item.title ?? asin), listingStatus: status, fulfillmentChannel: channel, price: decimal(item.price), sourceUpdatedAt: new Date() },
    })
    imported += 1
  }
  return imported
}
function valueFrom(row: JsonObject, names: string[]) {
  for (const name of names) if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name]
  return undefined
}
function dateFrom(value: unknown) {
  const date = new Date(String(value ?? ''))
  return Number.isNaN(date.getTime()) ? new Date() : date
}
async function syncOrdersReport(text: string, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  let imported = 0
  for (const row of reportRows(text)) {
    const amazonOrderId = String(valueFrom(row, ['amazon-order-id', 'order-id', 'AmazonOrderId']) ?? '').trim()
    if (!amazonOrderId) continue
    const total = decimal(valueFrom(row, ['item-price', 'order-total', 'amount']))
    const currency = String(valueFrom(row, ['currency', 'currency-code', 'item-currency']) ?? 'USD')
    const order = await prisma.order.upsert({
      where: { sellerAccountId_amazonOrderId: { sellerAccountId, amazonOrderId } },
      create: { tenantId, sellerAccountId, amazonOrderId, marketplaceId, purchaseDate: dateFrom(valueFrom(row, ['purchase-date', 'purchase-date-local'])), status: String(valueFrom(row, ['order-status', 'order-status-description']) ?? 'UNKNOWN'), fulfillment: String(valueFrom(row, ['fulfillment-channel']) ?? '') || undefined, currency, amount: total, itemCount: 0, sourceUpdatedAt: new Date(), sourceRecordId: amazonOrderId },
      update: { status: String(valueFrom(row, ['order-status', 'order-status-description']) ?? 'UNKNOWN'), currency, amount: total, sourceUpdatedAt: new Date() },
    })
    const sellerSku = String(valueFrom(row, ['sku', 'seller-sku']) ?? '').trim()
    const asin = String(valueFrom(row, ['asin', 'product-id']) ?? '').trim()
    if (sellerSku || asin) {
      const orderItemId = String(valueFrom(row, ['order-item-id', 'order-item-id']) ?? [amazonOrderId, sellerSku || asin].join(':')).trim()
      await prisma.orderItem.upsert({
        where: { sellerAccountId_orderItemId: { sellerAccountId, orderItemId } },
        create: { tenantId, sellerAccountId, orderId: order.id, amazonOrderId, orderItemId, asin: asin || undefined, sellerSku: sellerSku || undefined, title: String(valueFrom(row, ['product-name', 'title']) ?? '') || undefined, quantityOrdered: Number(valueFrom(row, ['quantity', 'quantity-ordered']) ?? 0), quantityShipped: Number(valueFrom(row, ['quantity-shipped']) ?? 0), itemPrice: decimal(valueFrom(row, ['item-price'])), currency, sourceUpdatedAt: new Date() },
        update: { orderId: order.id, asin: asin || undefined, sellerSku: sellerSku || undefined, quantityOrdered: Number(valueFrom(row, ['quantity', 'quantity-ordered']) ?? 0), quantityShipped: Number(valueFrom(row, ['quantity-shipped']) ?? 0), itemPrice: decimal(valueFrom(row, ['item-price'])), sourceUpdatedAt: new Date() },
      })
      await prisma.order.update({ where: { id: order.id }, data: { itemCount: { increment: 1 } } })
    }
    imported += 1
  }
  return imported
}
async function syncReturnsReport(text: string, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  let imported = 0
  for (const row of reportRows(text)) {
    const amazonOrderId = String(valueFrom(row, ['order-id', 'amazon-order-id']) ?? '').trim()
    const asin = String(valueFrom(row, ['asin', 'product-id']) ?? 'UNKNOWN').trim()
    if (!amazonOrderId) continue
    const returnDate = dateFrom(valueFrom(row, ['return-date', 'return-request-date', 'return-date-time']))
    await prisma.fbaReturnCase.upsert({
      where: { sellerAccountId_amazonOrderId_asin_returnDate: { sellerAccountId, amazonOrderId, asin, returnDate } },
      create: { tenantId, sellerAccountId, marketplaceId, amazonOrderId, returnId: String(valueFrom(row, ['return-id', 'return-request-id']) ?? '') || undefined, asin, sellerSku: String(valueFrom(row, ['sku', 'seller-sku']) ?? 'UNKNOWN'), quantity: Number(valueFrom(row, ['quantity', 'return-quantity']) ?? 1), disposition: String(valueFrom(row, ['detailed-disposition', 'disposition']) ?? '') || undefined, reason: String(valueFrom(row, ['reason', 'return-reason']) ?? '') || undefined, refundAmount: decimal(valueFrom(row, ['refund-amount', 'refund-amount-per-unit'])), returnDate, sourceUpdatedAt: new Date() },
      update: { returnId: String(valueFrom(row, ['return-id', 'return-request-id']) ?? '') || undefined, quantity: Number(valueFrom(row, ['quantity', 'return-quantity']) ?? 1), disposition: String(valueFrom(row, ['detailed-disposition', 'disposition']) ?? '') || undefined, reason: String(valueFrom(row, ['reason', 'return-reason']) ?? '') || undefined, refundAmount: decimal(valueFrom(row, ['refund-amount', 'refund-amount-per-unit'])), sourceUpdatedAt: new Date() },
    })
    imported += 1
  }
  return imported
}
async function syncSettlementReport(text: string, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  let imported = 0
  for (const row of reportRows(text)) {
    const externalSettlementId = String(valueFrom(row, ['settlement-id', 'settlement-id']) ?? '').trim()
    if (!externalSettlementId) continue
    const currency = String(valueFrom(row, ['currency', 'currency-code']) ?? 'USD')
    const settlement = await prisma.fbaSettlement.upsert({
      where: { sellerAccountId_externalSettlementId: { sellerAccountId, externalSettlementId } },
      create: { tenantId, sellerAccountId, marketplaceId, externalSettlementId, settlementStartDate: dateFrom(valueFrom(row, ['settlement-start-date'])), settlementEndDate: dateFrom(valueFrom(row, ['settlement-end-date'])), depositDate: dateFrom(valueFrom(row, ['deposit-date'])), totalAmount: decimal(valueFrom(row, ['total-amount'])), currency, sourceUpdatedAt: new Date(), raw: JSON.parse(JSON.stringify(row)) },
      update: { totalAmount: decimal(valueFrom(row, ['total-amount'])), currency, sourceUpdatedAt: new Date(), raw: JSON.parse(JSON.stringify(row)) },
    })
    const transactionId = String(valueFrom(row, ['transaction-id', 'transaction-id']) ?? [externalSettlementId, imported].join(':')).trim()
    await prisma.fbaFinancialTransaction.upsert({
      where: { sellerAccountId_externalTransactionId: { sellerAccountId, externalTransactionId: transactionId } },
      create: { tenantId, sellerAccountId, settlementId: settlement.id, marketplaceId, externalTransactionId: transactionId, amazonOrderId: String(valueFrom(row, ['order-id', 'amazon-order-id']) ?? '') || undefined, transactionType: String(valueFrom(row, ['transaction-type']) ?? '') || undefined, transactionStatus: 'POSTED', amount: decimal(valueFrom(row, ['amount', 'total-amount'])) ?? 0, currency, postedAt: dateFrom(valueFrom(row, ['posted-date', 'transaction-date'])), description: String(valueFrom(row, ['transaction-type']) ?? '') || undefined, raw: JSON.parse(JSON.stringify(row)), sourceUpdatedAt: new Date() },
      update: { settlementId: settlement.id, amount: decimal(valueFrom(row, ['amount', 'total-amount'])) ?? 0, transactionType: String(valueFrom(row, ['transaction-type']) ?? '') || undefined, postedAt: dateFrom(valueFrom(row, ['posted-date', 'transaction-date'])), raw: JSON.parse(JSON.stringify(row)), sourceUpdatedAt: new Date() },
    })
    imported += 1
  }
  return imported
}
async function syncInboundPlan(client: AmazonSpApiClient, tenantId: string, planId: string) {
  const plan = await prisma.fbaInboundPlan.findUnique({ where: { id: planId } })
  if (!plan?.externalPlanId) throw new Error('FBA_INBOUND_EXTERNAL_PLAN_MISSING')
  const shipmentIds: string[] = []
  let pageToken: string | undefined
  do {
    const response = await client.listInboundPlanShipments(plan.externalPlanId, pageToken)
    const payload = (response.payload ?? response) as JsonObject
    const shipments = Array.isArray(payload.shipments) ? payload.shipments as JsonObject[] : []
    for (const shipment of shipments) {
      const shipmentId = String(shipment.shipmentId ?? '').trim()
      if (shipmentId) shipmentIds.push(shipmentId)
    }
    const pagination = (payload.pagination ?? {}) as JsonObject
    pageToken = typeof pagination.nextToken === 'string' && pagination.nextToken ? pagination.nextToken : undefined
  } while (pageToken)
  for (const shipmentId of shipmentIds) {
    const response = await client.getInboundPlanShipment(plan.externalPlanId, shipmentId)
    const detail = (response.payload ?? response) as JsonObject
    const destination = (detail.destination ?? {}) as JsonObject
    let expected = 0
    let received = 0
    let itemToken: string | undefined
    do {
      const itemsResponse = await client.listInboundShipmentItems(plan.externalPlanId, shipmentId, itemToken)
      const itemsPayload = (itemsResponse.payload ?? itemsResponse) as JsonObject
      const items = Array.isArray(itemsPayload.items) ? itemsPayload.items as JsonObject[] : []
      for (const item of items) {
        expected += Number(item.quantity ?? 0)
        received += Number(item.receivedQuantity ?? 0)
      }
      const pagination = (itemsPayload.pagination ?? {}) as JsonObject
      itemToken = typeof pagination.nextToken === 'string' && pagination.nextToken ? pagination.nextToken : undefined
    } while (itemToken)
    await prisma.fbaInboundShipment.upsert({
      where: { planId_shipmentId: { planId, shipmentId } },
      create: { planId, shipmentId, status: String(detail.status ?? 'WORKING'), destinationFc: String(destination.warehouseId ?? '') || undefined, placementOption: String(detail.selectedTransportationOptionId ?? '') || undefined, transportStatus: String(detail.status ?? '') || undefined, trackingNumber: undefined, unitsExpected: expected, unitsReceived: received, discrepancyQuantity: expected - received, sourceUpdatedAt: new Date() },
      update: { status: String(detail.status ?? 'WORKING'), destinationFc: String(destination.warehouseId ?? '') || undefined, unitsExpected: expected, unitsReceived: received, discrepancyQuantity: expected - received, sourceUpdatedAt: new Date() },
    })
  }
  if (shipmentIds.length) await prisma.fbaInboundShipment.deleteMany({ where: { planId, shipmentId: { startsWith: 'LOCAL-' } } })
  const planResponse = await client.getInboundPlan(plan.externalPlanId)
  const planDetail = (planResponse.payload ?? planResponse) as JsonObject
  await prisma.fbaInboundPlan.update({ where: { id: plan.id }, data: { status: String(planDetail.status ?? plan.status), shipmentCount: shipmentIds.length, sourceUpdatedAt: new Date() } })
  return { imported: shipmentIds.length }
}
function adsReportRows(text: string) {
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return parsed.filter(item => item && typeof item === 'object') as JsonObject[]
    if (parsed && typeof parsed === 'object') {
      const object = parsed as JsonObject
      if (Array.isArray(object.rows)) return object.rows.filter(item => item && typeof item === 'object') as JsonObject[]
      return [object]
    }
  } catch {
    return text.split(/\r?\n/).filter(line => line.trim()).map(line => { try { return JSON.parse(line) as JsonObject } catch { return {} } }).filter(item => Object.keys(item).length > 0)
  }
  return [] as JsonObject[]
}
async function syncAdsReport(client: AmazonAdsApiClient, reportJob: { id: string; downloadUrl: string | null; fromDate: Date | null; adsProfileId: string; adProduct: string }, tenantId: string, url: string) {
  const text = await client.downloadReport(url)
  const rows = adsReportRows(text)
  let imported = 0
  for (const row of rows) {
      const reportDate = dateFrom(row.date ?? row.reportDate ?? reportJob.fromDate ?? new Date())
    const externalCampaignId = String(row.campaignId ?? row.campaign_id ?? row.advertisedAsin ?? row.advertisedSku ?? row.searchTerm ?? '').trim() || ''
    await prisma.adsMetric.upsert({
      where: { adsProfileId_reportDate_adProduct_externalCampaignId: { adsProfileId: reportJob.adsProfileId, reportDate, adProduct: reportJob.adProduct, externalCampaignId: externalCampaignId } },
      create: { tenantId, adsProfileId: reportJob.adsProfileId, reportJobId: reportJob.id, reportDate, adProduct: reportJob.adProduct, externalCampaignId: externalCampaignId, campaignName: String(row.campaignName ?? row.campaign_name ?? '') || undefined, impressions: Number(row.impressions ?? 0), clicks: Number(row.clicks ?? 0), cost: decimal(row.cost ?? row.spend), sales: decimal(row.sales7d ?? row.sales ?? row.attributedSales14d ?? row.attributed_sales_14d), purchases: Number(row.purchases7d ?? row.purchases ?? row.purchases14d ?? row.attributedConversions14d ?? 0), currency: String(row.currency ?? 'USD'), raw: JSON.parse(JSON.stringify(row)), sourceUpdatedAt: new Date() },
      update: { campaignName: String(row.campaignName ?? row.campaign_name ?? '') || undefined, impressions: Number(row.impressions ?? 0), clicks: Number(row.clicks ?? 0), cost: decimal(row.cost ?? row.spend), sales: decimal(row.sales7d ?? row.sales ?? row.attributedSales14d ?? row.attributed_sales_14d), purchases: Number(row.purchases7d ?? row.purchases ?? row.purchases14d ?? row.attributedConversions14d ?? 0), raw: JSON.parse(JSON.stringify(row)), sourceUpdatedAt: new Date() },
    })
    imported += 1
  }
  return imported
}
async function syncStorageFeeReport(text: string, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  let imported = 0
  for (const row of reportRows(text)) {
    const asin = String(valueFrom(row, ['asin']) ?? '').trim()
    const month = String(valueFrom(row, ['month-of-charge', 'month_of_charge']) ?? '').trim()
    if (!asin || !month) continue
    const amount = decimal(valueFrom(row, ['estimated-monthly-storage-fee', 'estimated_monthly_storage_fee'])) ?? 0
    const currency = String(valueFrom(row, ['currency']) ?? 'USD')
    const sellerSku = String(valueFrom(row, ['sku', 'seller-sku']) ?? '') || undefined
    const sourceEventId = ['storage', asin, month, sellerSku ?? ''].join(':').slice(0, 180)
    const postedAt = dateFrom(month.length === 7 ? `${month}-01` : month)
    await prisma.fbaFeeEvent.upsert({
      where: { sellerAccountId_sourceEventId: { sellerAccountId, sourceEventId } },
      create: { tenantId, sellerAccountId, marketplaceId, asin, sellerSku, eventType: 'STORAGE_FEE', amount, currency, postedAt, description: `FBA storage ${month}`, sourceEventId, sourceUpdatedAt: new Date() },
      update: { amount, currency, postedAt, sourceUpdatedAt: new Date() },
    })
    imported += 1
  }
  return imported
}
async function syncNoncomplianceReport(text: string, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  let imported = 0
  for (const row of reportRows(text)) {
    const shipmentId = String(valueFrom(row, ['fba-shipment-id', 'shipment-id']) ?? '').trim()
    const sku = String(valueFrom(row, ['sku', 'seller-sku']) ?? '').trim()
    const problem = String(valueFrom(row, ['problem-type', 'problem_type']) ?? '').trim()
    if (!shipmentId && !sku) continue
    const amount = decimal(valueFrom(row, ['fee-total', 'fee_total'])) ?? 0
    const currency = String(valueFrom(row, ['currency']) ?? 'USD')
    const postedAt = dateFrom(valueFrom(row, ['issue-reported-date', 'shipment-creation-date']))
    const sourceEventId = ['noncompliance', shipmentId, sku, problem, postedAt.toISOString().slice(0, 10)].join(':').slice(0, 180)
    await prisma.fbaFeeEvent.upsert({
      where: { sellerAccountId_sourceEventId: { sellerAccountId, sourceEventId } },
      create: { tenantId, sellerAccountId, marketplaceId, asin: String(valueFrom(row, ['asin']) ?? '') || undefined, sellerSku: sku || undefined, eventType: 'INBOUND_NONCOMPLIANCE', amount, currency, postedAt, description: problem || 'Inbound noncompliance', sourceEventId, sourceUpdatedAt: new Date() },
      update: { amount, currency, postedAt, description: problem || 'Inbound noncompliance', sourceUpdatedAt: new Date() },
    })
    imported += 1
  }
  return imported
}
const REGION_MARKETS: Record<string, Set<string>> = {
  na: new Set(['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC']),
  eu: new Set(['A1F83G8C2ARO7P', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'APJ6JRA9NG5V4', 'A1RKKUPIHCS9HS', 'A1805IZSGTT6HS', 'A2NODRKZP88ZB9', 'A1C3SOZRARQ6R3', 'AMEN7PMS3EDWL']),
  fe: new Set(['A1VC38T7YXB528', 'A39IBJ37TRP1C6', 'A19VAU5U5O7RUS']),
}
function endpointRegion() {
  const host = process.env.AMAZON_SP_API_ENDPOINT ?? ''
  if (host.includes('-eu.')) return 'eu'
  if (host.includes('-fe.')) return 'fe'
  return 'na'
}
async function participatingMarketplaces(client: AmazonSpApiClient, sellerAccountId: string, fallback: string) {
  const allowed = REGION_MARKETS[endpointRegion()]
  try {
    const response = await client.getMarketplaceParticipations()
    const payload = (response.payload ?? response) as unknown
    const rows = Array.isArray(payload) ? payload as JsonObject[] : []
    const ids = rows.flatMap(item => {
      const marketplace = (item.marketplace ?? {}) as JsonObject
      const participation = (item.participation ?? {}) as JsonObject
      const id = String(marketplace.id ?? '')
      if (!id || participation.isParticipating === false || !allowed.has(id)) return []
      return [id]
    })
    if (ids.length) {
      await prisma.sellerAccount.update({ where: { id: sellerAccountId }, data: { marketplaceIds: ids } })
      return ids
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'marketplace participation lookup failed')
  }
  return [fallback]
}
async function priorSyncCursor(connectionId: string, type: string, currentJobId: string) {
  const prior = await prisma.syncJob.findFirst({ where: { connectionId, type, status: 'SUCCEEDED', id: { not: currentJobId } }, orderBy: { finishedAt: 'desc' } })
  return prior?.finishedAt ?? null
}
async function processProduction(payload: SyncPayload, row: { type: string; tenantId: string; connection: { id: string; encryptedRefreshToken: string | null; sellerAccountId: string | null; adsProfileId: string | null; provider: string } }) {
  const marketplaceId = payload.marketplaceId ?? 'ATVPDKIKX0DER'
  if (row.connection.provider === 'AMAZON_ADS_API') {
    const client = new AmazonAdsApiClient(row.connection)
    if (row.type === 'FBA_ADS') return syncAdsProfiles(client, row.tenantId, row.connection.id)
    if (row.type === 'ADS_REPORT_CREATE' || row.type === 'ADS_REPORT_POLL') {
      if (!payload.reportJobId) throw new Error('ADS_REPORT_JOB_CONTEXT_MISSING')
      const reportJob = await prisma.adsReportJob.findUnique({ where: { id: payload.reportJobId }, include: { adsProfile: true } })
      if (!reportJob) throw new Error('ADS_REPORT_JOB_NOT_FOUND')
      const profileId = reportJob.adsProfile.profileId
      if (!payload.poll) {
        const fromDate = (reportJob.fromDate ?? new Date(Date.now() - 30 * 86400000)).toISOString().slice(0, 10)
        const toDate = (reportJob.toDate ?? new Date()).toISOString().slice(0, 10)
        const response = await client.requestReport(profileId, { reportType: reportJob.reportType, fromDate, toDate, adProduct: reportJob.adProduct })
        const reportId = typeof response.reportId === 'string' ? response.reportId : typeof response.id === 'string' ? response.id : undefined
        if (!reportId) throw new Error('ADS_REPORT_ID_NOT_RETURNED')
        await prisma.adsReportJob.update({ where: { id: reportJob.id }, data: { status: 'GENERATING', externalReportId: reportId } })
        return { pending: true, reportId }
      }
      if (!reportJob.externalReportId) throw new Error('ADS_REPORT_ID_MISSING')
      const response = await client.getReport(profileId, reportJob.externalReportId)
      const status = String(response.status ?? response.reportStatus ?? 'IN_PROGRESS').toUpperCase()
      if (['COMPLETED', 'SUCCESS', 'DONE'].includes(status)) {
        const downloadUrl = typeof response.url === 'string' ? response.url : typeof response.downloadUrl === 'string' ? response.downloadUrl : undefined
        const imported = downloadUrl ? await syncAdsReport(client, reportJob, row.tenantId, downloadUrl) : 0
        await prisma.adsReportJob.update({ where: { id: reportJob.id }, data: { status: 'READY', downloadUrl, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } })
        return { ready: true, reportId: reportJob.externalReportId, imported }
      }
      if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(status)) {
        await prisma.adsReportJob.update({ where: { id: reportJob.id }, data: { status: 'FAILED', failureCode: status } })
        throw new Error(`ADS_REPORT_${status}`)
      }
      return { pending: true, reportId: reportJob.externalReportId }
    }
    throw new Error('ADS_CONNECTOR_OPERATION_NOT_IMPLEMENTED')
  }

  const sellerAccountId = row.connection.sellerAccountId
  if (!sellerAccountId) throw new Error('SELLER_ACCOUNT_NOT_BOUND')
  const client = new AmazonSpApiClient(row.connection)
  const markets = await participatingMarketplaces(client, sellerAccountId, marketplaceId)
  const since = await priorSyncCursor(row.connection.id, row.type, payload.syncJobId)
  if (row.type === 'FBA_INVENTORY') {
    let imported = 0
    for (const market of markets) imported += await syncInventory(client, row.tenantId, sellerAccountId, market)
    return { imported, markets }
  }
  if (row.type === 'FBA_ORDERS') {
    let imported = 0
    const orderIds: Array<{ amazonOrderId: string; status: string }> = []
    for (const market of markets) {
      const result = await syncOrders(client, row.tenantId, sellerAccountId, market, since)
      imported += result.imported
      orderIds.push(...result.orderIds)
    }
    try { await syncOrderPii(client, sellerAccountId, orderIds) } catch (error) { logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'order rows imported; buyer information was not stored') }
    return { imported, markets }
  }
  if (row.type === 'FBA_FINANCE') return syncFinance(client, row.tenantId, sellerAccountId, marketplaceId, since)
  if (row.type === 'FBA_INBOUND_CREATE') {
    if (!payload.fbaPlanId) throw new Error('FBA_PLAN_CONTEXT_MISSING')
    const plan = await prisma.fbaInboundPlan.findUnique({ where: { id: payload.fbaPlanId } })
    if (!plan || !Array.isArray(plan.items)) throw new Error('FBA_PLAN_ITEMS_MISSING')
    const response = await client.createInboundPlan({ name: plan.name, sourceAddress: plan.sourceAddress, items: plan.items as Array<{ sellerSku: string; asin: string; quantity: number; prepOwner?: string; labelOwner?: string }> })
    const externalPlanId = typeof response.inboundPlanId === 'string' ? response.inboundPlanId : typeof response.planId === 'string' ? response.planId : undefined
    if (!externalPlanId) throw new Error('FBA_INBOUND_PLAN_ID_NOT_RETURNED')
    await prisma.fbaInboundPlan.update({ where: { id: plan.id }, data: { externalPlanId, status: 'CREATED', sourceUpdatedAt: new Date() } })
    return { externalPlanId }
  }
  if (row.type === 'FBA_INBOUND_SYNC') {
    if (payload.fbaPlanId) return syncInboundPlan(client, row.tenantId, payload.fbaPlanId)
    const plans = await prisma.fbaInboundPlan.findMany({ where: { tenantId: row.tenantId, sellerAccountId, externalPlanId: { not: null } }, select: { id: true } })
    let imported = 0
    for (const plan of plans) imported += (await syncInboundPlan(client, row.tenantId, plan.id)).imported
    return { imported, plans: plans.length }
  }
  if (row.type === 'FBA_REPORT_CREATE' || row.type === 'FBA_REPORT_POLL') {
    if (!payload.reportJobId) throw new Error('REPORT_JOB_CONTEXT_MISSING')
    const reportJob = await prisma.fbaReportJob.findUnique({ where: { id: payload.reportJobId } })
    if (!reportJob) throw new Error('REPORT_JOB_NOT_FOUND')
    if (!payload.poll) {
      if (!payload.reportType) throw new Error('REPORT_TYPE_CONTEXT_MISSING')
      const report = await client.createReport(payload.reportType, reportJob.marketplaceId || marketplaceId, { from: reportJob.fromDate, to: reportJob.toDate })
      const reportBody = (report.payload ?? report) as JsonObject
      const reportId = typeof reportBody.reportId === 'string' ? reportBody.reportId : undefined
      if (!reportId) throw new Error('REPORT_ID_NOT_RETURNED')
      await prisma.fbaReportJob.update({ where: { id: payload.reportJobId }, data: { status: 'GENERATING', externalReportId: reportId } })
      return { pending: true, reportId }
    }
    if (!reportJob.externalReportId) throw new Error('REPORT_ID_MISSING')
    const report = await client.getReport(reportJob.externalReportId)
    const reportStatusBody = (report.payload ?? report) as JsonObject
    const status = String(reportStatusBody.processingStatus ?? reportStatusBody.status ?? 'IN_PROGRESS').toUpperCase()
    if (status === 'DONE' || status === 'COMPLETED') {
      const documentId = typeof reportStatusBody.reportDocumentId === 'string' ? reportStatusBody.reportDocumentId : typeof reportStatusBody.documentId === 'string' ? reportStatusBody.documentId : undefined
      if (!documentId) throw new Error('REPORT_DOCUMENT_ID_NOT_RETURNED')
      const document = await client.downloadReportDocument(documentId)
      const downloadUrl = typeof document.metadata.url === 'string' ? document.metadata.url : undefined
      let imported = 0
      const parsedRows = reportRows(document.text)
      if (reportJob.reportType === 'GET_MERCHANT_LISTINGS_ALL_DATA') imported = await syncCatalogReport(document.text, reportJob, row.tenantId, marketplaceId)
      else if (reportJob.reportType === 'GET_FBA_STORAGE_FEE_CHARGES_DATA') imported = await syncStorageFeeReport(document.text, row.tenantId, sellerAccountId, marketplaceId)
      else if (reportJob.reportType === 'GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA') imported = await syncNoncomplianceReport(document.text, row.tenantId, sellerAccountId, marketplaceId)
      else if (reportJob.reportType.includes('RETURNS')) imported = await syncReturnsReport(document.text, row.tenantId, sellerAccountId, marketplaceId)
      else if (reportJob.reportType.includes('SETTLEMENT')) imported = await syncSettlementReport(document.text, row.tenantId, sellerAccountId, marketplaceId)
      else if (reportJob.reportType.includes('ORDERS')) imported = await syncOrdersReport(document.text, row.tenantId, sellerAccountId, marketplaceId)
      else throw new Error('REPORT_IMPORTER_NOT_IMPLEMENTED')
      if (parsedRows.length > 0 && imported === 0) throw new Error('REPORT_ROWS_NOT_IMPORTED')
      await prisma.fbaReportJob.update({ where: { id: reportJob.id }, data: { status: 'READY', documentId, downloadUrl, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } })
      return { ready: true, reportId: reportJob.externalReportId, imported }
    }
    if (['FATAL', 'CANCELLED', 'CANCELED', 'FAILED'].includes(status)) {
      await prisma.fbaReportJob.update({ where: { id: reportJob.id }, data: { status: 'FAILED', failureCode: status } })
      throw new Error(`REPORT_${status}`)
    }
    return { pending: true, reportId: reportJob.externalReportId }
  }
  throw new Error('CONNECTOR_IMPORTER_NOT_IMPLEMENTED')
}
async function processSync(job: Job<SyncPayload>) {
  const payload = job.data
  const row = await prisma.syncJob.findUnique({ where: { id: payload.syncJobId }, include: { connection: true } })
  if (!row) return
  await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), failureCode: null } })
  try {
    if (mock) {
      await new Promise(resolve => setTimeout(resolve, 300))
      await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'SUCCEEDED', progressCurrent: 1, progressTotal: 1, finishedAt: new Date() } })
      if (payload.reportJobId) await prisma.fbaReportJob.update({ where: { id: payload.reportJobId }, data: { status: 'READY', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } }).catch(() => undefined)
      if (payload.fbaPlanId) await prisma.fbaInboundPlan.update({ where: { id: payload.fbaPlanId }, data: { status: 'READY_FOR_PLACEMENT' } }).catch(() => undefined)
      return
    }
    const result = await processProduction(payload, row)
    if ((result as { pending?: boolean }).pending) {
      await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'PENDING', progressCurrent: 0, progressTotal: 1, finishedAt: null } })
      await syncQueue.add('sync', { ...payload, poll: true }, { jobId: `${row.id}-poll-${Date.now()}`, delay: 30000, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 2000 })
      logger.info({ jobId: row.id, requestId: payload.requestId, result }, 'Amazon report is still generating; poll scheduled')
      return
    }
    await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'SUCCEEDED', progressCurrent: 1, progressTotal: 1, finishedAt: new Date() } })
    await prisma.platformConnection.update({ where: { id: row.connectionId }, data: { lastSuccessfulSyncAt: new Date(), lastHealthCheckedAt: new Date(), lastErrorCode: null } }).catch(() => undefined)
    logger.info({ jobId: row.id, requestId: payload.requestId, result }, 'Amazon data import completed')  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'CONNECTOR_FAILED'; await markFailure(payload, code); await prisma.platformConnection.update({ where: { id: row.connectionId }, data: { lastHealthCheckedAt: new Date(), lastErrorCode: code } }).catch(() => undefined); logger.error({ jobId: row.id, requestId: payload.requestId, code }, 'Amazon data import failed')
  }
}

async function scheduleProductionSync() {
  if (process.env.APP_MODE !== 'production' || process.env.MOCK_CONNECTOR === 'true') return
  const connections = await prisma.platformConnection.findMany({ where: { state: 'AUTHORIZED', encryptedRefreshToken: { not: null } } })
  for (const connection of connections) {
    const active = await prisma.syncJob.count({ where: { connectionId: connection.id, status: { in: ['PENDING', 'RUNNING'] } } })
    if (active > 0) continue
    const types = connection.provider === 'AMAZON_ADS_API' ? ['FBA_ADS'] : connection.provider === 'AMAZON_SP_API' ? ['FBA_ORDERS', 'FBA_INVENTORY', 'FBA_FINANCE', 'FBA_INBOUND_SYNC'] : []
    for (const type of types) {
      const job = await prisma.syncJob.create({ data: { tenantId: connection.tenantId, connectionId: connection.id, type, status: 'PENDING', requestId: 'schedule' } })
      await syncQueue.add('sync', { syncJobId: job.id, requestId: 'schedule', marketplaceId: 'ATVPDKIKX0DER' }, { jobId: job.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 2000 })
    }
  }
}
async function purgeExpiredBuyerInformation() {
  const result = await prisma.order.updateMany({ where: { piiExpiresAt: { lte: new Date() }, piiCiphertext: { not: null } }, data: { piiCiphertext: null } })
  if (result.count) logger.info({ count: result.count }, 'expired buyer information deleted')
}
const piiTimer = setInterval(() => { void purgeExpiredBuyerInformation().catch(error => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'buyer information purge failed')) }, 60 * 60 * 1000)
const scheduleTimer = process.env.APP_MODE === 'production' ? setInterval(() => { void scheduleProductionSync().catch(error => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'scheduled sync failed')) }, 6 * 60 * 60 * 1000) : null
if (scheduleTimer) void scheduleProductionSync().catch(error => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'scheduled sync failed'))
void purgeExpiredBuyerInformation().catch(error => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'buyer information purge failed'))
const worker = new Worker<SyncPayload>('sync', processSync, { connection, concurrency: 4 })
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, error: error.message }, 'queue job failed'))
logger.info({ mock, mode: process.env.APP_MODE ?? 'development' }, 'NOVA worker started')
const shutdown = async () => { clearInterval(piiTimer); if (scheduleTimer) clearInterval(scheduleTimer); await worker.close(); await prisma.$disconnect(); await syncQueue.close(); await connection.quit(); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
