import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { FbaSyncCreateSchema, SyncCreateSchema, appendSyncEvent, syncRetryBlockReason } from '@nova/api-contracts'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'
import type { DeadLetterEntry } from '@nova/workflow'
import { ContextService, ResolvedScope, assertStoreInScope, assertUnrestricted, connectionWhere } from '../auth'
import { ConnectionsService } from '../connections'
import { ReportsService } from '../reports'
import { apiDomainLabel, providerOf, workerTypeOf } from './sync.domains'

/** 返回给前端的死信视图：不含任务载荷（内部编号）；错误详情已在写入时去敏。 */
function deadLetterView(entry: DeadLetterEntry) {
  return {
    id: entry.id,
    queue: entry.queue,
    jobName: entry.jobName,
    errorCode: entry.errorCode,
    errorDetail: entry.errorDetail,
    attempts: entry.attempts,
    syncJobId: entry.syncJobId,
    createdAt: entry.createdAt,
    replayedAt: entry.replayedAt,
    replayedBy: entry.replayedBy,
  }
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly context: ContextService,
    private readonly connections: ConnectionsService,
    private readonly reports: ReportsService,
    private readonly workflow: WorkflowService,
  ) {}

  // 死信：重试用尽或不可重试的任务（P1-20）。受限成员只看得到自己店铺范围内的同步任务；不带同步任务的（报表、导出、通知）需要“全部店铺”范围。
  async deadLetters(req: RequestWithContext, query: Record<string, string>) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.read', {})
    const entries = await this.workflow.listDeadLetters(context.tenantId, { queue: query.queue || undefined, includeReplayed: query.includeReplayed === 'true', limit: 100 })
    const jobIds = entries.map(entry => entry.syncJobId).filter((value): value is string => !!value)
    const visible = scope.unrestricted
      ? null
      : new Set((await this.prisma.syncJob.findMany({ where: { tenantId: context.tenantId, id: { in: jobIds }, connection: connectionWhere(scope) }, select: { id: true } })).map(job => job.id))
    return entries.filter(entry => visible === null || (entry.syncJobId !== null && visible.has(entry.syncJobId))).map(deadLetterView)
  }

  // 重放：同步任务沿用“重试”流程（保证断点、锁与去重一致）；其他队列按原载荷原样入队。同一条死信只能重放一次。
  async replayDeadLetter(req: RequestWithContext, id: string) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.manage', {})
    const entry = await this.workflow.getDeadLetter(context.tenantId, id)
    if (!entry) throw new AppError(404, 'RESOURCE_NOT_FOUND', '失败任务不存在或无权访问')
    if (entry.syncJobId) {
      const job = await this.prisma.syncJob.findFirst({ where: { id: entry.syncJobId, tenantId: context.tenantId, connection: connectionWhere(scope) }, select: { id: true } })
      if (!job) throw new AppError(404, 'RESOURCE_NOT_FOUND', '失败任务不存在或无权访问')
    } else {
      assertUnrestricted(scope)
    }
    const replayed = await this.workflow.replayDeadLetter(context.tenantId, id, context.userId, async target => {
      if (entry.syncJobId) await this.retry(req, entry.syncJobId)
      else await this.queue.addRaw(target.queue, target.jobName, target.payload as Record<string, unknown>, target.jobId)
    })
    if (!replayed) throw new AppError(409, 'DEAD_LETTER_ALREADY_REPLAYED', '这条失败任务已经被重放过，不能重复重放')
    return deadLetterView(replayed)
  }

  // 连接归属某店铺时要求该店铺在范围内；广告等账户级连接只允许“全部店铺”范围的成员操作。
  private assertConnectionInScope(scope: ResolvedScope, connection: { sellerAccountId: string | null }) {
    if (connection.sellerAccountId) assertStoreInScope(scope, connection.sellerAccountId)
    else assertUnrestricted(scope)
  }

  async retry(req: RequestWithContext, id: string) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.manage', {})
    const job = await this.prisma.syncJob.findFirst({ where: { id, tenantId: context.tenantId, connection: connectionWhere(scope) } })
    if (!job) throw new AppError(404, 'RESOURCE_NOT_FOUND', '同步任务不存在或无权访问')
    // 只有失败的任务能重试：排队、运行、等待中的任务重试会造成重复执行；已作废的任务（连接已断开、报告已取消）重试没有意义
    const blocked = syncRetryBlockReason(job)
    if (blocked) throw new AppError(409, 'SYNC_JOB_NOT_RETRYABLE', blocked)

    const saved = (job.context ?? {}) as { reportJobId?: string; reportType?: string; fbaPlanId?: string; marketplaceId?: string; window?: { after: string; before: string } }
    // 已拿到亚马逊侧报告编号的任务，重试时只轮询，不重复创建报告
    let poll = false
    if (saved.reportJobId && job.type.startsWith('FBA_REPORT')) {
      const report = await this.prisma.fbaReportJob.findFirst({ where: { id: saved.reportJobId, tenantId: context.tenantId } })
      poll = Boolean(report?.externalReportId)
    }
    if (saved.reportJobId && job.type.startsWith('ADS_REPORT')) {
      const report = await this.prisma.adsReportJob.findFirst({ where: { id: saved.reportJobId, tenantId: context.tenantId } })
      poll = Boolean(report?.externalReportId)
    }
    const updated = await this.prisma.syncJob.update({
      where: { id: job.id },
      // 尝试次数清零：人工重试重新计 5 次机会，同步中心据此把重试后的任务显示为“排队中”；时间线记一条“已人工重试”
      data: {
        status: 'PENDING',
        failureCode: null,
        startedAt: null,
        finishedAt: null,
        progressCurrent: 0,
        deadLettered: false,
        attempts: 0,
        timelineJson: appendSyncEvent(job.timelineJson, 'RETRY_REQUESTED') as unknown as Prisma.InputJsonValue,
      },
    })
    await this.queue.add(
      'sync',
      {
        tenantId: context.tenantId,
        syncJobId: updated.id,
        requestId: req.requestId,
        retry: true,
        reportJobId: saved.reportJobId,
        reportType: saved.reportType,
        fbaPlanId: saved.fbaPlanId,
        marketplaceId: saved.marketplaceId,
        window: saved.window,
        poll,
      },
      `${updated.id}-retry-${Date.now()}`,
      { type: job.type, priority: job.priority },
    )
    return updated
  }

  // 同步中心发起的同步任务（POST sync/jobs）。
  async create(req: RequestWithContext, raw: unknown) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.manage', {})
    const input = SyncCreateSchema.parse(raw)
    const provider = providerOf(input.type)
    const workerType = workerTypeOf(input.type)
    if (!workerType) throw new AppError(409, 'DATA_DOMAIN_NOT_IMPLEMENTED', 'This data domain requires a report job')
    const connection = await this.connections.findAuthorized(context.tenantId, provider, input.connectionId)
    if (!connection) throw new AppError(404, 'RESOURCE_NOT_FOUND', '连接不存在、未授权或无权访问')
    this.assertConnectionInScope(scope, connection)
    const job = await this.enqueue(context.tenantId, connection.id, workerType, req.requestId)
    return { ...job, dataDomain: input.type, apiDomain: apiDomainLabel(provider) }
  }

  // 商品目录页按店铺入队。退货类型转成报告任务。旧的 POST /fba/sync/jobs 已在 P5-12 删除。
  async createFba(req: RequestWithContext, rawInput: unknown) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.manage', {})
    const input = FbaSyncCreateSchema.parse(rawInput)
    if (input.type === 'RETURNS') {
      return this.reports.createReturns(req, input.marketplaceId)
    }
    const provider = providerOf(input.type)
    const workerType = workerTypeOf(input.type)
    if (!workerType) throw new AppError(409, 'DATA_DOMAIN_NOT_IMPLEMENTED', 'This data domain requires a report job')
    const connection = await this.connections.findAuthorized(context.tenantId, provider, input.connectionId)
    if (!connection) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Amazon connection is not authorized or not accessible')
    this.assertConnectionInScope(scope, connection)
    const job = await this.enqueue(context.tenantId, connection.id, workerType, req.requestId, { marketplaceId: input.marketplaceId })
    return { ...job, marketplaceId: input.marketplaceId, apiDomain: apiDomainLabel(provider), dataDomain: input.type }
  }

  async createAds(req: RequestWithContext) {
    const { context, scope } = await this.context.authorizeScoped(req, 'sync.manage', {})
    const connection = await this.connections.authorizedAdsConnection(context.tenantId)
    if (!connection) throw new AppError(409, 'ADS_CONNECTION_REQUIRED', '请先完成 Amazon Ads 公有应用授权')
    this.assertConnectionInScope(scope, connection)
    const job = await this.enqueue(context.tenantId, connection.id, 'FBA_ADS', req.requestId)
    return { ...job, dataDomain: 'ADS', apiDomain: 'Amazon Ads API' }
  }

  // 去重：同一店铺授权、同一任务类型（与站点）已有排队或运行中的任务时，直接返回它，不再重复创建与入队。
  private async enqueue(tenantId: string, connectionId: string, type: string, requestId: string, extra: Record<string, unknown> = {}) {
    const meta = syncJobMeta(connectionId, type, [typeof extra.marketplaceId === 'string' ? extra.marketplaceId : undefined])
    const active = await this.prisma.syncJob.findFirst({ where: { tenantId, sourceKey: meta.sourceKey, status: { in: ['PENDING', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } })
    if (active) return active
    const job = await this.prisma.syncJob.create({ data: { tenantId, connectionId, type, status: 'PENDING', requestId, ...meta } })
    await this.queue.add('sync', { tenantId, syncJobId: job.id, requestId, ...extra }, job.id, { type, priority: meta.priority })
    return job
  }
}
