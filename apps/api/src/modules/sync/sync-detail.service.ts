import { Injectable } from '@nestjs/common'
import {
  SYNC_READ,
  SYNC_TIMELINE_LABEL,
  reportCatalogOf,
  syncDataDomainOf,
  syncEventText,
  syncEventsOf,
  syncResultItemsOf,
  syncPriorityLabel,
  type SyncDeadLetterView,
  type SyncDetailParam,
  type SyncJobDetailResponse,
  type SyncLinkedReport,
  type SyncTimelineItem,
  type SyncWorkflowView,
  SYNC_DOMAIN_LABEL,
  isWriteSyncType,
  spReportOf,
  syncJobTypeLabel,
} from '@nova/api-contracts'
import { syncDomainOf, syncQueueName } from '@nova/workflow'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { connectionWhere, ContextService } from '../auth'
import { SYNC_ROW_SELECT, syncRowOf, type SyncRowRecord } from './sync-row'

const TONE: Record<string, SyncTimelineItem['tone']> = { SUCCEEDED: 'success', FAILED: 'error', CANCELLED: 'error', RETRY_WAIT: 'warning', POLL_WAIT: 'warning' }
const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

/** 参数：只列有白名单中文名的上下文字段（站点、报告类型、数据集、时间窗口），不原样输出整份上下文。 */
function paramsOf(job: SyncRowRecord, storeName: string | null): SyncDetailParam[] {
  const context = (job.context && typeof job.context === 'object' && !Array.isArray(job.context) ? job.context : {}) as Record<string, unknown>
  const params: SyncDetailParam[] = [
    { label: '任务类型', value: syncJobTypeLabel(job.type) },
    { label: '数据域', value: SYNC_DOMAIN_LABEL[syncDataDomainOf(job.type, job.context)] },
    { label: '店铺', value: storeName ?? '账户级连接（不归属某个店铺）' },
    { label: '优先级', value: syncPriorityLabel(job.priority) },
  ]
  if (text(context.marketplaceId)) params.push({ label: '站点', value: String(context.marketplaceId) })
  const reportType = text(context.reportType)
  if (reportType) params.push({ label: '报告类型', value: spReportOf(reportType)?.label ?? reportType })
  const dataset = text(context.dataset)
  if (dataset) params.push({ label: '数据集', value: reportCatalogOf('DATA_KIOSK', dataset)?.label ?? dataset })
  const window = context.window as { after?: unknown; before?: unknown } | undefined
  if (window && text(window.after) && text(window.before)) params.push({ label: '时间窗口', value: `${String(window.after).slice(0, 10)} 至 ${String(window.before).slice(0, 10)}` })
  return params
}

