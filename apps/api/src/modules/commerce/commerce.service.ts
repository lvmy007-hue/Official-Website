import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Prisma } from '@prisma/client'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { CommerceOrderActivateSchema, CommerceRefundReviewSchema, CommercialPlanUpdateSchema, type CommerceOrderCreateInput, type CommerceRefundCreateInput } from '@nova/api-contracts'
import { AlipayService } from './alipay.service'
import { AppError, RequestWithContext } from '../../platform/http'
import { SystemPrismaService } from '../../platform/prisma.service'
import { parsePageParams } from '../../platform/query'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { createTenantWithDefaults } from '../lifecycle'

const money = (value: Prisma.Decimal | number | string) => new Prisma.Decimal(value).toDecimalPlaces(2)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const orderNumber = () => `NOVA${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(5).toString('hex').toUpperCase()}`
const refundNumber = () => `NR${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(5).toString('hex').toUpperCase()}`

@Injectable()
export class CommerceService {
  constructor(
    private readonly prisma: SystemPrismaService,
    private readonly config: ConfigService,
    private readonly access: ContextService,
    private readonly alipay: AlipayService,
    private readonly audit: AuditWriter,
  ) {}

  async publicPlans() {
    const plans = await this.prisma.commercialPlan.findMany({ where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } })
    return plans.map(plan => this.presentPlan(plan))
  }

  paymentConfiguration() {
    return this.alipay.configurationState()
  }

  async createOrder(input: CommerceOrderCreateInput, requestId: string) {
    if (input.companyWebsite) return { accepted: true, reference: 'ORDER-RECEIVED' }
    const plan = await this.prisma.commercialPlan.findUnique({ where: { code: input.planCode } })
    if (!plan || plan.status !== 'ACTIVE') throw new AppError(404, 'PLAN_NOT_FOUND', '所选套餐不存在或已停止销售')
    if (!plan.onlinePurchase) throw new AppError(409, 'PLAN_REQUIRES_QUOTE', '企业定制版需要先确认服务范围并生成专属订单')
    if (plan.taxRate === null) throw new AppError(409, 'TAX_RATE_NOT_CONFIGURED', '不含税价格尚未配置适用税率，暂不能创建正式付款订单')
    const subtotal = money(plan.basePrice)
    const taxRate = new Prisma.Decimal(plan.taxRate)
    const taxAmount = subtotal.mul(taxRate).toDecimalPlaces(2)
    const totalAmount = subtotal.add(taxAmount).toDecimalPlaces(2)
    const accessToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const snapshot = this.planSnapshot(plan)
    const order = await this.prisma.commerceOrder.create({
      data: {
        orderNo: orderNumber(),
        planId: plan.id,
        companyName: input.companyName,
        creditCode: input.creditCode,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email.toLowerCase(),
        invoiceTitle: input.invoiceTitle,
        taxpayerId: input.taxpayerId,
        invoiceEmail: input.invoiceEmail.toLowerCase(),
        subtotal,
        taxRate,
        taxAmount,
        totalAmount,
        currency: plan.currency,
        priceSnapshot: snapshot,
        accessTokenHash: sha256(accessToken),
        expiresAt,
        auditLogs: { create: { action: 'ORDER_CREATED', toStatus: 'PENDING_PAYMENT', requestId, detail: { planCode: plan.code, totalAmount: totalAmount.toFixed(2) } } },
      },
      include: { plan: true },
    })
    return { order: this.presentOrder(order), accessToken }
  }

  async publicOrder(orderNo: string, accessToken: string) {
    const order = await this.authorizedOrder(orderNo, accessToken)
    if (order.status === 'PENDING_PAYMENT' && order.expiresAt <= new Date()) {
      const expired = await this.prisma.commerceOrder.update({ where: { id: order.id }, data: { status: 'EXPIRED' }, include: this.orderIncludes() })
      return this.presentOrder(expired)
    }
    return this.presentOrder(order)
  }

  async startPayment(orderNo: string, accessToken: string, requestId: string) {
    const order = await this.authorizedOrder(orderNo, accessToken)
    if (order.status === 'EXPIRED' || order.expiresAt <= new Date()) {
      if (order.status !== 'EXPIRED') await this.prisma.commerceOrder.update({ where: { id: order.id }, data: { status: 'EXPIRED' } })
      throw new AppError(409, 'ORDER_EXPIRED', '订单已经过期，请重新下单')
    }
    if (order.status !== 'PENDING_PAYMENT') throw new AppError(409, 'ORDER_NOT_PAYABLE', '当前订单状态不能再次发起支付')
    const idempotencyKey = `ALIPAY:${order.id}`
    const payment = await this.prisma.paymentRecord.upsert({
      where: { idempotencyKey },
      create: { orderId: order.id, idempotencyKey, subject: `${order.plan.name} · ${order.companyName}`.slice(0, 120), amount: order.totalAmount, currency: order.currency, status: 'CREATED' },
      update: {},
    })
    const paymentUrl = this.alipay.createPagePayUrl({ orderNo: order.orderNo, amount: money(order.totalAmount).toFixed(2), subject: payment.subject })
    await this.prisma.$transaction([
      this.prisma.paymentRecord.update({ where: { id: payment.id }, data: { status: 'PENDING', checkoutPayload: { gateway: 'ALIPAY_PAGE_PAY', createdAt: new Date().toISOString() } } }),
      this.prisma.commerceAuditLog.create({
        data: { orderId: order.id, action: 'PAYMENT_STARTED', fromStatus: order.status, toStatus: order.status, requestId, detail: { provider: 'ALIPAY', paymentId: payment.id } },
      }),
    ])
    return { orderNo: order.orderNo, provider: 'ALIPAY', paymentUrl, expiresAt: order.expiresAt }
  }

  async handleAlipayNotify(raw: Record<string, unknown>, requestId: string) {
    const payload = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')]))
    const orderNo = payload.out_trade_no
    if (!orderNo) return false
    const order = await this.prisma.commerceOrder.findUnique({ where: { orderNo }, include: { plan: true, payments: true } })
    if (!order) return false
    const payloadHash = sha256(
      Object.entries(payload)
        .filter(([key]) => key !== 'sign')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('&'),
    )
    const signatureValid = this.alipay.verifyNotification(payload)
    const safePayload = this.safePaymentPayload(payload)
    const existing = await this.prisma.paymentEvent.findUnique({ where: { provider_payloadHash: { provider: 'ALIPAY', payloadHash } } })
    if (existing?.processedAt) return existing.signatureValid
    const payment =
      order.payments[0] ??
      (await this.prisma.paymentRecord.create({
        data: {
          orderId: order.id,
          idempotencyKey: `ALIPAY:${order.id}`,
          subject: `${order.plan.name} · ${order.companyName}`.slice(0, 120),
          amount: order.totalAmount,
          currency: order.currency,
          status: 'PENDING',
        },
      }))
    const event =
      existing ??
      (await this.prisma.paymentEvent.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          provider: 'ALIPAY',
          eventType: payload.trade_status || 'UNKNOWN',
          providerEventId: payload.notify_id || undefined,
          signatureValid,
          payloadHash,
          payload: safePayload,
        },
      }))
    if (!signatureValid) {
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { failureCode: 'INVALID_SIGNATURE' } })
      return false
    }
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(payload.trade_status)) {
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } })
      return true
    }
    if (money(payload.total_amount || '0').toFixed(2) !== money(order.totalAmount).toFixed(2)) {
      await this.prisma.paymentEvent.update({ where: { id: event.id }, data: { failureCode: 'AMOUNT_MISMATCH' } })
      return false
    }
    const paidAt = payload.gmt_payment ? new Date(payload.gmt_payment.replace(' ', 'T') + '+08:00') : new Date()
    await this.prisma.$transaction(async tx => {
      const current = await tx.commerceOrder.findUniqueOrThrow({ where: { id: order.id } })
      await tx.paymentRecord.update({ where: { id: payment.id }, data: { status: 'PAID', providerTradeNo: payload.trade_no || undefined, paidAt, notifyVerifiedAt: new Date() } })
      if (!['PAID_PENDING_ACTIVATION', 'ACTIVE', 'REFUND_PENDING', 'REFUNDED'].includes(current.status)) {
        await tx.commerceOrder.update({ where: { id: order.id }, data: { status: 'PAID_PENDING_ACTIVATION', paidAt } })
        await tx.invoiceRequest.upsert({
          where: { orderId: order.id },
          create: { orderId: order.id, title: order.invoiceTitle, taxpayerId: order.taxpayerId, email: order.invoiceEmail, amount: order.totalAmount },
          update: {},
        })
        await tx.commerceAuditLog.create({
          data: {
            orderId: order.id,
            action: 'PAYMENT_CONFIRMED',
            fromStatus: current.status,
            toStatus: 'PAID_PENDING_ACTIVATION',
            requestId,
            detail: { provider: 'ALIPAY', tradeNo: payload.trade_no },
          },
        })
      }
      await tx.paymentEvent.update({ where: { id: event.id }, data: { paymentId: payment.id, signatureValid: true, processedAt: new Date(), failureCode: null } })
    })
    return true
  }

  async requestRefund(orderNo: string, accessToken: string, input: CommerceRefundCreateInput, requestId: string) {
    const order = await this.authorizedOrder(orderNo, accessToken)
    if (!['PAID_PENDING_ACTIVATION', 'ACTIVE'].includes(order.status)) throw new AppError(409, 'ORDER_NOT_REFUNDABLE', '当前订单状态不能申请退款')
    if (order.status === 'ACTIVE' && order.activatedAt) {
      const deadline = new Date(order.activatedAt.getTime() + 7 * 86400000)
      if (new Date() > deadline) throw new AppError(409, 'REFUND_WINDOW_EXPIRED', '开通后7个自然日退款申请期已结束')
    }
    const existing = order.refunds.find(item => ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(item.status))
    if (existing) throw new AppError(409, 'REFUND_ALREADY_OPEN', '该订单已有正在处理的退款申请')
    const payment = order.payments.find(item => item.status === 'PAID' || item.status === 'PARTIALLY_REFUNDED')
    if (!payment) throw new AppError(409, 'PAID_PAYMENT_NOT_FOUND', '没有找到可退款的已支付流水')
    const refund = await this.prisma.refundRequest.create({
      data: { refundNo: refundNumber(), orderId: order.id, paymentId: payment.id, requestedAmount: order.totalAmount, currency: order.currency, reason: input.reason },
    })
    await this.prisma.$transaction([
      this.prisma.commerceOrder.update({ where: { id: order.id }, data: { status: 'REFUND_PENDING' } }),
      this.prisma.commerceAuditLog.create({
        data: {
          orderId: order.id,
          action: 'REFUND_REQUESTED',
          fromStatus: order.status,
          toStatus: 'REFUND_PENDING',
          requestId,
          detail: { refundNo: refund.refundNo, requestedAmount: refund.requestedAmount.toFixed(2) },
        },
      }),
    ])
    return { refundNo: refund.refundNo, status: refund.status, requestedAmount: refund.requestedAmount.toFixed(2) }
  }

  async adminPlans(req: RequestWithContext) {
    await this.platformAdmin(req, 'billing.manage')
    const plans = await this.prisma.commercialPlan.findMany({ orderBy: { sortOrder: 'asc' } })
    return plans.map(plan => this.presentPlan(plan))
  }

  async updatePlan(req: RequestWithContext, id: string, rawInput: unknown) {
    await this.platformAdmin(req, 'billing.manage')
    const input = CommercialPlanUpdateSchema.parse(rawInput)
    const before = await this.prisma.commercialPlan.findUnique({ where: { id } })
    if (!before) throw new AppError(404, 'PLAN_NOT_FOUND', '套餐不存在')
    const updated = await this.prisma.commercialPlan.update({ where: { id }, data: { ...input, features: input.features as Prisma.InputJsonValue | undefined } })
    await this.audit.record(req, {
      action: 'COMMERCIAL_PLAN_UPDATED',
      resourceType: 'CommercialPlan',
      resourceId: id,
      before: this.presentPlan(before),
      after: this.presentPlan(updated),
      detail: { code: updated.code },
    })
    return this.presentPlan(updated)
  }

  async adminOrders(req: RequestWithContext, query: Record<string, string>) {
    await this.platformAdmin(req, 'billing.read')
    const { page, pageSize, skip, take } = parsePageParams(query)
    const where: Prisma.CommerceOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? { OR: [{ orderNo: { contains: query.q, mode: 'insensitive' } }, { companyName: { contains: query.q, mode: 'insensitive' } }, { email: { contains: query.q, mode: 'insensitive' } }] }
        : {}),
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.commerceOrder.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: this.orderIncludes() }),
      this.prisma.commerceOrder.count({ where }),
    ])
    return { items: items.map(order => this.presentOrder(order)), total, page, pageSize }
  }

  async activateOrder(req: RequestWithContext, id: string, rawInput: unknown) {
    const context = await this.platformAdmin(req, 'billing.manage')
    const input = CommerceOrderActivateSchema.parse(rawInput)
    const order = await this.prisma.commerceOrder.findUnique({ where: { id }, include: { plan: true, refunds: true } })
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', '商业订单不存在')
    if (order.status !== 'PAID_PENDING_ACTIVATION') throw new AppError(409, 'ORDER_NOT_ACTIVATABLE', '只有已支付待开通订单可以开通')
    if (order.refunds.some(item => ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(item.status))) throw new AppError(409, 'REFUND_IN_PROGRESS', '退款申请处理中，不能开通服务')
    const startsAt = new Date()
    const endsAt = new Date(startsAt)
    endsAt.setUTCMonth(endsAt.getUTCMonth() + order.plan.billingPeriodMonths)
    const tenantSlug = input.tenantSlug ?? `customer-${order.orderNo.toLowerCase()}`
    const activated = await this.prisma.$transaction(async tx => {
      const tenant = input.tenantId ? await tx.tenant.findUnique({ where: { id: input.tenantId } }) : await createTenantWithDefaults(tx, { name: order.companyName, slug: tenantSlug })
      if (!tenant) throw new AppError(404, 'TENANT_NOT_FOUND', '指定企业工作区不存在')
      const entitlementSnapshot = this.planSnapshot(order.plan)
      await tx.subscription.create({ data: { tenantId: tenant.id, orderId: order.id, planId: order.planId, startsAt, endsAt, entitlementSnapshot } })
      const saved = await tx.commerceOrder.update({
        where: { id: order.id },
        data: { tenantId: tenant.id, status: 'ACTIVE', reviewedAt: new Date(), reviewedById: context.userId, activatedAt: startsAt, serviceStartAt: startsAt, serviceEndAt: endsAt },
      })
      await tx.commerceAuditLog.create({
        data: {
          orderId: order.id,
          actorId: context.userId,
          action: 'SERVICE_ACTIVATED',
          fromStatus: order.status,
          toStatus: 'ACTIVE',
          requestId: req.requestId,
          detail: { tenantId: tenant.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
        },
      })
      return { order: saved, tenant, startsAt, endsAt }
    })
    return activated
  }

  async adminRefunds(req: RequestWithContext, query: Record<string, string>) {
    await this.platformAdmin(req, 'billing.read')
    const items = await this.prisma.refundRequest.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { order: { include: { plan: true } }, payment: true },
    })
    return items.map(item => ({ ...item, requestedAmount: item.requestedAmount.toFixed(2), approvedAmount: item.approvedAmount?.toFixed(2), order: this.presentOrder(item.order) }))
  }

  async reviewRefund(req: RequestWithContext, id: string, rawInput: unknown) {
    const context = await this.platformAdmin(req, 'billing.manage')
    const input = CommerceRefundReviewSchema.parse(rawInput)
    const refund = await this.prisma.refundRequest.findUnique({ where: { id }, include: { order: true, payment: true } })
    if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', '退款申请不存在')
    if (refund.status !== 'REQUESTED') throw new AppError(409, 'REFUND_ALREADY_REVIEWED', '退款申请已处理')
    if (!input.approved) {
      await this.prisma.$transaction([
        this.prisma.refundRequest.update({ where: { id }, data: { status: 'REJECTED', reviewedAt: new Date(), reviewedById: context.userId, failureCode: input.note || 'REJECTED_BY_ADMIN' } }),
        this.prisma.commerceOrder.update({ where: { id: refund.orderId }, data: { status: refund.order.activatedAt ? 'ACTIVE' : 'PAID_PENDING_ACTIVATION' } }),
        this.prisma.commerceAuditLog.create({
          data: {
            orderId: refund.orderId,
            actorId: context.userId,
            action: 'REFUND_REJECTED',
            fromStatus: 'REFUND_PENDING',
            toStatus: refund.order.activatedAt ? 'ACTIVE' : 'PAID_PENDING_ACTIVATION',
            requestId: req.requestId,
            detail: { note: input.note },
          },
        }),
      ])
      return { status: 'REJECTED' }
    }
    if (!refund.payment) throw new AppError(409, 'PAYMENT_NOT_FOUND', '退款申请没有关联支付流水')
    const amount = money(input.approvedAmount ?? refund.requestedAmount)
    const maximum = money(refund.order.totalAmount).sub(refund.payment.refundedAmount)
    if (amount.lte(0) || amount.gt(maximum)) throw new AppError(422, 'INVALID_REFUND_AMOUNT', '批准退款金额超过可退款余额')
    await this.prisma.refundRequest.update({ where: { id }, data: { status: 'PROCESSING', approvedAmount: amount, reviewedAt: new Date(), reviewedById: context.userId } })
    try {
      const result = await this.alipay.refund({ orderNo: refund.order.orderNo, refundNo: refund.refundNo, amount: amount.toFixed(2), reason: input.note || refund.reason })
      const refundedTotal = money(refund.payment.refundedAmount).add(amount)
      const full = refundedTotal.gte(refund.order.totalAmount)
      await this.prisma.$transaction([
        this.prisma.refundRequest.update({ where: { id }, data: { status: 'COMPLETED', providerRefundNo: refund.refundNo, completedAt: new Date(), failureCode: null } }),
        this.prisma.paymentRecord.update({ where: { id: refund.payment.id }, data: { refundedAmount: refundedTotal, status: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } }),
        this.prisma.commerceOrder.update({ where: { id: refund.orderId }, data: { status: full ? 'REFUNDED' : refund.order.activatedAt ? 'ACTIVE' : 'PAID_PENDING_ACTIVATION' } }),
        this.prisma.subscription.updateMany({ where: { orderId: refund.orderId, ...(full ? {} : { id: '__never__' }) }, data: { status: 'CANCELED', endsAt: new Date() } }),
        this.prisma.commerceAuditLog.create({
          data: {
            orderId: refund.orderId,
            actorId: context.userId,
            action: 'REFUND_COMPLETED',
            fromStatus: 'REFUND_PENDING',
            toStatus: full ? 'REFUNDED' : refund.order.activatedAt ? 'ACTIVE' : 'PAID_PENDING_ACTIVATION',
            requestId: req.requestId,
            detail: { amount: amount.toFixed(2), providerTradeNo: result.tradeNo },
          },
        }),
      ])
      return { status: 'COMPLETED', amount: amount.toFixed(2) }
    } catch (error) {
      await this.prisma.refundRequest.update({ where: { id }, data: { status: 'FAILED', failureCode: error instanceof Error ? error.message.slice(0, 240) : 'ALIPAY_REFUND_FAILED' } })
      throw error
    }
  }

  private async authorizedOrder(orderNo: string, accessToken: string) {
    if (!accessToken) throw new AppError(401, 'ORDER_ACCESS_TOKEN_REQUIRED', '缺少订单访问凭据')
    const order = await this.prisma.commerceOrder.findUnique({ where: { orderNo }, include: this.orderIncludes() })
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', '订单不存在')
    const actual = Buffer.from(sha256(accessToken), 'hex')
    const expected = Buffer.from(order.accessTokenHash, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AppError(403, 'ORDER_ACCESS_DENIED', '订单访问凭据无效')
    return order
  }

  private async platformAdmin(req: RequestWithContext, permission: string) {
    const context = await this.access.authorize(req, permission)
    const operatorTenantId = this.config.get<string>('PLATFORM_OPERATOR_TENANT_ID')?.trim()
    if (process.env.APP_MODE === 'production' && !operatorTenantId) throw new AppError(503, 'PLATFORM_OPERATOR_TENANT_NOT_CONFIGURED', '生产环境尚未配置平台运营租户')
    if (operatorTenantId && context.tenantId !== operatorTenantId) throw new AppError(403, 'PLATFORM_ADMIN_REQUIRED', '当前企业不是官网商业运营主体')
    return context
  }

  private orderIncludes() {
    return { plan: true, payments: { orderBy: { createdAt: 'desc' as const } }, refunds: { orderBy: { createdAt: 'desc' as const } }, invoiceRequest: true, subscriptions: true }
  }
  private planSnapshot(plan: {
    code: string
    name: string
    basePrice: Prisma.Decimal
    currency: string
    billingPeriodMonths: number
    taxIncluded: boolean
    taxRate: Prisma.Decimal | null
    legalEntityLimit: number | null
    storeLimit: number | null
    memberLimit: number | null
    features: Prisma.JsonValue
  }) {
    return {
      code: plan.code,
      name: plan.name,
      basePrice: plan.basePrice.toFixed(2),
      currency: plan.currency,
      billingPeriodMonths: plan.billingPeriodMonths,
      taxIncluded: plan.taxIncluded,
      taxRate: plan.taxRate?.toString() ?? null,
      legalEntityLimit: plan.legalEntityLimit,
      storeLimit: plan.storeLimit,
      memberLimit: plan.memberLimit,
      features: plan.features,
    } as Prisma.InputJsonValue
  }
  private presentPlan(plan: {
    id: string
    code: string
    name: string
    tagline: string
    description: string
    basePrice: Prisma.Decimal
    currency: string
    billingPeriodMonths: number
    taxIncluded: boolean
    taxRate: Prisma.Decimal | null
    legalEntityLimit: number | null
    storeLimit: number | null
    memberLimit: number | null
    onlinePurchase: boolean
    featured: boolean
    features: Prisma.JsonValue
    sortOrder: number
    status: string
  }) {
    return { ...plan, basePrice: plan.basePrice.toFixed(2), taxRate: plan.taxRate?.toString() ?? null, paymentReady: plan.onlinePurchase && plan.taxRate !== null && this.alipay.configured() }
  }
  private presentOrder(order: any) {
    const { accessTokenHash: _secret, subtotal, taxRate, taxAmount, totalAmount, payments = [], refunds = [], ...rest } = order
    return {
      ...rest,
      subtotal: money(subtotal).toFixed(2),
      taxRate: taxRate?.toString() ?? null,
      taxAmount: money(taxAmount).toFixed(2),
      totalAmount: money(totalAmount).toFixed(2),
      payments: payments.map((item: any) => ({ ...item, amount: money(item.amount).toFixed(2), refundedAmount: money(item.refundedAmount).toFixed(2), checkoutPayload: undefined })),
      refunds: refunds.map((item: any) => ({ ...item, requestedAmount: money(item.requestedAmount).toFixed(2), approvedAmount: item.approvedAmount ? money(item.approvedAmount).toFixed(2) : null })),
    }
  }
  private safePaymentPayload(payload: Record<string, string>) {
    const keys = ['app_id', 'seller_id', 'trade_no', 'out_trade_no', 'trade_status', 'total_amount', 'receipt_amount', 'buyer_pay_amount', 'gmt_payment', 'notify_id', 'notify_time', 'sign_type']
    return Object.fromEntries(keys.filter(key => payload[key]).map(key => [key, payload[key]])) as Prisma.InputJsonValue
  }
}
