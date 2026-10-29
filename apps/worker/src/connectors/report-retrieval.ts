import { failedData, importWarnings, statsData, warningsJson } from '../reports/job-state'
import type { RawFileOpener } from '../streaming/raw-files'
import type { ImportContext } from '../types'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'
import { importReportDocument, reportImporterFor } from './report-import'
import { US_MARKETPLACE } from './sp-api-v2'

// “检索型”报告（不能 createReport、不能排程，只能列出亚马逊已经生成的再下载）的共用部分：结算报告（R-28，P2b-07）与销售税报告（R-33，P2b-12）。
// 列出用 Reports API 2021-06-30 的 getReports（processingStatuses=DONE，createdSince 最早 90 天前）；翻页只带 nextToken
// （亚马逊要求带上 nextToken 时不能再带其它筛选参数），响应是 { reports, nextToken }。

export const REPORTS_PATH = '/reports/2021-06-30/reports'
export const RETRIEVAL_LIST_PAGE_SIZE = 100
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_LIST_PAGES = 10

export interface RetrievedReportRef {
  reportId: string
  documentId: string
  /** 报告覆盖的数据起止（亚马逊给的数据起止时间）。 */
  dataStart: Date | null
  dataEnd: Date | null
}

export class ReportListApi {
  constructor(
    private readonly client: Pick<AmazonSpApiClient, 'request'>,
    readonly reportType: string,
  ) {}

  listDone(createdSince: Date, nextToken?: string) {
    return this.client.request({
      path: REPORTS_PATH,
      query: nextToken ? { nextToken } : { reportTypes: this.reportType, processingStatuses: 'DONE', createdSince: createdSince.toISOString(), pageSize: String(RETRIEVAL_LIST_PAGE_SIZE) },
    })
  }
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const time = (value: unknown) => {
  const raw = text(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 解析一页报告列表：不是指定报告类型、没有报告编号或文档编号的条目跳过（计数）。 */
export function parseReportRefs(body: unknown, reportType: string): { reports: RetrievedReportRef[]; skipped: number; nextToken: string | null } {
  const root = record(body)
  const payload = record(root?.payload) ?? root
  const reports: RetrievedReportRef[] = []
  let skipped = 0
  for (const raw of Array.isArray(payload?.reports) ? payload.reports : []) {
    const item = record(raw)
    const reportId = text(item?.reportId)
    const documentId = text(item?.reportDocumentId)
    const type = text(item?.reportType)
    if (!item || !reportId || !documentId || (type !== null && type !== reportType)) {
      skipped += 1
      continue
    }
    reports.push({ reportId, documentId, dataStart: time(item.dataStartTime), dataEnd: time(item.dataEndTime) })
  }
  return { reports, skipped, nextToken: text(payload?.nextToken) }
}

export interface RetrievalScope {
  tenantId: string
  sellerAccountId: string
}
export interface RetrievalOptions {
  reportType: string
  /** 往回看多少天。 */
  lookbackDays: number
  /** FbaReportJob.requestId，标明是哪个同步任务建的。 */
  requestId: string
  now?: Date
}
export interface RetrievalResult {
  listed: number
  imported: number
  rows: number
  skipped: number
  failed: number
}

/**
 * 列出已生成的报告，没导入过的逐份下载导入。每份报告对应一条 FbaReportJob（以亚马逊报告编号为准，导入成功为 READY）：
 * 已 READY 的不再重复下载；失败的下次同步重试。上游错误（授权、限流、5xx）原样抛出交给任务运行时分类重试；
 * 某份报告自身解析失败（格式变化）只记失败、继续下一份，全部失败才让任务失败。
 */
export async function syncRetrievedReports(
  ctx: ImportContext & { openRawFile?: RawFileOpener },
  api: Pick<ReportListApi, 'listDone'>,
  client: Pick<AmazonSpApiClient, 'openReportDocument'>,
  scope: RetrievalScope,
  options: RetrievalOptions,
): Promise<RetrievalResult> {
  const { prisma, logger } = ctx
  const { tenantId, sellerAccountId } = scope
  const { reportType } = options
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - options.lookbackDays * DAY_MS)

  const found = new Map<string, RetrievedReportRef>()
  let skipped = 0
  let token: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const parsed = parseReportRefs(await api.listDone(since, token), reportType)
    skipped += parsed.skipped
    for (const report of parsed.reports) found.set(report.reportId, report)
    if (!parsed.nextToken) break
    token = parsed.nextToken
  }
  const reports = [...found.values()].sort((a, b) => (a.dataEnd?.getTime() ?? 0) - (b.dataEnd?.getTime() ?? 0))
  const known = new Map(
    (reports.length === 0
      ? []
      : await prisma.fbaReportJob.findMany({
          where: { tenantId, sellerAccountId, reportType, externalReportId: { in: reports.map(item => item.reportId) } },
          select: { id: true, externalReportId: true, status: true },
        })
    ).map(item => [item.externalReportId, item]),
  )

  let imported = 0
  let rows = 0
  let failed = 0
  let firstError: unknown = null
  for (const report of reports) {
    const before = known.get(report.reportId)
    if (before?.status === 'READY') continue
    const job =
      before ??
      (await prisma.fbaReportJob.create({
        data: {
          tenantId,
          sellerAccountId,
          marketplaceId: US_MARKETPLACE,
          reportType,
          status: 'PENDING',
          externalReportId: report.reportId,
          documentId: report.documentId,
          fromDate: report.dataStart,
          toDate: report.dataEnd,
          requestId: options.requestId,
        },
        select: { id: true, externalReportId: true, status: true },
      }))
    try {
      const importer = reportImporterFor({ id: job.id, reportType, documentId: report.documentId, sellerAccountId }, { tenantId, sellerAccountId, marketplaceId: US_MARKETPLACE })
      const result = await importReportDocument(ctx, client, report.documentId, importer, {
        tenantId,
        reportJobId: job.id,
        reportType,
        fileName: `${job.id}-${reportType}.raw`,
        record: {
          storeKey: sellerAccountId,
          sellerAccountId,
          sourceKey: `report:${job.id}`,
          reportType,
          reportId: report.reportId,
          periodStart: report.dataStart,
          periodEnd: report.dataEnd,
        },
      })
      await prisma.fbaReportJob.update({
        where: { id: job.id },
        data: {
          status: 'READY',
          documentId: report.documentId,
          downloadUrl: result.downloadUrl,
          failureCode: null,
          failureMessage: null,
          expiresAt: new Date(now.getTime() + DAY_MS),
          ...statsData(result),
          warningsJson: warningsJson(await importWarnings(prisma, { id: job.id, tenantId, sellerAccountId, reportType }, result.columns ?? [])),
          finishedAt: new Date(),
        },
      })
      imported += 1
      rows += result.imported
    } catch (error) {
      await prisma.fbaReportJob.update({ where: { id: job.id }, data: failedData(error instanceof Error ? error.message.slice(0, 64) : 'IMPORT_FAILED') })
      // 上游错误（授权、限流、5xx）不是这份报告的问题：交给任务运行时分类重试
      if (error instanceof UpstreamHttpError) throw error
      failed += 1
      firstError ??= error
      logger.warn(
        { tenantId, sellerAccountId, reportId: report.reportId, reportType, error: error instanceof Error ? error.message : String(error) },
        'retrieved report import failed; continuing with the next report',
      )
    }
  }
  if (failed > 0 && imported === 0) throw firstError
  return { listed: reports.length, imported, rows, skipped, failed }
}
