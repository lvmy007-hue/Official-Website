import { Injectable } from '@nestjs/common'
import {
  REPORT_ACTIONS,
  REPORT_DOWNLOAD_TTL_SECONDS,
  REPORT_READ,
  REPORT_WRITE,
  ReportCenterCreateBodySchema,
  RETURNS_REPORT_TYPE,
  appendReportEvent,
  spReportOf,
  type ReportCreateResponse,
  type ReportDownloadResponse,
  type ReportRow,
} from '@nova/api-contracts'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import type { Prisma } from '@prisma/client'
import { AppError, appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { ObjectStorageService } from '../../platform/storage/object-storage.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { AuditWriter } from '../../platform/write'
import { WorkflowService } from '../../platform/workflow'
import { assertStoreInScope, ContextService, storeWhere } from '../auth'
import { ConnectionsService } from '../connections'
import { todayIn, validZone } from '../overview'
import { dayText, FBA_SELECT, reportStatusOf, spRowsOf, type FbaRecord } from './reports-common'
import { recentWindow, validateReportPeriod } from './reports-period'

const ACTIVE = ['PENDING', 'GENERATING']
const RETURNS_WINDOW_DAYS = 30

type Scoped = Awaited<ReturnType<ContextService['authorizeScoped']>>
interface Submission {
  reportType: string
  marketplaceId: string
  from?: string | null
  to?: string | null
  attempt: number
  retryOfId: string | null
}

// 报告任务的写操作（09 章 9.3；freeze/api.md POST /reports、/reports/:id/cancel、/reports/:id/retry、GET /reports/:id/download）。
// 取消只在本系统生效（不向亚马逊发取消请求）：任务置为已取消，后台任务下次看到就不再轮询、下载；重试新建任务（attempt + 1，retryOfId 指回原任务），每个任务只能重试一次。
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly context: ContextService,
    private readonly connections: ConnectionsService,
    private readonly workflow: WorkflowService,
    private readonly objects: ObjectStorageService,
    private readonly audit: AuditWriter,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown): Promise<ReportCreateResponse> {
    // 权限先于参数校验
    const scoped = await this.context.authorizeScoped(req, REPORT_WRITE, {})
    const input = ReportCenterCreateBodySchema.parse(rawBody)
    return this.submit(req, scoped, { reportType: input.reportType, marketplaceId: input.marketplaceId, from: input.from, to: input.to, attempt: 1, retryOfId: null })
  }

  /** 运营页的“同步退货数据”：申请最近 30 天（到昨天为止）的客户退货报告。 */
  async createReturns(req: RequestWithContext, marketplaceId: string): Promise<ReportCreateResponse> {
    const scoped = await this.context.authorizeScoped(req, REPORT_WRITE, {})
    const window = recentWindow(await this.todayOf(scoped.context.tenantId), RETURNS_WINDOW_DAYS)
    return this.submit(req, scoped, { reportType: RETURNS_REPORT_TYPE, marketplaceId, ...window, attempt: 1, retryOfId: null })
  }

  async cancel(req: RequestWithContext, id: string, now: Date = new Date()): Promise<ReportRow> {
    const scoped = await this.context.authorizeScoped(req, REPORT_WRITE, {})
    const tenantId = scoped.context.tenantId
    const [row] = await spRowsOf(this.prisma, tenantId, [await this.mine(scoped, id)], now)
    if (!row) throw appError('REPORT_NOT_FOUND', '报告任务不存在或不在当前数据范围内')
    if (!row.canCancel) throw appError('REPORT_NOT_CANCELABLE', row.status === 'PENDING' || row.status === 'GENERATING' ? '已经开始下载并解析，不能取消' : '只有排队中或生成中的报告任务可以取消')
    const changed = await this.prisma.fbaReportJob.updateMany({
      where: { id, tenantId, status: { in: ACTIVE } },
      data: { status: 'CANCELLED', failureCode: 'REPORT_CANCELLED', failureMessage: null, finishedAt: now },
    })
    if (changed.count === 0) throw appError('REPORT_NOT_CANCELABLE', '任务刚刚已经结束，不能取消')
    const [after] = await spRowsOf(this.prisma, tenantId, [await this.mine(scoped, id)], now)
    return after ?? row
  }

  async retry(req: RequestWithContext, id: string, now: Date = new Date()): Promise<ReportCreateResponse> {
    const scoped = await this.context.authorizeScoped(req, REPORT_WRITE, {})
    const tenantId = scoped.context.tenantId
    const job = await this.mine(scoped, id)
    const status = reportStatusOf(job.status)
    if ((status !== 'FAILED' && status !== 'CANCELLED') || spReportOf(job.reportType)?.mode !== 'CREATE')
      throw appError('REPORT_NOT_RETRYABLE', '只有失败或已取消、并且可以由用户申请的报告任务可以重试')
    if (await this.prisma.fbaReportJob.findFirst({ where: { tenantId, retryOfId: id }, select: { id: true } })) throw appError('REPORT_ALREADY_RETRIED', '这个任务已经重试过了，请查看重试出来的新任务')
    const created = await this.submit(req, scoped, {
      reportType: job.reportType,
      marketplaceId: job.marketplaceId,
      from: dayText(job.fromDate),
      to: dayText(job.toDate),
      attempt: job.attempt + 1,
      retryOfId: job.id,
    })
    await this.prisma.fbaReportJob.update({
      where: { id: job.id },
      data: { timelineJson: appendReportEvent(job.timelineJson, 'RETRIED', `重试任务 ${created.report.id}`, now) as unknown as Prisma.InputJsonValue },
    })
    return created
  }

  /** 原始文件的短时签名链接；只有文件还在保留期内才发，发放写审计。 */
  async download(req: RequestWithContext, id: string, now: Date = new Date()): Promise<ReportDownloadResponse> {
    const scoped = await this.context.authorizeScoped(req, REPORT_READ, {})
    const tenantId = scoped.context.tenantId
    const job = await this.mine(scoped, id)
    const file = await this.prisma.rawReportFile.findFirst({ where: { tenantId, sourceKey: `report:${job.id}` }, select: { objectKey: true, retentionUntil: true, sizeBytes: true } })
    if (!file) throw appError('REPORT_FILE_UNAVAILABLE', '这个任务没有留存原始文件（没有完成，或文件内容与已留存的一份相同）')
    if (file.retentionUntil && file.retentionUntil <= now) throw appError('REPORT_FILE_UNAVAILABLE', '原始文件已过保留期，已被清理')
    const signed = await this.objects.forTenant(tenantId).signDownload(file.objectKey, REPORT_DOWNLOAD_TTL_SECONDS)
    await this.audit.record(req, { action: REPORT_ACTIONS.downloadIssued, resourceType: 'FbaReportJob', resourceId: job.id, detail: { reportType: job.reportType, sizeBytes: Number(file.sizeBytes) } })
    return { url: signed.url, expiresAt: new Date(signed.expiresAt).toISOString() }
  }

  // ---- 内部 ----

  private async todayOf(tenantId: string, now: Date = new Date()): Promise<string> {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    return todayIn(validZone(tenant?.timezone), now)
  }

  /** 范围内的亚马逊报告任务；不存在、范围外、别的企业都是 404。 */
  private async mine(scoped: Scoped, id: string): Promise<FbaRecord> {
    const job = await this.prisma.fbaReportJob.findFirst({ where: { id, tenantId: scoped.context.tenantId, ...storeWhere(scoped.scope) }, select: FBA_SELECT })
    if (!job) throw appError('REPORT_NOT_FOUND', '报告任务不存在或不在当前数据范围内')
    return job
  }

  /** 建任务记录与同步任务、登记写流程、入队。创建与重试共用。 */
  private async submit(req: RequestWithContext, scoped: Scoped, spec: Submission): Promise<ReportCreateResponse> {
    const { context, scope } = scoped
    const tenantId = context.tenantId
    const entry = spReportOf(spec.reportType)
    if (!entry || entry.mode !== 'CREATE') throw appError('VALIDATION_FAILED', '不是报表中心可以创建的报告类型', { fieldErrors: { reportType: ['不是报表中心可以创建的报告类型'] } })
    const period = validateReportPeriod(entry.period, spec.from, spec.to, await this.todayOf(tenantId))
    const connection = await this.connections.authorizedSpConnection(tenantId)
    const account = await this.connections.sellerAccountOf(tenantId, connection)
    if (!account) throw new AppError(409, 'FBA_CONNECTION_REQUIRED', '创建报告任务前，需要先完成卖家授权')
    assertStoreInScope(scope, account.id)
    const fromDate = period.from ? new Date(`${period.from}T00:00:00Z`) : null
    const toDate = period.to ? new Date(`${period.to}T00:00:00Z`) : null
    const running = await this.prisma.fbaReportJob.findFirst({
      where: { tenantId, sellerAccountId: account.id, marketplaceId: spec.marketplaceId, reportType: spec.reportType, status: { in: ACTIVE }, fromDate, toDate },
      select: { id: true },
    })
    if (running) throw appError('REPORT_ALREADY_RUNNING', '同一店铺、同一报告类型、同一周期已有没完成的任务，请等它结束，或先取消它')

    const created = await this.prisma.fbaReportJob.create({
      data: {
        tenantId,
        sellerAccountId: account.id,
        marketplaceId: spec.marketplaceId,
        reportType: spec.reportType,
        fromDate,
        toDate,
        status: 'PENDING',
        requestId: req.requestId,
        createdById: context.userId,
        attempt: spec.attempt,
        retryOfId: spec.retryOfId,
      },
      select: { id: true },
    })
    const payload = { reportJobId: created.id, reportType: spec.reportType, marketplaceId: spec.marketplaceId }
    const syncJob = await this.prisma.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: 'FBA_REPORT_CREATE',
        status: 'PENDING',
        requestId: req.requestId,
        context: payload,
        ...syncJobMeta(connection.id, 'FBA_REPORT_CREATE', [created.id]),
      },
    })
    await this.prisma.fbaReportJob.update({ where: { id: created.id }, data: { syncJobId: syncJob.id } })
    // 登记写操作流程并把流程编号写入本次请求；后台任务用同一个去重键续上它
    await this.workflow.registerWriteRun(req, {
      tenantId,
      kind: WORKFLOW_KINDS.REPORT_CREATE,
      dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.REPORT_CREATE, created.id, syncJob.id),
      intent: { tenantId, connectionId: connection.id, ...payload } satisfies WriteRunIntent,
      syncJobId: syncJob.id,
      priority: syncJob.priority,
    })
    try {
      await this.queue.add('sync', { tenantId, syncJobId: syncJob.id, requestId: req.requestId, ...payload }, syncJob.id, { type: 'FBA_REPORT_CREATE', priority: syncJob.priority })
    } catch {
      const now = new Date()
      await this.prisma.fbaReportJob.updateMany({ where: { id: created.id, tenantId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      await this.prisma.syncJob.updateMany({ where: { id: syncJob.id, tenantId }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      throw appError('DEPENDENCY_UNAVAILABLE', '任务队列暂时不可用，没有排上队，请稍后重试')
    }
    const row = await this.prisma.fbaReportJob.findFirstOrThrow({ where: { id: created.id, tenantId }, select: FBA_SELECT })
    const [report] = await spRowsOf(this.prisma, tenantId, [row], new Date())
    return { report: report!, syncJobId: syncJob.id }
  }
}
