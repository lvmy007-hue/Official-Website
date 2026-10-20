import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import { randomBytes, createHash, createCipheriv } from 'node:crypto'
import { ContactRequestInput, LegalEntityCreateInput, FbaInboundPlanCreateInput, FbaListQuery, FbaReportCreateInput, FbaSyncCreateInput, AdsReportCreateInput, OAuthStartSchema, SyncCreateSchema } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { PrismaService } from './prisma.service'
import { ApiContext, AppError, RequestWithContext } from './http'
import { AuthService } from './auth.service'
import { QueueService } from './queue.service'
import { openPii } from './pii-vault'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
function encryptRefreshToken(value: string) { const key = process.env.TOKEN_ENCRYPTION_KEY ?? ''; if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new AppError(503, 'TOKEN_VAULT_NOT_CONFIGURED', 'TOKEN_ENCRYPTION_KEY 未配置为 32 字节十六进制密钥', false); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); const tag = cipher.getAuthTag(); return [iv, tag, encrypted].map(part => part.toString('base64url')).join('.') }
@Injectable()
export class ApiService { constructor(private readonly prisma: PrismaService, private readonly auth: AuthService, private readonly queue: QueueService, private readonly config: ConfigService) {}
  async createContactRequest(input: ContactRequestInput) {
    if (input.companyWebsite) return { accepted: true, reference: 'CONTACT-RECEIVED', receivedAt: new Date() }
    const message = [input.topic ? `咨询类型：${input.topic}` : '', input.storeBand ? `店铺数量：${input.storeBand}` : '', input.phone ? `电话：${input.phone}` : '', input.message].filter(Boolean).join('\n').slice(0, 5000)
    const record = await this.prisma.contactRequest.create({ data: { name: input.name, company: input.company, email: input.email, message: input.message, phone: input.phone, topic: input.topic, storeBand: input.storeBand } })
    return { accepted: true, reference: `CONTACT-${record.id}`, receivedAt: record.createdAt }
  }
  async health() { try { await this.prisma.$queryRaw`SELECT 1`; await this.queue.ping(); return { status: 'ok', service: 'nova-api', mode: process.env.APP_MODE ?? 'development', checks: { database: 'ok', redis: 'ok' } } } catch { throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', '依赖服务尚未就绪，请稍后重试', true) } }
  async context(req: RequestWithContext) { if (!req.user) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效'); if (process.env.APP_MODE === 'development' && process.env.LOCAL_NO_AUTH === 'true' && req.user.sessionId === 'local-dev-session') { const tenantId = process.env.LOCAL_DEV_TENANT_ID ?? 'local-dev-tenant'; const membership = await this.prisma.membership.findFirst({ where: { userId: req.user.userId, tenantId, status: 'ACTIVE' }, include: { role: true } }); if (!membership) throw new AppError(503, 'LOCAL_WORKSPACE_NOT_READY', '本地工作区尚未初始化，请重新启动服务'); const permissions = Array.isArray(membership.role.permissions) ? membership.role.permissions.map(String) : []; req.tenantId = tenantId; return { userId: req.user.userId, sessionId: req.user.sessionId, tenantId, permissions } } const value = await this.auth.context(req.user.userId, req.user.sessionId, req.header('x-tenant-context') ?? undefined); req.tenantId = value.tenantId; return value }
  require(context: ApiContext, permission: string) { if (!hasPermission(context.permissions, permission)) throw new AppError(403, 'TENANT_ACCESS_DENIED', '当前账号没有执行此操作的权限') }
  async me(req: RequestWithContext) { const context = await this.context(req); const [user, tenant] = await this.prisma.$transaction([this.prisma.user.findUniqueOrThrow({ where: { id: context.userId }, select: { id: true, email: true, displayName: true } }), this.prisma.tenant.findUniqueOrThrow({ where: { id: context.tenantId }, select: { id: true, name: true, slug: true, mode: true, timezone: true, defaultCurrency: true } })]); return { user, tenant, activeTenantId: context.tenantId, permissions: context.permissions } }
  async members(req: RequestWithContext) { const context = await this.context(req); this.require(context, 'member.read'); return this.prisma.membership.findMany({ where: { tenantId: context.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, status: true, createdAt: true, updatedAt: true, user: { select: { id: true, email: true, displayName: true, status: true, updatedAt: true } }, role: { select: { id: true, name: true, permissions: true, resourceScope: true } } } }) }
  async audit(req: RequestWithContext, query: Record<string,string>) { const context = await this.context(req); this.require(context, 'audit.read'); const page = Math.max(1, Number(query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 50))); const where = { tenantId: context.tenantId, ...(query.result ? { result: query.result } : {}), ...(query.q ? { OR: [{ action: { contains: query.q, mode: 'insensitive' as const } }, { resourceType: { contains: query.q, mode: 'insensitive' as const } }, { requestId: { contains: query.q, mode: 'insensitive' as const } }] } : {}) }; const [items, total] = await this.prisma.$transaction([this.prisma.auditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { actor: { select: { displayName: true, email: true } } } }), this.prisma.auditEvent.count({ where })]); return { items, total, page, pageSize } }
  async entities(req: RequestWithContext) { const context = await this.context(req); this.require(context, 'connection.manage'); return this.prisma.legalEntity.findMany({ where: { tenantId: context.tenantId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true, registeredCountry: true, status: true } }) }
  async createEntity(req: RequestWithContext, input: LegalEntityCreateInput) {
    const context = await this.context(req)
    this.require(context, 'connection.manage')
    const entity = await this.prisma.legalEntity.create({ data: { tenantId: context.tenantId, name: input.name, registeredCountry: input.registeredCountry, registrationNo: input.registrationNo } })
    await this.prisma.auditEvent.create({ data: { tenantId: context.tenantId, actorId: context.userId, action: 'LEGAL_ENTITY_CREATED', resourceType: 'LegalEntity', resourceId: entity.id, requestId: req.requestId, result: 'SUCCEEDED', detail: { name: entity.name, registeredCountry: entity.registeredCountry } } }).catch(() => undefined)
    return entity
  }
  async orders(req: RequestWithContext, query: Record<string,string>) { const context = await this.context(req); this.require(context, 'orders.read'); const page = Math.max(1, Number(query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20))); const where = { tenantId: context.tenantId, ...(query.status ? { status: query.status } : {}), ...(query.q ? { amazonOrderId: { contains: query.q, mode: 'insensitive' as const } } : {}) }; const [items,total] = await this.prisma.$transaction([this.prisma.order.findMany({ where, orderBy: [{ purchaseDate: 'desc' }, { amazonOrderId: 'desc' }], skip: (page-1)*pageSize, take: pageSize, include: { sellerAccount: { select: { displayName: true, logicalRegion: true } } } }), this.prisma.order.count({ where })]); return { items: items.map(order => this.presentOrder(order)), page, pageSize, total } }
  private presentOrder<T extends { piiCiphertext: string | null }>(order: T) { const { piiCiphertext, ...rest } = order; if (!piiCiphertext) return { ...rest, buyer: null }; try { return { ...rest, buyer: JSON.parse(openPii(piiCiphertext)) as Record<string, string | null> } } catch { return { ...rest, buyer: null } } }
  async inventory(req: RequestWithContext) { const context = await this.context(req); this.require(context, 'seller.read'); return this.prisma.inventorySnapshot.findMany({ where: { tenantId: context.tenantId }, orderBy: { available: 'asc' }, include: { sellerAccount: { select: { displayName: true } } } }) }
  private fbaWhere(tenantId: string, query: FbaListQuery) { return { tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { healthStatus: query.status } : {}), ...(query.q ? { OR: [{ asin: { contains: query.q, mode: 'insensitive' as const } }, { sellerSku: { contains: query.q, mode: 'insensitive' as const } }] } : {}) } }
  private async authorizedSpConnection(tenantId: string) { const connection = await this.prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } }, orderBy: { lastSuccessfulSyncAt: 'desc' } }); if (!connection) throw new AppError(409, 'FBA_CONNECTION_REQUIRED', '需要已完成授权并且已保存刷新令牌的 Amazon SP-API 连接'); return connection }
  async fbaSummary(req: RequestWithContext, query: Record<string,string>) { const context = await this.context(req); this.require(context, 'seller.read'); const marketplaceId = query.marketplaceId || undefined; const where = { tenantId: context.tenantId, ...(marketplaceId ? { marketplaceId } : {}) }; const [inventory, products, inbound, fees, returns] = await this.prisma.$transaction([this.prisma.fbaInventoryRecord.aggregate({ where, _count: { _all: true }, _sum: { fulfillableQuantity: true, reservedQuantity: true, inboundWorkingQuantity: true, inboundShippedQuantity: true, inboundReceivingQuantity: true, unfulfillableQuantity: true } }), this.prisma.fbaProduct.count({ where }), this.prisma.fbaInboundPlan.count({ where: { ...where, status: { not: 'CLOSED' } } }), this.prisma.fbaFeeEvent.aggregate({ where: { ...where, OR: [{ eventType: { contains: 'Fee' } }, { eventType: { in: ['Commission', 'RefundCommission', 'STORAGE_FEE', 'INBOUND_NONCOMPLIANCE'] } }] }, _sum: { amount: true } }), this.prisma.fbaReturnCase.count({ where: { ...where, status: { not: 'CLOSED' } } })]); return { marketplaceId, inventory, productCount: products, openInboundPlans: inbound, openReturns: returns, feeTotal: fees._sum.amount ?? 0, source: 'database' as const } }
  async fbaProducts(req: RequestWithContext, query: FbaListQuery) { const context = await this.context(req); this.require(context, 'seller.read'); const where = { tenantId: context.tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { listingStatus: query.status } : {}), ...(query.q ? { OR: [{ asin: { contains: query.q, mode: 'insensitive' as const } }, { sellerSku: { contains: query.q, mode: 'insensitive' as const } }, { title: { contains: query.q, mode: 'insensitive' as const } }] } : {}) }; const [items,total] = await this.prisma.$transaction([this.prisma.fbaProduct.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { sellerSku: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { sellerAccount: { select: { displayName: true, sellerId: true } } } }), this.prisma.fbaProduct.count({ where })]); return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId } }
  async fbaInventory(req: RequestWithContext, query: FbaListQuery) { const context = await this.context(req); this.require(context, 'seller.read'); const where = this.fbaWhere(context.tenantId, query); const [items,total] = await this.prisma.$transaction([this.prisma.fbaInventoryRecord.findMany({ where, orderBy: [{ healthStatus: 'asc' }, { daysOfSupply: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { sellerAccount: { select: { displayName: true, sellerId: true } } } }), this.prisma.fbaInventoryRecord.count({ where })]); return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId } }
  async fbaInboundPlans(req: RequestWithContext, query: FbaListQuery) { const context = await this.context(req); this.require(context, 'seller.read'); const where = { tenantId: context.tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' as const } }, { externalPlanId: { contains: query.q, mode: 'insensitive' as const } }] } : {}) }; const [items,total] = await this.prisma.$transaction([this.prisma.fbaInboundPlan.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { shipments: true, sellerAccount: { select: { displayName: true, sellerId: true } } } }), this.prisma.fbaInboundPlan.count({ where })]); return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId } }
  async fbaFees(req: RequestWithContext, query: FbaListQuery) { const context = await this.context(req); this.require(context, 'finance.read'); const where = { tenantId: context.tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { eventType: query.status } : {}), ...(query.q ? { OR: [{ asin: { contains: query.q, mode: 'insensitive' as const } }, { sellerSku: { contains: query.q, mode: 'insensitive' as const } }, { settlementId: { contains: query.q, mode: 'insensitive' as const } }] } : {}) }; const [items,total] = await this.prisma.$transaction([this.prisma.fbaFeeEvent.findMany({ where, orderBy: { postedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { sellerAccount: { select: { displayName: true, sellerId: true } } } }), this.prisma.fbaFeeEvent.count({ where })]); return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId } }
  async orderItems(req: RequestWithContext, orderId: string) {
    const context = await this.context(req)
    this.require(context, 'orders.read')
    const order = await this.prisma.order.findFirst({ where: { id: orderId, tenantId: context.tenantId } })
    if (!order) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Order not found')
    return this.prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { sellerSku: 'asc' } })
  }
  async fbaSettlements(req: RequestWithContext, query: FbaListQuery) {
    const context = await this.context(req)
    this.require(context, 'finance.read')
    const where = { tenantId: context.tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.q ? { externalSettlementId: { contains: query.q, mode: 'insensitive' as const } } : {}) }
    const [items, total] = await this.prisma.$transaction([this.prisma.fbaSettlement.findMany({ where, orderBy: { depositDate: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { sellerAccount: { select: { displayName: true, sellerId: true } }, transactions: { orderBy: { postedAt: 'desc' }, take: 10 } } }), this.prisma.fbaSettlement.count({ where })])
    return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId }
  }
  async adsMetrics(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context(req)
    this.require(context, 'seller.read')
    const page = Math.max(1, Number(query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)))
    const where = { tenantId: context.tenantId, ...(query.profileId ? { adsProfileId: query.profileId } : {}), ...(query.adProduct ? { adProduct: query.adProduct } : {}) }
    const [items, total] = await this.prisma.$transaction([this.prisma.adsMetric.findMany({ where, orderBy: [{ reportDate: 'desc' }, { impressions: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { adsProfile: { select: { displayName: true, profileId: true, currencyCode: true } } } }), this.prisma.adsMetric.count({ where })])
    return { items, total, page, pageSize }
  }
  async contactRequests(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context(req)
    this.require(context, 'connection.manage')
    const where = query.status ? { status: query.status } : {}
    return this.prisma.contactRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 })
  }
  async updateContactRequest(req: RequestWithContext, id: string, status: string) {
    const context = await this.context(req)
    this.require(context, 'connection.manage')
    const allowed = ['NEW', 'IN_PROGRESS', 'QUALIFIED', 'CLOSED', 'SPAM']
    if (!allowed.includes(status)) throw new AppError(400, 'INVALID_STATUS', 'Unsupported contact request status')
    return this.prisma.contactRequest.update({ where: { id }, data: { status } })
  }
  async suppliers(req: RequestWithContext) {
    const context = await this.context(req); this.require(context, 'seller.read')
    return this.prisma.supplier.findMany({ where: { tenantId: context.tenantId }, orderBy: { name: 'asc' }, include: { _count: { select: { purchaseOrders: true } } } })
  }
  async purchaseOrders(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context(req); this.require(context, 'seller.read')
    const where = { tenantId: context.tenantId, ...(query.status ? { status: query.status } : {}), ...(query.q ? { number: { contains: query.q, mode: 'insensitive' as const } } : {}) }
    return this.prisma.purchaseOrder.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { supplier: true, lines: true } })
  }
  async createPurchaseOrder(req: RequestWithContext, raw: Record<string, unknown>) {
    const context = await this.context(req); this.require(context, 'seller.write')
    const supplierId = String(raw.supplierId ?? '')
    const numberValue = String(raw.number ?? '')
    const lines = Array.isArray(raw.lines) ? raw.lines as Array<Record<string, unknown>> : []
    if (!supplierId || !numberValue || !lines.length) throw new AppError(400, 'PURCHASE_ORDER_INVALID', 'supplierId, number and lines are required')
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, tenantId: context.tenantId } })
    if (!supplier) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Supplier not found')
    return this.prisma.purchaseOrder.create({ data: { tenantId: context.tenantId, supplierId, number: numberValue, status: 'DRAFT', currency: String(raw.currency ?? supplier.currency), expectedDate: raw.expectedDate ? new Date(String(raw.expectedDate)) : undefined, notes: typeof raw.notes === 'string' ? raw.notes : undefined, lines: { create: lines.map(line => ({ sellerSku: String(line.sellerSku ?? ''), asin: typeof line.asin === 'string' ? line.asin : undefined, title: typeof line.title === 'string' ? line.title : undefined, quantity: Number(line.quantity ?? 0), unitCost: line.unitCost === undefined ? undefined : Number(line.unitCost), currency: String(line.currency ?? raw.currency ?? supplier.currency) })) } }, include: { supplier: true, lines: true } })
  }
  async warehouses(req: RequestWithContext) {
    const context = await this.context(req); this.require(context, 'seller.read')
    return this.prisma.warehouse.findMany({ where: { tenantId: context.tenantId }, orderBy: { code: 'asc' }, include: { _count: { select: { movements: true } } } })
  }
  async inventoryMovements(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context(req); this.require(context, 'seller.read')
    return this.prisma.inventoryMovement.findMany({ where: { tenantId: context.tenantId, ...(query.sellerSku ? { sellerSku: query.sellerSku } : {}), ...(query.type ? { movementType: query.type } : {}) }, orderBy: { occurredAt: 'desc' }, take: 200 })
  }
  async fbaReturns(req: RequestWithContext, query: FbaListQuery) { const context = await this.context(req); this.require(context, 'refunds.read'); const where = { tenantId: context.tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.q ? { OR: [{ amazonOrderId: { contains: query.q, mode: 'insensitive' as const } }, { asin: { contains: query.q, mode: 'insensitive' as const } }, { sellerSku: { contains: query.q, mode: 'insensitive' as const } }] } : {}) }; const [items,total] = await this.prisma.$transaction([this.prisma.fbaReturnCase.findMany({ where, orderBy: { returnDate: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { sellerAccount: { select: { displayName: true, sellerId: true } } } }), this.prisma.fbaReturnCase.count({ where })]); return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId } }
  async fbaReports(req: RequestWithContext, query: FbaListQuery) { const context = await this.context(req); this.require(context, 'seller.read'); const where = { tenantId: context.tenantId, ...(query.marketplaceId ? { marketplaceId: query.marketplaceId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.q ? { reportType: { contains: query.q, mode: 'insensitive' as const } } : {}) }; const [items,total] = await this.prisma.$transaction([this.prisma.fbaReportJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { sellerAccount: { select: { displayName: true, sellerId: true } } } }), this.prisma.fbaReportJob.count({ where })]); return { items, page: query.page, pageSize: query.pageSize, total, marketplaceId: query.marketplaceId } }
  async createFbaInboundPlan(req: RequestWithContext, input: FbaInboundPlanCreateInput) { const context = await this.context(req); this.require(context, 'seller.write'); const connection = await this.authorizedSpConnection(context.tenantId); const account = await this.prisma.sellerAccount.findFirst({ where: { id: connection.sellerAccountId ?? '', tenantId: context.tenantId } }); if (!account) throw new AppError(409, 'FBA_CONNECTION_REQUIRED', '创建 FBA 入库计划前，需要先完成卖家授权'); const totalUnits = input.items.reduce((sum, item) => sum + item.quantity, 0); const plan = await this.prisma.fbaInboundPlan.create({ data: { tenantId: context.tenantId, sellerAccountId: account.id, marketplaceId: input.marketplaceId, name: input.name, sourceAddress: JSON.stringify(input.sourceAddress), items: input.items, status: 'CREATE_PENDING', totalUnits, shipmentCount: 0 }, include: { shipments: true } }); const job = await this.prisma.syncJob.create({ data: { tenantId: context.tenantId, connectionId: connection.id, type: 'FBA_INBOUND_CREATE', status: 'PENDING', requestId: req.requestId, context: { fbaPlanId: plan.id, marketplaceId: input.marketplaceId } } }); await this.queue.add('sync', { syncJobId: job.id, requestId: req.requestId, fbaPlanId: plan.id, marketplaceId: input.marketplaceId }, job.id); return { plan, syncJob: job, next: 'Amazon Fulfillment Inbound API v2024-03-20 createInboundPlan' } }
  async createFbaReport(req: RequestWithContext, input: FbaReportCreateInput) { const context = await this.context(req); this.require(context, 'seller.write'); const connection = await this.authorizedSpConnection(context.tenantId); const account = await this.prisma.sellerAccount.findFirst({ where: { id: connection.sellerAccountId ?? '', tenantId: context.tenantId } }); if (!account) throw new AppError(409, 'FBA_CONNECTION_REQUIRED', '生成 FBA 报表前，需要先完成卖家授权'); const storedMarkets = Array.isArray(account.marketplaceIds) ? account.marketplaceIds.map(item => String(item)).filter(Boolean) : []; const markets = [...new Set(storedMarkets.length ? storedMarkets : [input.marketplaceId])]; let report: Awaited<ReturnType<PrismaService['fbaReportJob']['create']>> | null = null; let job: Awaited<ReturnType<PrismaService['syncJob']['create']>> | null = null; for (const marketplaceId of markets) { const created = await this.prisma.fbaReportJob.create({ data: { tenantId: context.tenantId, sellerAccountId: account.id, marketplaceId, reportType: input.reportType, fromDate: input.from ? new Date(input.from) : undefined, toDate: input.to ? new Date(input.to) : undefined, status: 'PENDING', requestId: req.requestId, createdById: context.userId } }); const syncJob = await this.prisma.syncJob.create({ data: { tenantId: context.tenantId, connectionId: connection.id, type: 'FBA_REPORT_CREATE', status: 'PENDING', requestId: req.requestId, context: { reportJobId: created.id, reportType: input.reportType, marketplaceId } } }); await this.queue.add('sync', { syncJobId: syncJob.id, requestId: req.requestId, reportJobId: created.id, reportType: input.reportType, marketplaceId }, syncJob.id); if (!report || !job) { report = created; job = syncJob } } return { report, syncJob: job, markets, next: 'Amazon Reports API createReport → getReport → getReportDocument' } }
  async createFbaSync(req: RequestWithContext, input: FbaSyncCreateInput) {
    const context = await this.context(req)
    this.require(context, 'sync.manage')
    if (input.type === 'RETURNS') return this.createFbaReport(req, { reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE', marketplaceId: input.marketplaceId })
    const provider = input.type === 'ADS' ? 'AMAZON_ADS_API' : 'AMAZON_SP_API'
    const workerType = input.type === 'ORDERS' ? 'FBA_ORDERS' : input.type === 'INVENTORY' ? 'FBA_INVENTORY' : input.type === 'FINANCES' ? 'FBA_FINANCE' : input.type === 'INBOUND' ? 'FBA_INBOUND_SYNC' : input.type === 'ADS' ? 'FBA_ADS' : null
    if (!workerType) throw new AppError(409, 'DATA_DOMAIN_NOT_IMPLEMENTED', 'This data domain requires a report job')
    const connection = await this.prisma.platformConnection.findFirst({ where: { id: input.connectionId, tenantId: context.tenantId, provider, state: 'AUTHORIZED' } }) ?? await this.prisma.platformConnection.findFirst({ where: { tenantId: context.tenantId, provider, state: 'AUTHORIZED' } })
    if (!connection) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Amazon connection is not authorized or not accessible')
    const job = await this.prisma.syncJob.create({ data: { tenantId: context.tenantId, connectionId: connection.id, type: workerType, status: 'PENDING', requestId: req.requestId } })
    await this.queue.add('sync', { syncJobId: job.id, requestId: req.requestId, marketplaceId: input.marketplaceId }, job.id)
    return { ...job, marketplaceId: input.marketplaceId, apiDomain: input.type === 'ADS' ? 'Amazon Ads API' : 'Amazon SP-API', dataDomain: input.type }
  }
  async createAdsSync(req: RequestWithContext) {
    const context = await this.context(req)
    this.require(context, 'sync.manage')
    const connection = await this.prisma.platformConnection.findFirst({ where: { tenantId: context.tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' } })
    if (!connection) throw new AppError(409, 'ADS_CONNECTION_REQUIRED', '请先完成 Amazon Ads 公有应用授权')
    const job = await this.prisma.syncJob.create({ data: { tenantId: context.tenantId, connectionId: connection.id, type: 'FBA_ADS', status: 'PENDING', requestId: req.requestId } })
    await this.queue.add('sync', { syncJobId: job.id, requestId: req.requestId }, job.id)
    return { ...job, dataDomain: 'ADS', apiDomain: 'Amazon Ads API' }
  }
  async createAdsReport(req: RequestWithContext, input: AdsReportCreateInput) {
    const context = await this.context(req)
    this.require(context, 'seller.write')
    const profile = await this.prisma.adsProfile.findFirst({ where: { id: input.profileId, tenantId: context.tenantId } })
    const connection = await this.prisma.platformConnection.findFirst({ where: { tenantId: context.tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' } })
    if (!profile || !connection) throw new AppError(409, 'ADS_CONNECTION_REQUIRED', '创建广告报表前，需要先完成 Amazon Ads 授权并同步 Profile')
    const report = await this.prisma.adsReportJob.create({ data: { tenantId: context.tenantId, adsProfileId: profile.id, reportType: input.reportType, adProduct: input.adProduct, fromDate: input.from ? new Date(input.from) : new Date(Date.now() - 30 * 86400000), toDate: input.to ? new Date(input.to) : new Date(), status: 'PENDING', requestId: req.requestId } })
    const job = await this.prisma.syncJob.create({ data: { tenantId: context.tenantId, connectionId: connection.id, type: 'ADS_REPORT_CREATE', status: 'PENDING', requestId: req.requestId, context: { reportJobId: report.id, reportType: input.reportType } } })
    await this.queue.add('sync', { syncJobId: job.id, requestId: req.requestId, reportJobId: report.id, reportType: input.reportType }, job.id)
    return { report, syncJob: job, next: 'Amazon Ads Reporting API createReport → getReport' }
  }
  async connections(req: RequestWithContext) { const context = await this.context(req); this.require(context, 'seller.read'); return this.prisma.platformConnection.findMany({ where: { tenantId: context.tenantId }, include: { sellerAccount: { select: { displayName: true, sellerId: true } }, healthChecks: { orderBy: { checkedAt: 'desc' }, take: 1 } }, orderBy: { updatedAt: 'desc' } }) }
  async syncJobs(req: RequestWithContext) { const context = await this.context(req); this.require(context, 'sync.manage'); return this.prisma.syncJob.findMany({ where: { tenantId: context.tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }) }
  async retrySync(req: RequestWithContext, id: string) {
    const context = await this.context(req)
    this.require(context, 'sync.manage')
    const job = await this.prisma.syncJob.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!job) throw new AppError(404, 'RESOURCE_NOT_FOUND', '同步任务不存在或无权访问')
    const saved = (job.context ?? {}) as { reportJobId?: string; reportType?: string; fbaPlanId?: string; marketplaceId?: string }
    let poll = false
    if (saved.reportJobId && job.type.startsWith('FBA_REPORT')) {
      const report = await this.prisma.fbaReportJob.findFirst({ where: { id: saved.reportJobId, tenantId: context.tenantId } })
      poll = Boolean(report?.externalReportId)
    }
    if (saved.reportJobId && job.type.startsWith('ADS_REPORT')) {
      const report = await this.prisma.adsReportJob.findFirst({ where: { id: saved.reportJobId, tenantId: context.tenantId } })
      poll = Boolean(report?.externalReportId)
    }
    const updated = await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'PENDING', failureCode: null, startedAt: null, finishedAt: null, progressCurrent: 0 } })
    await this.queue.add('sync', { syncJobId: updated.id, requestId: req.requestId, retry: true, reportJobId: saved.reportJobId, reportType: saved.reportType, fbaPlanId: saved.fbaPlanId, marketplaceId: saved.marketplaceId, poll }, `${updated.id}-retry-${Date.now()}`)
    return updated
  }
  async createSync(req: RequestWithContext, raw: unknown) {
    const context = await this.context(req)
    this.require(context, 'sync.manage')
    const input = SyncCreateSchema.parse(raw)
    const provider = input.type === 'ADS' ? 'AMAZON_ADS_API' : 'AMAZON_SP_API'
    const workerType = input.type === 'ORDERS' ? 'FBA_ORDERS' : input.type === 'INVENTORY' ? 'FBA_INVENTORY' : input.type === 'FINANCE' || input.type === 'FINANCES' ? 'FBA_FINANCE' : input.type === 'INBOUND' ? 'FBA_INBOUND_SYNC' : input.type === 'ADS' ? 'FBA_ADS' : null
    if (!workerType) throw new AppError(409, 'DATA_DOMAIN_NOT_IMPLEMENTED', 'This data domain requires a report job')
    const connection = await this.prisma.platformConnection.findFirst({ where: { id: input.connectionId, tenantId: context.tenantId, provider, state: 'AUTHORIZED' } }) ?? await this.prisma.platformConnection.findFirst({ where: { tenantId: context.tenantId, provider, state: 'AUTHORIZED' } })
    if (!connection) throw new AppError(404, 'RESOURCE_NOT_FOUND', '连接不存在、未授权或无权访问')
    const job = await this.prisma.syncJob.create({ data: { tenantId: context.tenantId, connectionId: connection.id, type: workerType, status: 'PENDING', requestId: req.requestId } })
    await this.queue.add('sync', { syncJobId: job.id, requestId: req.requestId }, job.id)
    return { ...job, dataDomain: input.type, apiDomain: provider === 'AMAZON_ADS_API' ? 'Amazon Ads API' : 'Amazon SP-API' }
  }
  async startOAuth(req: RequestWithContext, raw: unknown) {
    const context = await this.context(req)
    this.require(context, 'connection.manage')
    const input = OAuthStartSchema.parse(raw)
    const entity = await this.prisma.legalEntity.findFirst({ where: { id: input.legalEntityId, tenantId: context.tenantId } })
    if (!entity) throw new AppError(404, 'RESOURCE_NOT_FOUND', '法律主体不存在')
    const redirectUri = this.config.get<string>('AMAZON_SP_REDIRECT_URI')
    if (!redirectUri) throw new AppError(503, 'SP_API_REDIRECT_URI_MISSING', 'Amazon 公有应用回调地址尚未配置', false)
    if (input.returnUrl && input.returnUrl !== redirectUri) throw new AppError(400, 'OAUTH_REDIRECT_URI_NOT_ALLOWED', '回调地址必须使用服务端登记的固定地址')
    if (this.config.get('AMAZON_SP_API_APPROVED') !== 'true') throw new AppError(409, 'APPROVAL_PENDING', 'Amazon 公有 SP-API 应用尚未完成审批')
    const applicationId = this.config.get<string>('AMAZON_SP_APPLICATION_ID')
    const clientId = this.config.get<string>('AMAZON_SP_LWA_CLIENT_ID')
    const clientSecret = this.config.get<string>('AMAZON_SP_LWA_CLIENT_SECRET')
    if (!applicationId) throw new AppError(503, 'SP_API_APPLICATION_ID_MISSING', 'Amazon 公有应用 Application ID 尚未配置')
    if (!clientId || !clientSecret) throw new AppError(503, 'LWA_CONFIG_MISSING', 'Amazon LWA Client ID/Secret 尚未配置', false)
    const connection = await this.prisma.platformConnection.create({ data: { tenantId: context.tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZING', grantedScopes: [] } })
    const state = randomBytes(32).toString('base64url')
    await this.prisma.oAuthState.create({ data: { tenantId: context.tenantId, connectionId: connection.id, initiatedById: context.userId, legalEntityId: entity.id, stateHash: sha256(state), redirectUri, expiresAt: new Date(Date.now() + 600000) } })
    const draft = this.config.get('AMAZON_SP_APP_DRAFT') !== 'false'
    const authorizationUrl = new URL(this.config.get('AMAZON_SP_AUTH_URL') ?? 'https://sellercentral.amazon.com/apps/authorize/consent')
    authorizationUrl.searchParams.set('application_id', applicationId)
    authorizationUrl.searchParams.set('state', state)
    if (draft) authorizationUrl.searchParams.set('version', 'beta')
    return { connectionId: connection.id, state: connection.state, provider: 'AMAZON_SP_API', authorizationUrl: authorizationUrl.toString() }
  }
  async completeOAuth(raw: Record<string,string>) { const stateValue = raw.state; const code = raw.spapi_oauth_code; const sellerId = raw.selling_partner_id; if (raw.error) throw new AppError(400, 'OAUTH_CALLBACK_DENIED', raw.error_description ?? raw.error); if (!stateValue || !code || !sellerId) throw new AppError(400, 'OAUTH_CALLBACK_INVALID', 'Amazon 回调缺少 state、spapi_oauth_code 或 selling_partner_id'); const oauthState = await this.prisma.oAuthState.findFirst({ where: { stateHash: sha256(stateValue), consumedAt: null, expiresAt: { gt: new Date() } }, include: { connection: true, legalEntity: true } }); if (!oauthState) throw new AppError(400, 'OAUTH_STATE_INVALID', '授权状态不存在、已使用或已过期'); const clientId = this.config.get<string>('AMAZON_SP_LWA_CLIENT_ID'); const clientSecret = this.config.get<string>('AMAZON_SP_LWA_CLIENT_SECRET'); if (!clientId || !clientSecret) throw new AppError(503, 'LWA_CONFIG_MISSING', 'Amazon LWA Client ID/Secret 尚未配置', true); const tokenResponse = await fetch(this.config.get<string>('AMAZON_SP_LWA_TOKEN_URL') ?? 'https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: oauthState.redirectUri }).toString() }); const tokenBody = await tokenResponse.json().catch(() => ({})) as { refresh_token?: string; error_description?: string }; if (!tokenResponse.ok || !tokenBody.refresh_token) throw new AppError(502, 'LWA_TOKEN_EXCHANGE_FAILED', tokenBody.error_description ?? 'Amazon LWA token exchange failed', true); const legalEntity = oauthState.legalEntity ?? await this.prisma.legalEntity.findFirst({ where: { tenantId: oauthState.tenantId } }); if (!legalEntity) throw new AppError(409, 'LEGAL_ENTITY_REQUIRED', '授权连接需要先绑定法律主体'); const encryptedRefreshToken = encryptRefreshToken(tokenBody.refresh_token); const sellerAccount = await this.prisma.sellerAccount.upsert({ where: { tenantId_provider_sellerId_logicalRegion: { tenantId: oauthState.tenantId, provider: 'AMAZON_SP_API', sellerId, logicalRegion: 'NA' } }, create: { tenantId: oauthState.tenantId, legalEntityId: legalEntity.id, provider: 'AMAZON_SP_API', sellerId, logicalRegion: (process.env.AMAZON_SP_API_ENDPOINT ?? '').includes('-eu.') ? 'EU' : (process.env.AMAZON_SP_API_ENDPOINT ?? '').includes('-fe.') ? 'FE' : 'NA', displayName: `Amazon · ${sellerId}`, marketplaceIds: [] }, update: { tenantId: oauthState.tenantId, legalEntityId: legalEntity.id, displayName: `Amazon · ${sellerId}` } }); const connection = await this.prisma.platformConnection.update({ where: { id: oauthState.connectionId }, data: { state: 'AUTHORIZED', sellerAccountId: sellerAccount.id, externalAccountId: sellerId, encryptedRefreshToken, refreshTokenUpdatedAt: new Date(), lastHealthCheckedAt: new Date(), grantedScopes: ['public-seller', 'seller', 'fba', 'reports'] } }); await this.prisma.oAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } }); return { connectionId: connection.id, sellerAccountId: sellerAccount.id, state: connection.state, sellingPartnerId: sellerId, message: 'Amazon SP-API 授权完成，Refresh Token 已加密保存' } }
  async adsProfiles(req: RequestWithContext) {
    const context = await this.context(req)
    this.require(context, 'seller.read')
    return this.prisma.adsProfile.findMany({ where: { tenantId: context.tenantId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], include: { connections: { select: { id: true, provider: true, state: true, lastSuccessfulSyncAt: true, lastErrorCode: true } } } })
  }

  async adsCampaigns(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context(req)
    this.require(context, 'seller.read')
    const page = Math.max(1, Number(query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)))
    const where = { tenantId: context.tenantId, ...(query.profileId ? { adsProfileId: query.profileId } : {}), ...(query.state ? { state: query.state } : {}), ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}) }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.adsCampaign.findMany({ where, orderBy: { sourceUpdatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { adsProfile: { select: { profileId: true, displayName: true, marketplaceId: true } } } }),
      this.prisma.adsCampaign.count({ where }),
    ])
    return { items, total, page, pageSize }
  }

  async adsReports(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context(req)
    this.require(context, 'seller.read')
    const page = Math.max(1, Number(query.page ?? 1))
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)))
    const where = { tenantId: context.tenantId, ...(query.profileId ? { adsProfileId: query.profileId } : {}), ...(query.status ? { status: query.status } : {}) }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.adsReportJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { adsProfile: { select: { profileId: true, displayName: true } } } }),
      this.prisma.adsReportJob.count({ where }),
    ])
    return { items, total, page, pageSize }
  }

  async startAdsOAuth(req: RequestWithContext) {
    const context = await this.context(req)
    this.require(context, 'connection.manage')
    const redirectUri = this.config.get<string>('AMAZON_ADS_REDIRECT_URI')
    const clientId = this.config.get<string>('AMAZON_ADS_CLIENT_ID')
    if (!redirectUri) throw new AppError(503, 'ADS_REDIRECT_URI_MISSING', 'Amazon Ads 公有应用回调地址尚未配置')
    if (!clientId) throw new AppError(503, 'ADS_CLIENT_ID_MISSING', 'Amazon Ads Client ID 尚未配置')
    if (this.config.get('AMAZON_ADS_API_APPROVED') !== 'true') throw new AppError(409, 'ADS_APPROVAL_PENDING', 'Amazon Ads API 公有应用尚未完成审批')
    if (!this.config.get<string>('AMAZON_ADS_CLIENT_SECRET')) throw new AppError(503, 'ADS_LWA_CONFIG_MISSING', 'Amazon Ads Client ID/Secret 尚未配置')
    const connection = await this.prisma.platformConnection.create({ data: { tenantId: context.tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZING', grantedScopes: [] } })
    const state = randomBytes(32).toString('base64url')
    await this.prisma.oAuthState.create({ data: { tenantId: context.tenantId, connectionId: connection.id, initiatedById: context.userId, stateHash: sha256(state), redirectUri, expiresAt: new Date(Date.now() + 600000) } })
    const url = new URL('https://www.amazon.com/ap/oa')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('scope', 'advertising::campaign_management')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('state', state)
    return { connectionId: connection.id, state: connection.state, provider: 'AMAZON_ADS_API', authorizationUrl: url.toString() }
  }

  async completeAdsOAuth(raw: Record<string, string>) {
    if (raw.error) throw new AppError(400, 'ADS_OAUTH_DENIED', raw.error_description ?? raw.error)
    const stateValue = raw.state
    const code = raw.code
    if (!stateValue || !code) throw new AppError(400, 'ADS_OAUTH_CALLBACK_INVALID', 'Amazon Ads 回调缺少 state 或 code')
    const oauthState = await this.prisma.oAuthState.findFirst({ where: { stateHash: sha256(stateValue), consumedAt: null, expiresAt: { gt: new Date() } }, include: { connection: true } })
    if (!oauthState || oauthState.connection.provider !== 'AMAZON_ADS_API') throw new AppError(400, 'ADS_OAUTH_STATE_INVALID', 'Amazon Ads 授权状态不存在、已使用或已过期')
    const clientId = this.config.get<string>('AMAZON_ADS_CLIENT_ID')
    const clientSecret = this.config.get<string>('AMAZON_ADS_CLIENT_SECRET')
    if (!clientId || !clientSecret) throw new AppError(503, 'ADS_LWA_CONFIG_MISSING', 'Amazon Ads Client ID/Secret 尚未配置')
    const response = await fetch(this.config.get<string>('AMAZON_ADS_LWA_TOKEN_URL') ?? 'https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret, redirect_uri: oauthState.redirectUri }).toString() })
    const payload = await response.json().catch(() => ({})) as { refresh_token?: string; error_description?: string }
    if (!response.ok || !payload.refresh_token) throw new AppError(502, 'ADS_LWA_TOKEN_EXCHANGE_FAILED', payload.error_description ?? 'Amazon Ads LWA token exchange failed', true)
    const connection = await this.prisma.platformConnection.update({ where: { id: oauthState.connectionId }, data: { state: 'AUTHORIZED', encryptedRefreshToken: encryptRefreshToken(payload.refresh_token), refreshTokenUpdatedAt: new Date(), lastHealthCheckedAt: new Date(), grantedScopes: ['advertising::campaign_management'] } })
    await this.prisma.oAuthState.update({ where: { id: oauthState.id }, data: { consumedAt: new Date() } })
    return { connectionId: connection.id, provider: 'AMAZON_ADS_API', state: connection.state, message: 'Amazon Ads API 授权完成，Refresh Token 已加密保存；下一步同步 Ads Profile' }
  }
}
