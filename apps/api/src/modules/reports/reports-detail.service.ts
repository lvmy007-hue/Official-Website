import { Injectable } from '@nestjs/common'
import {
  REPORT_AMAZON_STAGES,
  REPORT_READ,
  REPORT_TIMELINE_LABEL,
  reportEventsOf,
  type ReportDetailResponse,
  type ReportImportStats,
  type ReportRow,
  type ReportSyncJobView,
  type ReportTimelineItem,
  type ReportTimelineStage,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { adsRelationWhere, connectionWhere, ContextService, storeWhere } from '../auth'
import {
  ADS_SELECT,
  adsRowOf,
  FBA_SELECT,
  KIOSK_SELECT,
  kioskDatasetOf,
  kioskParamsOf,
  kioskRowOf,
  kioskStoreNames,
  spRowsOf,
  warningsOf,
  type AdsRecord,
  type FbaRecord,
  type KioskRecord,
} from './reports-common'

const KIOSK_TYPE = 'DATA_KIOSK_QUERY'
const NOTE_COUNTS = '导入器只统计写入的行数，不区分新增与更新，所以“新增”“更新”写“未区分”；报告整份导入，一个批次写库失败会让整份失败，不存在“部分行失败”。'
const NOTE_WARNINGS = '解析警告只对比与上一份同类报告的字段名（新出现、消失的字段）；没有检测未识别的枚举值。'

const itemOf = (at: Date, stage: ReportTimelineStage, text?: string): ReportTimelineItem => ({
  at: at.toISOString(),
  stage,
  label: REPORT_TIMELINE_LABEL[stage],
  side: REPORT_AMAZON_STAGES.includes(stage) ? 'AMAZON' : 'LOCAL',
  ...(text ? { text } : {}),
})
const byTime = (items: ReportTimelineItem[]) => items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

/** 结束事件：由状态与时间列补出（失败与取消路径不需要先读后写）。 */
function endItem(row: ReportRow, finishedAt: Date | null, updatedAt: Date): ReportTimelineItem[] {
  const at = finishedAt ?? updatedAt
  if (row.status === 'READY') return [itemOf(at, 'IMPORTED', row.importedRows === null ? undefined : `导入 ${row.importedRows} 行`)]
  if (row.status === 'FAILED') return [itemOf(at, 'FAILED', row.failureText ?? undefined)]
  if (row.status === 'CANCELLED') return [itemOf(at, 'CANCELLED')]
  return []
}

function statsOf(status: string, read: number | null, imported: number | null, skipped: number | null): ReportImportStats {
  const ignored = read !== null && imported !== null && skipped !== null && read - imported - skipped >= 0 ? read - imported - skipped : null
  return { read, imported, skipped, ignored, added: null, updated: null, failed: status === 'READY' ? 0 : null }
}

const syncViewOf = (job: { id: string; type: string; status: string; attempts: number; failureCode: string | null; startedAt: Date | null; finishedAt: Date | null }): ReportSyncJobView => ({
  id: job.id,
  type: job.type,
  status: job.status,
  attempts: job.attempts,
  failureCode: job.failureCode,
  startedAt: job.startedAt?.toISOString() ?? null,
  finishedAt: job.finishedAt?.toISOString() ?? null,
})
const SYNC_SELECT = { id: true, type: true, status: true, attempts: true, failureCode: true, startedAt: true, finishedAt: true } as const

// 报告任务详情（09 章 9.3；freeze/api.md GET /reports/:id）：请求参数、状态时间线、导入统计、解析警告、关联的同步任务。
// 三个来源各有适配：亚马逊报告最完整；广告报告与数据中心查询没有逐阶段的亚马逊侧时间线，页面据 notes 说明。
@Injectable()
export class ReportsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string, now: Date = new Date()): Promise<ReportDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, REPORT_READ, {})
    const tenantId = context.tenantId
    const sp = await this.prisma.fbaReportJob.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, select: FBA_SELECT })
    if (sp) return this.spDetail(tenantId, sp, now)
    const ads = await this.prisma.adsReportJob.findFirst({ where: { id, tenantId, ...adsRelationWhere(scope) }, select: ADS_SELECT })
    if (ads) return this.adsDetail(tenantId, ads)
    const kiosk = await this.prisma.syncJob.findFirst({ where: { id, tenantId, type: KIOSK_TYPE, connection: connectionWhere(scope) }, select: KIOSK_SELECT })
    if (kiosk) return this.kioskDetail(tenantId, kiosk)
    throw appError('REPORT_NOT_FOUND', '报告任务不存在或不在当前数据范围内')
  }

  /** 关联的同步任务：优先用任务上记的编号，旧任务按同步任务上下文里的报告编号找。 */
  private async syncJobOf(tenantId: string, linkedId: string | null, type: string, reportJobId: string): Promise<ReportSyncJobView | null> {
    const job = linkedId
      ? await this.prisma.syncJob.findFirst({ where: { id: linkedId, tenantId }, select: SYNC_SELECT })
      : await this.prisma.syncJob.findFirst({ where: { tenantId, type, context: { path: ['reportJobId'], equals: reportJobId } }, select: SYNC_SELECT, orderBy: { createdAt: 'desc' } })
    return job ? syncViewOf(job) : null
  }

  private async spDetail(tenantId: string, job: FbaRecord, now: Date): Promise<ReportDetailResponse> {
    const [row] = await spRowsOf(this.prisma, tenantId, [job], now)
    if (!row) throw appError('REPORT_NOT_FOUND', '报告任务不存在或不在当前数据范围内')
    const events = reportEventsOf(job.timelineJson).map(event => itemOf(new Date(event.at), event.stage, event.text))
    const timeline = byTime([itemOf(job.createdAt, 'REQUESTED'), ...events, ...endItem(row, job.finishedAt, job.updatedAt)])
    const notes = [NOTE_COUNTS, NOTE_WARNINGS]
    if (row.status === 'CANCELLED') notes.push('取消只在本系统生效：亚马逊侧已经申请的报告会照常生成，但不会再下载和导入。')
    if (row.fileState === 'NOT_STORED') notes.push('原始文件按内容去重，只留存第一份；这个任务的文件内容与已留存的一份相同，或留存时出错。')
    if (row.status === 'READY' && job.importedRows === null) notes.push('这个任务完成时还没有导入统计，行数没有记录。')
    return {
      report: row,
      request: {
        marketplaceId: job.marketplaceId,
        externalReportId: job.externalReportId,
        requestId: job.requestId,
        requestedBy: row.createdByName,
        dimensions: [],
        metrics: [],
        adProduct: null,
        dataset: null,
        params: { reportType: job.reportType, ...(row.from ? { dataStartDate: row.from } : {}), ...(row.to ? { dataEndDate: row.to } : {}) },
      },
      timeline,
      stats: statsOf(job.status, job.readRows, job.importedRows, job.skippedRows),
      warnings: warningsOf(job.warningsJson),
      syncJob: await this.syncJobOf(tenantId, job.syncJobId, 'FBA_REPORT_CREATE', job.id),
      notes,
    }
  }

  private async adsDetail(tenantId: string, job: AdsRecord): Promise<ReportDetailResponse> {
    const people = await memberNames(this.prisma, tenantId, [job.requestedBy])
    const row = adsRowOf(job, people)
    const timeline = byTime([itemOf(job.createdAt, 'REQUESTED'), ...endItem(row, job.finishedAt, job.createdAt)])
    return {
      report: row,
      request: {
        marketplaceId: null,
        externalReportId: job.externalReportId,
        requestId: job.requestId,
        requestedBy: row.createdByName,
        dimensions: job.dimensions,
        metrics: job.metricKeys,
        adProduct: job.adProduct,
        dataset: null,
        params: { reportType: job.reportType, ...(job.templateKey ? { templateKey: job.templateKey } : {}), ...(job.granularity ? { granularity: job.granularity } : {}) },
      },
      timeline,
      stats: statsOf(job.status, null, job.importedRows, job.skippedRows),
      warnings: warningsOf(job.warningSignals),
      syncJob: await this.syncJobOf(tenantId, null, 'ADS_REPORT_V1', job.id),
      notes: ['广告报告没有逐阶段的亚马逊侧时间线；失败后的重试、历史回补在“广告报表”页进行。', NOTE_COUNTS],
    }
  }

  private async kioskDetail(tenantId: string, job: KioskRecord): Promise<ReportDetailResponse> {
    const row = kioskRowOf(job, await kioskStoreNames(this.prisma, tenantId, [job]))
    const stages = [itemOf(job.createdAt, 'REQUESTED'), ...endItem(row, job.finishedAt, job.createdAt)]
    const params = Object.fromEntries(Object.entries(kioskParamsOf(job)).flatMap(([key, value]) => (typeof value === 'string' || typeof value === 'number' ? [[key, String(value)]] : [])))
    return {
      report: row,
      request: {
        marketplaceId: null,
        externalReportId: null,
        requestId: job.requestId,
        requestedBy: row.createdByName,
        dimensions: [],
        metrics: [],
        adProduct: null,
        dataset: kioskDatasetOf(job),
        params,
      },
      timeline: byTime(stages),
      stats: statsOf(row.status, null, null, null),
      warnings: [],
      syncJob: syncViewOf({ ...job, type: KIOSK_TYPE }),
      notes: ['数据中心查询由系统按计划发起，没有逐阶段的亚马逊侧时间线，也没有导入行数记录。'],
    }
  }
}
