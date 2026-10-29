import type { Prisma } from '@prisma/client'
import {
  REPORT_STATUSES,
  adsReportFailureText,
  reportCanCancel,
  reportCanRetry,
  reportCatalogOf,
  reportEventsOf,
  reportFailureText,
  reportParseState,
  reportPeriodText,
  spReportOf,
  type ReportFileState,
  type ReportRow,
  type ReportStatus,
  type ReportWarning,
} from '@nova/api-contracts'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'

// 报表中心三个来源的任务行（P5-03）：亚马逊报告（FbaReportJob）、广告报告（AdsReportJob）、数据中心查询（SyncJob，类型 DATA_KIOSK_QUERY）。
// 三张表的状态口径不同，这里统一成 ReportRow：排队中、生成中、已完成、失败、已取消。

const pick = <T extends string>(list: readonly T[], value: string, fallback: T): T => ((list as readonly string[]).includes(value) ? (value as T) : fallback)
// 库里的状态没有统一的检查约束（广告表没有）；认不出的值按“排队中”处理，不让页面崩
export const reportStatusOf = (value: string): ReportStatus => pick(REPORT_STATUSES, value, 'PENDING')

export const dayText = (date: Date | null | undefined) => (date ? date.toISOString().slice(0, 10) : null)

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** 同步任务状态 → 报告状态（数据中心查询没有自己的任务表，直接用同步任务）。 */
export const syncStatusOf = (status: string): ReportStatus => (status === 'SUCCEEDED' ? 'READY' : status === 'RUNNING' ? 'GENERATING' : status === 'FAILED_PERMANENT' ? 'FAILED' : 'PENDING')

/** 警告 JSON（数组）→ 视图；格式不对的条目丢弃。亚马逊报告的 warningsJson 与广告报告的 warningSignals 都是 { code, message } 数组。 */
export function warningsOf(value: unknown): ReportWarning[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const { code, message } = record(item)
    return typeof code === 'string' && code ? [{ code, message: typeof message === 'string' && message ? message : code }] : []
  })
}

// ---- 亚马逊报告 ----

