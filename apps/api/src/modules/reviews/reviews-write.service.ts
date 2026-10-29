import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { REVIEWS_ACTIONS, REVIEWS_LIMITS, REVIEWS_SOLICIT, SOLICITATION_SWITCH_KEY, SolicitationBatchBodySchema, solicitationWindowOf, type SolicitationBatchResult } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService, AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService } from '../auth'
import { DAY_MS } from './reviews-common'
import { PURCHASE_LOOKBACK_DAYS } from './reviews-delivery'
import { ReviewsJobService } from './reviews-jobs.service'

type Skipped = SolicitationBatchResult['skipped'][number]
interface Candidate {
  amazonOrderId: string
  asins: string[]
  /** 上次发送失败，这次是重新受理。 */
  retry: boolean
}

/**
 * 批量请求评价（05 章 5.7）。顺序：权限 → 参数 → 店铺在范围内 → 动作守卫（连接、写入开关）→ 逐单校验 → 事务内建后台任务与请求记录（QUEUED）与审计 → 提交后登记写流程并入队。
 * 每个订单只有一行请求记录（数据库唯一约束）：已有记录且没有失败的订单一律跳过，失败的可以重新受理；并发时输给别人的订单按“已请求”跳过。真正发给亚马逊的是后台任务，它发送前还会再查一次开关与是否允许请求。
 */
