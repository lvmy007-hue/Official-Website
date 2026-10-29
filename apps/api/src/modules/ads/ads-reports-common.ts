import type { Prisma } from '@prisma/client'
import {
  ADS_REPORT_SOURCES,
  ADS_REPORT_STATUSES,
  adsReportFailureText,
  adsReportRetryable,
  adsReportTemplateOf,
  type AdsReportProfileRef,
  type AdsReportRow,
  type AdsReportSource,
  type AdsReportStatus,
  type AdsReportWarningView,
} from '@nova/api-contracts'
import { nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { todayIn, validZone } from '../overview'

// 广告报表的公共部分（P3-15）：任务行的读取字段与转换、企业口径的今天。

export const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const REPORT_SELECT = {
  id: true,
  source: true,
  templateKey: true,
  reportType: true,
  adProduct: true,
  granularity: true,
  dimensions: true,
  metricKeys: true,
  fromDate: true,
  toDate: true,
  status: true,
  importedRows: true,
  skippedRows: true,
  warningSignals: true,
  failureCode: true,
  failureMessage: true,
  attempt: true,
  retryOfId: true,
  requestedBy: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  adsProfile: { select: { id: true, displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.AdsReportJobSelect
export type ReportRecord = Prisma.AdsReportJobGetPayload<{ select: typeof REPORT_SELECT }>

// 库里有检查约束保证来源合法；状态没有约束，落到兜底值说明数据被绕过写入规则改过，按“排队中”处理也不让页面崩。
const pick = <T extends string>(list: readonly T[], value: string, fallback: T): T => ((list as readonly string[]).includes(value) ? (value as T) : fallback)
export const reportSourceOf = (value: string): AdsReportSource => pick(ADS_REPORT_SOURCES, value, 'LEGACY')
export const reportStatusOf = (value: string): AdsReportStatus => pick(ADS_REPORT_STATUSES, value, 'PENDING')
const GRANULARITIES = ['HOURLY', 'DAILY', 'MONTHLY'] as const

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null)

/** 报告返回的警告信号（JSON 数组）→ 视图；格式不对的条目丢弃。 */
export function warningsOf(value: Prisma.JsonValue | null): AdsReportWarningView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const { code, message } = item as { code?: unknown; message?: unknown }
    return typeof code === 'string' && code ? [{ code, message: typeof message === 'string' && message ? message : code }] : []
  })
}

export const profileRefOf = (profile: ReportRecord['adsProfile']): AdsReportProfileRef => ({
  id: profile.id,
  name: profile.displayName ?? profile.profileId,
  storeName: profile.sellerAccount?.displayName ?? null,
})

export function reportRowOf(record: ReportRecord, people: ReadonlyMap<string, string>, retried: ReadonlySet<string>): AdsReportRow {
  const source = reportSourceOf(record.source)
  const status = reportStatusOf(record.status)
  const template = source === 'V1' ? adsReportTemplateOf(record.templateKey) : null
  return {
    id: record.id,
    source,
    templateKey: record.templateKey,
    title: template?.label ?? record.reportType,
    adProduct: record.adProduct,
    granularity: record.granularity ? pick(GRANULARITIES, record.granularity, 'DAILY') : null,
    dimensions: record.dimensions,
    metrics: record.metricKeys,
    from: day(record.fromDate),
    to: day(record.toDate),
    status,
    importedRows: record.importedRows,
    skippedRows: record.skippedRows,
    warnings: warningsOf(record.warningSignals),
    failureCode: status === 'FAILED' ? record.failureCode : null,
    failureText: status === 'FAILED' ? adsReportFailureText(record.failureCode, record.failureMessage) : null,
    attempt: record.attempt,
    retryOfId: record.retryOfId,
    canRetry: adsReportRetryable({ source, status }, retried.has(record.id)),
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    profile: profileRefOf(record.adsProfile),
    requestedByName: record.requestedBy ? nameOrFormer(people, record.requestedBy) : null,
  }
}

/** 企业数据口径时区的今天（时间范围上限与回补都以它为准）。 */
export async function enterpriseToday(prisma: PrismaService, tenantId: string, now: Date = new Date()): Promise<string> {
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  return todayIn(validZone(tenant?.timezone), now)
}