export const FBA_SELECT = {
  id: true,
  reportType: true,
  marketplaceId: true,
  fromDate: true,
  toDate: true,
  status: true,
  externalReportId: true,
  documentId: true,
  failureCode: true,
  failureMessage: true,
  requestId: true,
  createdById: true,
  createdAt: true,
  syncJobId: true,
  readRows: true,
  importedRows: true,
  skippedRows: true,
  warningsJson: true,
  timelineJson: true,
  retryOfId: true,
  attempt: true,
  startedAt: true,
  finishedAt: true,
  updatedAt: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.FbaReportJobSelect
export type FbaRecord = Prisma.FbaReportJobGetPayload<{ select: typeof FBA_SELECT }>

/** 一批亚马逊报告任务 → 行。原始文件、是否已被重试、创建人各查一次（每页最多 pageSize 个任务）。 */
export async function spRowsOf(prisma: PrismaService, tenantId: string, jobs: readonly FbaRecord[], now: Date): Promise<ReportRow[]> {
  if (jobs.length === 0) return []
  const ids = jobs.map(job => job.id)
  const [people, files, retriedRows] = await Promise.all([
    memberNames(
      prisma,
      tenantId,
      jobs.map(job => job.createdById),
    ),
    prisma.rawReportFile.findMany({ where: { tenantId, sourceKey: { in: ids.map(id => `report:${id}`) } }, select: { sourceKey: true, retentionUntil: true }, take: ids.length }),
    prisma.fbaReportJob.findMany({ where: { tenantId, retryOfId: { in: ids } }, select: { retryOfId: true }, take: ids.length }),
  ])
  const retention = new Map(files.map(file => [file.sourceKey.replace(/^report:/, ''), file.retentionUntil]))
  const retried = new Set(retriedRows.flatMap(row => (row.retryOfId ? [row.retryOfId] : [])))
  return jobs.map(job => spRowOf(job, people, retention, retried, now))
}

export function spRowOf(job: FbaRecord, people: ReadonlyMap<string, string>, retention: ReadonlyMap<string, Date | null>, retried: ReadonlySet<string>, now: Date): ReportRow {
  const entry = spReportOf(job.reportType)
  const status = reportStatusOf(job.status)
  const from = dayText(job.fromDate)
  const to = dayText(job.toDate)
  const stages = reportEventsOf(job.timelineJson).map(event => event.stage)
  // 同样内容的文件只留存第一份（按内容去重），所以已完成但没有自己登记的文件，写“没有留存原始文件”
  const keptUntil = retention.get(job.id)
  const fileState: ReportFileState = status !== 'READY' ? 'NONE' : !retention.has(job.id) ? 'NOT_STORED' : keptUntil && keptUntil <= now ? 'EXPIRED' : 'STORED'
  const failed = status === 'FAILED' || status === 'CANCELLED'
  return {
    id: job.id,
    source: 'SP_API',
    domain: entry?.domain ?? null,
    reportKey: job.reportType,
    label: entry?.label ?? job.reportType,
    storeName: job.sellerAccount?.displayName ?? null,
    from,
    to,
    periodText: reportPeriodText(entry?.period ?? null, from, to),
    status,
    failureCode: failed ? job.failureCode : null,
    failureText: failed ? reportFailureText(job.failureCode, job.failureMessage) : null,
    fileState,
    parseState: reportParseState(status, stages),
    readRows: job.readRows,
    importedRows: job.importedRows,
    skippedRows: job.skippedRows,
    retentionUntil: fileState === 'STORED' || fileState === 'EXPIRED' ? (keptUntil?.toISOString() ?? null) : null,
    requirement: entry?.requirement ?? '不在报表中心目录里的历史任务，没有登记申请条件',
    createdAt: job.createdAt.toISOString(),
    createdByName: job.createdById ? nameOrFormer(people, job.createdById) : '系统',
    attempt: job.attempt,
    retryOfId: job.retryOfId,
    // 已经开始下载解析的任务不能取消：取消不了正在写库的导入，结束后还会变成“已完成”
    canCancel: reportCanCancel('SP_API', status) && !stages.includes('DOWNLOADING'),
    canRetry: entry?.mode === 'CREATE' && reportCanRetry('SP_API', status, retried.has(job.id)),
    canDownload: fileState === 'STORED',
    analysisPath: entry?.analysisPath ?? null,
    createPath: null,
  }
}

// ---- 广告报告 ----

export const ADS_SELECT = {
  id: true,
  templateKey: true,
  reportType: true,
  adProduct: true,
  granularity: true,
  dimensions: true,
  metricKeys: true,
  fromDate: true,
  toDate: true,
  status: true,
  externalReportId: true,
  importedRows: true,
  skippedRows: true,
  warningSignals: true,
  failureCode: true,
  failureMessage: true,
  requestId: true,
  attempt: true,
  retryOfId: true,
  requestedBy: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  adsProfile: { select: { displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.AdsReportJobSelect
export type AdsRecord = Prisma.AdsReportJobGetPayload<{ select: typeof ADS_SELECT }>

const ADS_LEGACY_REQUIREMENT = '旧版广告报告接口创建的历史任务'

export function adsRowOf(job: AdsRecord, people: ReadonlyMap<string, string>): ReportRow {
  const entry = reportCatalogOf('ADS', job.templateKey)
  const status = reportStatusOf(job.status)
  const from = dayText(job.fromDate)
  const to = dayText(job.toDate)
  return {
    id: job.id,
    source: 'ADS',
    domain: 'ADS',
    reportKey: job.templateKey ?? job.reportType,
    label: entry?.label ?? `广告·${job.reportType}`,
    storeName: job.adsProfile.sellerAccount?.displayName ?? job.adsProfile.displayName ?? job.adsProfile.profileId,
    from,
    to,
    periodText: reportPeriodText('RANGE', from, to),
    status,
    failureCode: status === 'FAILED' ? job.failureCode : null,
    failureText: status === 'FAILED' ? adsReportFailureText(job.failureCode, job.failureMessage) : null,
    fileState: 'NOT_APPLICABLE',
    parseState: reportParseState(status, []),
    readRows: null,
    importedRows: job.importedRows,
    skippedRows: job.skippedRows,
    retentionUntil: null,
    requirement: entry?.requirement ?? ADS_LEGACY_REQUIREMENT,
    createdAt: job.createdAt.toISOString(),
    createdByName: job.requestedBy ? nameOrFormer(people, job.requestedBy) : '系统',
    attempt: job.attempt,
    retryOfId: job.retryOfId,
    canCancel: false,
    canRetry: false,
    canDownload: false,
    analysisPath: entry?.analysisPath ?? null,
    createPath: entry?.createPath ?? null,
  }
}

// ---- 数据中心查询 ----

export const KIOSK_SELECT = {
  id: true,
  status: true,
  failureCode: true,
  requestId: true,
  context: true,
  attempts: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.SyncJobSelect
export type KioskRecord = Prisma.SyncJobGetPayload<{ select: typeof KIOSK_SELECT }>

export const kioskDatasetOf = (job: Pick<KioskRecord, 'context'>) => text(record(job.context).dataset)
export const kioskParamsOf = (job: Pick<KioskRecord, 'context'>): Record<string, unknown> => record(record(job.context).params)

export function kioskRowOf(job: KioskRecord, storeNames: ReadonlyMap<string, string>): ReportRow {
  const dataset = kioskDatasetOf(job)
  const entry = reportCatalogOf('DATA_KIOSK', dataset)
  const status = syncStatusOf(job.status)
  const params = kioskParamsOf(job)
  const from = text(params.startDate)
  const to = text(params.endDate)
  const storeId = text(params.sellerAccountId)
  return {
    id: job.id,
    source: 'DATA_KIOSK',
    domain: 'DATA_CENTER',
    reportKey: dataset ?? 'unknown',
    label: entry?.label ?? dataset ?? '数据中心查询',
    storeName: storeId ? (storeNames.get(storeId) ?? null) : null,
    from,
    to,
    periodText: reportPeriodText('RANGE', from, to),
    status,
    failureCode: status === 'FAILED' ? job.failureCode : null,
    failureText: status === 'FAILED' ? reportFailureText(job.failureCode) : null,
    fileState: 'NOT_APPLICABLE',
    parseState: reportParseState(status, []),
    readRows: null,
    importedRows: null,
    skippedRows: null,
    retentionUntil: null,
    requirement: entry?.requirement ?? '数据中心数据集',
    createdAt: job.createdAt.toISOString(),
    createdByName: '系统',
    attempt: 1,
    retryOfId: null,
    canCancel: false,
    canRetry: false,
    canDownload: false,
    analysisPath: entry?.analysisPath ?? null,
    createPath: null,
  }
}

/** 数据中心任务参数里的店铺编号 → 店铺名。 */
export async function kioskStoreNames(prisma: PrismaService, tenantId: string, jobs: readonly KioskRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(jobs.flatMap(job => text(kioskParamsOf(job).sellerAccountId) ?? []))]
  if (ids.length === 0) return new Map()
  const rows = await prisma.sellerAccount.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true }, take: ids.length })
  return new Map(rows.map(row => [row.id, row.displayName]))
}