@Injectable()
export class ReviewsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly audit: AuditWriter,
    private readonly jobs: ReviewsJobService,
  ) {}

  /** 逐单校验：订单属于这个店铺、没有取消、全部包裹已送达、在可请求期内、没有有效的请求记录。 */
  private async check(tenantId: string, storeId: string, orderIds: readonly string[], now: Date): Promise<{ candidates: Candidate[]; skipped: Skipped[] }> {
    const lower = new Date(now.getTime() - (REVIEWS_LIMITS.windowEndDay + 1 + PURCHASE_LOOKBACK_DAYS) * DAY_MS)
    // 只读订单号、下单日期与状态，不读买家信息
    const orders = await this.prisma.order.findMany({
      where: { tenantId, sellerAccountId: storeId, amazonOrderId: { in: [...orderIds] }, purchaseDate: { gte: lower } },
      select: { id: true, amazonOrderId: true, purchaseDate: true, status: true, fulfillmentStatus: true },
      orderBy: [{ purchaseDate: 'desc' }],
      take: orderIds.length * 3,
    })
    const orderOf = new Map<string, (typeof orders)[number]>()
    for (const order of orders) if (!orderOf.has(order.amazonOrderId)) orderOf.set(order.amazonOrderId, order)
    const internalIds = [...orderOf.values()].map(order => order.id)
    const [packages, items, existing] = await Promise.all([
      this.prisma.orderPackage.groupBy({
        by: ['orderId'],
        where: { tenantId, sellerAccountId: storeId, orderId: { in: internalIds } },
        _count: { _all: true, deliveredAt: true },
        _max: { deliveredAt: true },
        orderBy: { orderId: 'asc' },
        take: orderIds.length + 1,
      }),
      this.prisma.orderItem.findMany({
        where: { tenantId, sellerAccountId: storeId, orderId: { in: internalIds }, asin: { not: null } },
        select: { orderId: true, asin: true },
        take: 19_999,
      }),
      this.prisma.solicitationRequest.findMany({
        where: { tenantId, sellerAccountId: storeId, amazonOrderId: { in: [...orderIds] } },
        select: { amazonOrderId: true, status: true },
        take: orderIds.length + 1,
      }),
    ])
    const packageOf = new Map(packages.map(group => [group.orderId, group]))
    const asinsOf = new Map<string, Set<string>>()
    for (const item of items) asinsOf.set(item.orderId, (asinsOf.get(item.orderId) ?? new Set()).add(item.asin as string))
    const statusOf = new Map(existing.map(row => [row.amazonOrderId, row.status]))
    const candidates: Candidate[] = []
    const skipped: Skipped[] = []
    for (const amazonOrderId of orderIds) {
      const order = orderOf.get(amazonOrderId)
      const group = order ? packageOf.get(order.id) : undefined
      const skip = (reason: Skipped['reason']) => skipped.push({ amazonOrderId, reason })
      if (!order) skip('NOT_FOUND')
      else if (order.status === 'Canceled' || order.fulfillmentStatus === 'CANCELLED' || !group || group._count._all !== group._count.deliveredAt || !group._max.deliveredAt) skip('NOT_DELIVERED')
      else if (solicitationWindowOf(group._max.deliveredAt, now).state !== 'OPEN') skip('OUT_OF_WINDOW')
      else if (statusOf.has(amazonOrderId) && statusOf.get(amazonOrderId) !== 'FAILED') skip('ALREADY_REQUESTED')
      else candidates.push({ amazonOrderId, asins: [...(asinsOf.get(order.id) ?? [])].sort(), retry: statusOf.get(amazonOrderId) === 'FAILED' })
    }
    return { candidates, skipped }
  }

  async request(req: RequestWithContext, rawBody: unknown, now = new Date()): Promise<SolicitationBatchResult> {
    const { context, scope } = await this.context.authorizeScoped(req, REVIEWS_SOLICIT, {})
    const body = SolicitationBatchBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    const tenantId = context.tenantId
    const store = await this.prisma.sellerAccount.findFirst({ where: { id: body.storeId, tenantId }, select: { id: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    // 动作守卫：权限 → 连接 → 写入开关；服务端执行前再判断一次，页面状态不作为依据
    await this.guard.assert(context, { permission: REVIEWS_SOLICIT, connection: { provider: 'AMAZON_SP_API', sellerAccountId: store.id }, switchKey: SOLICITATION_SWITCH_KEY })
    const connection = await this.jobs.connectionOf(tenantId, store.id)
    const { candidates, skipped } = await this.check(tenantId, store.id, body.orderIds, now)
    if (candidates.length === 0) return { accepted: 0, skipped, batchId: null, jobId: null }

    const batchId = randomUUID()
    const result = await this.prisma.$transaction(async tx => {
      const claimed = new Set<string>()
      const own = { tenantId, sellerAccountId: store.id }
      const fresh = candidates.filter(candidate => !candidate.retry)
      // 失败过的订单：只有仍是 FAILED 才改回受理中（别人先改了就是输了）
      for (const candidate of candidates.filter(item => item.retry)) {
        const updated = await tx.solicitationRequest.updateMany({
          where: { ...own, amazonOrderId: candidate.amazonOrderId, status: 'FAILED' },
          data: { status: 'QUEUED', batchId, asins: candidate.asins, requestedBy: context.userId, requestedAt: now, sentAt: null, failureCode: null, writeRunId: null },
        })
        if (updated.count === 1) claimed.add(candidate.amazonOrderId)
      }
      // 新订单：唯一键冲突（被并发请求抢先）静默跳过，再按批次编号读回真正写入的
      if (fresh.length > 0) {
        await tx.solicitationRequest.createMany({
          data: fresh.map(candidate => ({ ...own, amazonOrderId: candidate.amazonOrderId, asins: candidate.asins, status: 'QUEUED', batchId, requestedBy: context.userId, requestedAt: now })),
          skipDuplicates: true,
        })
        const created = await tx.solicitationRequest.findMany({
          where: { ...own, batchId, amazonOrderId: { in: fresh.map(candidate => candidate.amazonOrderId) } },
          select: { amazonOrderId: true },
          take: fresh.length,
        })
        for (const row of created) claimed.add(row.amazonOrderId)
      }
      if (claimed.size === 0) return { claimed, job: null }
      const job = await this.jobs.createJob(tx, { id: batchId, tenantId, connectionId: connection.id, requestId: req.requestId, context: { solicitationBatchId: batchId } })
      await this.audit.record(
        req,
        {
          action: REVIEWS_ACTIONS.solicitationsRequested,
          resourceType: 'SolicitationRequest',
          resourceId: batchId,
          after: { storeId: store.id, batchId, orders: claimed.size, skipped: skipped.length + candidates.length - claimed.size },
        },
        { client: tx },
      )
      return { claimed, job }
    })
    const lost: Skipped[] = candidates.filter(candidate => !result.claimed.has(candidate.amazonOrderId)).map(candidate => ({ amazonOrderId: candidate.amazonOrderId, reason: 'ALREADY_REQUESTED' }))
    const allSkipped = [...skipped, ...lost]
    if (!result.job) return { accepted: 0, skipped: allSkipped, batchId: null, jobId: null }
    await this.jobs.dispatchSend(req, result.job, { tenantId, connectionId: connection.id, solicitationBatchId: batchId })
    return { accepted: result.claimed.size, skipped: allSkipped, batchId, jobId: result.job.id }
  }
}