// 同步任务详情（09 章 9.8；freeze/api.md GET /sync/jobs/:id）：参数、过程时间线、流程分步、写入统计、失败详情、关联报告任务。
@Injectable()
export class SyncDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<SyncJobDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SYNC_READ, {})
    const tenantId = context.tenantId
    const job = await this.prisma.syncJob.findFirst({
      where: { id, tenantId, connection: connectionWhere(scope) },
      select: { ...SYNC_ROW_SELECT, sourceKey: true, checkpointJson: true, resultJson: true, connectionId: true },
    })
    if (!job) throw new AppError(404, 'RESOURCE_NOT_FOUND', '同步任务不存在或无权访问')

    const [connection, workflows, deadLetter, reports] = await Promise.all([
      this.prisma.platformConnection.findFirst({ where: { id: job.connectionId, tenantId }, select: { id: true, provider: true, state: true, lastErrorCode: true } }),
      this.workflows(tenantId, job.id),
      this.deadLetter(tenantId, job.id),
      this.linkedReports(tenantId, job),
    ])
    const row = syncRowOf(job)
    const stats = syncResultItemsOf(job.resultJson)
    const events = syncEventsOf(job.timelineJson)
    const notes: string[] = []
    if (events.length === 0) notes.push('该任务没有过程记录：创建于功能上线之前，或还没有开始执行。')
    if (row.state === 'SUCCEEDED' && stats.length === 0) notes.push('该任务完成时没有记录写入统计：创建于功能上线之前，或同步器没有返回数字统计。')
    if (isWriteSyncType(job.type)) notes.push('这是向亚马逊写入的任务：重试会重新提交一次写入，提交前请确认亚马逊侧的当前状态。')
    return {
      job: row,
      params: paramsOf(job, row.storeName),
      connection,
      queue: syncQueueName(syncDomainOf(job.type)),
      sourceKey: job.sourceKey,
      hasCheckpoint: job.checkpointJson !== null,
      timeline: events.map(event => ({ at: event.at, label: SYNC_TIMELINE_LABEL[event.stage], text: syncEventText(event.stage, event.text), tone: TONE[event.stage] ?? 'default' })),
      workflows,
      stats: stats.length > 0 ? stats : null,
      deadLetter,
      reports,
      notes,
    }
  }

  private async workflows(tenantId: string, syncJobId: string): Promise<SyncWorkflowView[]> {
    const runs = await this.prisma.workflowRun.findMany({
      where: { tenantId, syncJobId },
      select: {
        kind: true,
        status: true,
        errorCode: true,
        startedAt: true,
        finishedAt: true,
        steps: { select: { seq: true, name: true, status: true, attempt: true, errorCode: true, startedAt: true, finishedAt: true }, orderBy: { seq: 'asc' }, take: 50 },
      },
      orderBy: { startedAt: 'asc' },
      take: 10,
    })
    return runs.map(run => ({
      kind: run.kind,
      status: run.status,
      errorCode: run.errorCode,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      steps: run.steps.map(step => ({ ...step, startedAt: step.startedAt?.toISOString() ?? null, finishedAt: step.finishedAt?.toISOString() ?? null })),
    }))
  }

  private async deadLetter(tenantId: string, syncJobId: string): Promise<SyncDeadLetterView | null> {
    const entry = await this.prisma.deadLetterJob.findFirst({
      where: { tenantId, syncJobId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, queue: true, attempts: true, errorCode: true, createdAt: true, replayedAt: true },
    })
    return entry ? { ...entry, createdAt: entry.createdAt.toISOString(), replayedAt: entry.replayedAt?.toISOString() ?? null } : null
  }

  /** 关联的报告任务：报告申请与轮询任务指向亚马逊报告任务或广告报告任务；数据中心查询的任务本身就是报表中心里的一行。 */
  private async linkedReports(tenantId: string, job: SyncRowRecord): Promise<SyncLinkedReport[]> {
    const context = (job.context && typeof job.context === 'object' && !Array.isArray(job.context) ? job.context : {}) as Record<string, unknown>
    const reportJobId = text(context.reportJobId)
    if (job.type === 'DATA_KIOSK_QUERY') {
      const dataset = text(context.dataset)
      return [{ id: job.id, kind: 'DATA_KIOSK', label: (dataset && reportCatalogOf('DATA_KIOSK', dataset)?.label) || '数据中心查询', status: job.status, path: `/app/reports/${job.id}` }]
    }
    if (!reportJobId) return []
    if (job.type.startsWith('FBA_REPORT')) {
      const report = await this.prisma.fbaReportJob.findFirst({ where: { id: reportJobId, tenantId }, select: { id: true, reportType: true, status: true } })
      return report ? [{ id: report.id, kind: 'SP_API', label: spReportOf(report.reportType)?.label ?? report.reportType, status: report.status, path: `/app/reports/${report.id}` }] : []
    }
    if (job.type.startsWith('ADS_REPORT')) {
      const report = await this.prisma.adsReportJob.findFirst({ where: { id: reportJobId, tenantId }, select: { id: true, reportType: true, status: true } })
      return report ? [{ id: report.id, kind: 'ADS', label: reportCatalogOf('ADS', report.reportType)?.label ?? report.reportType, status: report.status, path: `/app/reports/${report.id}` }] : []
    }
    return []
  }
}
