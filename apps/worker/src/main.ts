import { PrismaClient } from '@prisma/client'
import { Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import pino from 'pino'
import { AmazonSpApiClient } from './amazon-sp-api'

type SyncPayload = { syncJobId: string; requestId: string; marketplaceId?: string; fbaPlanId?: string; reportJobId?: string; reportType?: string; retry?: boolean }
type JsonObject = Record<string, unknown>

const prisma = new PrismaClient()
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['*.token', '*.secret', '*.encryptedRefreshToken'] })
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const mock = process.env.MOCK_CONNECTOR === 'true' && process.env.APP_MODE !== 'production'

async function markFailure(payload: SyncPayload, code: string) {
  await prisma.syncJob.update({ where: { id: payload.syncJobId }, data: { status: 'FAILED_PERMANENT', failureCode: code, finishedAt: new Date() } })
  if (payload.reportJobId) await prisma.fbaReportJob.update({ where: { id: payload.reportJobId }, data: { status: 'FAILED', failureCode: code } }).catch(() => undefined)
  if (payload.fbaPlanId) await prisma.fbaInboundPlan.update({ where: { id: payload.fbaPlanId }, data: { status: 'CREATE_FAILED' } }).catch(() => undefined)
}

async function syncInventory(client: AmazonSpApiClient, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  const response = await client.getInventory(marketplaceId); const payload = (response.payload ?? {}) as JsonObject; const summaries = Array.isArray(payload.inventorySummaries) ? payload.inventorySummaries as JsonObject[] : []
  for (const item of summaries) {
    const sellerSku = String(item.sellerSku ?? ''); const asin = String(item.asin ?? '')
    if (!sellerSku || !asin) continue
    const details = (item.inventoryDetails ?? {}) as JsonObject; const fulfillable = Number(details.fulfillableQuantity ?? 0); const reserved = Number(((details.reservedQuantity as JsonObject | undefined)?.totalReservedQuantity) ?? item.totalReservedQuantity ?? 0); const inboundWorking = Number(((details.inboundWorkingQuantity as JsonObject | undefined)?.quantity) ?? 0); const inboundShipped = Number(((details.inboundShippedQuantity as JsonObject | undefined)?.quantity) ?? 0); const inboundReceiving = Number(((details.inboundReceivingQuantity as JsonObject | undefined)?.quantity) ?? 0); const unfulfillable = Number(((details.unfulfillableQuantity as JsonObject | undefined)?.totalUnfulfillableQuantity) ?? 0)
    await prisma.fbaInventoryRecord.upsert({ where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId, marketplaceId, sellerSku } }, create: { tenantId, sellerAccountId, marketplaceId, asin, sellerSku, fnsku: typeof item.fnsku === 'string' ? item.fnsku : undefined, fulfillableQuantity: fulfillable, reservedQuantity: reserved, inboundWorkingQuantity: inboundWorking, inboundShippedQuantity: inboundShipped, inboundReceivingQuantity: inboundReceiving, unfulfillableQuantity: unfulfillable, sourceUpdatedAt: new Date(), healthStatus: fulfillable < 20 ? 'LOW_STOCK' : 'HEALTHY' }, update: { asin, fnsku: typeof item.fnsku === 'string' ? item.fnsku : undefined, fulfillableQuantity: fulfillable, reservedQuantity: reserved, inboundWorkingQuantity: inboundWorking, inboundShippedQuantity: inboundShipped, inboundReceivingQuantity: inboundReceiving, unfulfillableQuantity: unfulfillable, sourceUpdatedAt: new Date(), healthStatus: fulfillable < 20 ? 'LOW_STOCK' : 'HEALTHY' } })
  }
  return summaries.length
}

async function syncOrders(client: AmazonSpApiClient, tenantId: string, sellerAccountId: string, marketplaceId: string) {
  const response = await client.getOrders(marketplaceId); const payload = (response.payload ?? {}) as JsonObject; const orders = Array.isArray(payload.Orders) ? payload.Orders as JsonObject[] : []
  for (const item of orders) {
    const amazonOrderId = String(item.AmazonOrderId ?? ''); if (!amazonOrderId) continue
    const total = (item.OrderTotal ?? {}) as JsonObject
    await prisma.order.upsert({ where: { sellerAccountId_amazonOrderId: { sellerAccountId, amazonOrderId } }, create: { tenantId, sellerAccountId, amazonOrderId, marketplaceId, purchaseDate: new Date(String(item.PurchaseDate)), status: String(item.OrderStatus ?? 'UNKNOWN'), fulfillment: typeof item.FulfillmentChannel === 'string' ? item.FulfillmentChannel : undefined, currency: String(total.CurrencyCode ?? 'USD'), amount: total.Amount ? Number(total.Amount) : undefined, sourceUpdatedAt: new Date(), sourceRecordId: amazonOrderId }, update: { marketplaceId, purchaseDate: new Date(String(item.PurchaseDate)), status: String(item.OrderStatus ?? 'UNKNOWN'), fulfillment: typeof item.FulfillmentChannel === 'string' ? item.FulfillmentChannel : undefined, currency: String(total.CurrencyCode ?? 'USD'), amount: total.Amount ? Number(total.Amount) : undefined, sourceUpdatedAt: new Date() } })
  }
  return orders.length
}

async function processProduction(payload: SyncPayload, row: { type: string; tenantId: string; connection: { encryptedRefreshToken: string | null; sellerAccountId: string | null } }) {
  const marketplaceId = payload.marketplaceId ?? 'ATVPDKIKX0DER'; const sellerAccountId = row.connection.sellerAccountId
  if (!sellerAccountId) throw new Error('SELLER_ACCOUNT_NOT_BOUND')
  const client = new AmazonSpApiClient(row.connection)
  if (row.type === 'FBA_INVENTORY') return { imported: await syncInventory(client, row.tenantId, sellerAccountId, marketplaceId) }
  if (row.type === 'FBA_ORDERS') return { imported: await syncOrders(client, row.tenantId, sellerAccountId, marketplaceId) }
  if (row.type === 'FBA_REPORT_CREATE') {
    if (!payload.reportJobId || !payload.reportType) throw new Error('REPORT_JOB_CONTEXT_MISSING')
    const report = await client.createReport(payload.reportType, marketplaceId); const reportId = typeof report.reportId === 'string' ? report.reportId : undefined
    if (!reportId) throw new Error('REPORT_ID_NOT_RETURNED')
    await prisma.fbaReportJob.update({ where: { id: payload.reportJobId }, data: { status: 'GENERATING', externalReportId: reportId } })
    return { reportId }
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
    await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'SUCCEEDED', progressCurrent: 1, progressTotal: 1, finishedAt: new Date() } })
    logger.info({ jobId: row.id, requestId: payload.requestId, result }, 'Amazon data import completed')
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'CONNECTOR_FAILED'; await markFailure(payload, code); logger.error({ jobId: row.id, requestId: payload.requestId, code }, 'Amazon data import failed')
  }
}

const worker = new Worker<SyncPayload>('sync', processSync, { connection, concurrency: 4 })
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, error: error.message }, 'queue job failed'))
logger.info({ mock, mode: process.env.APP_MODE ?? 'development' }, 'NOVA worker started')
const shutdown = async () => { await worker.close(); await prisma.$disconnect(); await connection.quit(); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
