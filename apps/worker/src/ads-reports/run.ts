import type { Readable } from 'node:stream'
import { adsReportTemplateOf, ADS_REPORT_AD_PRODUCTS } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { Prisma, type PrismaClient } from '@prisma/client'
import { shardRows, type AdsReportingV1 } from '../connectors/ads-v1-reports'
import { importRows } from '../streaming/batch'
import type { RawSink } from '../streaming/download'
import type { ImportContext } from '../types'
import { dayDate, parseReportRow, REPORT_SKIP_LABEL, type ReportSkipReason } from './rows'
import { writeReportRow } from './writers'

// 新报告接口任务的运行器（P3-15，A-02）：分两步，由同步任务的“待办再轮询”机制串起来——
//   创建：向亚马逊创建报告，记下报告编号，任务置为“生成中”，返回 pending（监听器 30 秒后再来轮询）；
//   轮询：报告没好继续 pending（超过上限就永久失败）；失败永久失败；好了就流式下载、按模板写入指标表，登记导入行数、警告与历史可用起点。
// 一个报告可能被分成多个分片，逐个下载；每 1000 行一个事务，已提交的批在任务重试时按幂等键覆盖，不会重复。
// 失败原因写在任务上（failureCode 与中文的 failureMessage），页面直接展示。

/** 报告超过这个时间还没生成好就放弃（亚马逊的大报告可能要几十分钟，几个小时都不出多半是出问题了）。 */
export const ADS_REPORT_MAX_WAIT_MS = 6 * 60 * 60 * 1000

export type AdsReportRunDeps = {
  reporting: Pick<AdsReportingV1, 'create' | 'retrieve'>
  /** 企业数据口径时区的今天（检查时间范围上限用）。 */
  today: string
  now?: () => Date
  /** 测试里替换分片下载。 */
  open?: (url: string, options: { sink?: RawSink }) => Promise<Readable>
}

export type AdsReportRunResult = { pending: true; reportId: string } | { ready: true; reportId: string | null; imported: number; skipped: number }

/** 广告账户行（指标表对它有外键）：统一接口的账户编号对应一行，已有就不动。 */
export async function ensureAdsAccount(prisma: PrismaClient, profile: { tenantId: string; id: string; adsAccountId: string; displayName: string | null; currencyCode: string }, now: Date) {
  await prisma.adsAccount.upsert({
    where: { tenantId_adsAccountId: { tenantId: profile.tenantId, adsAccountId: profile.adsAccountId } },
    create: {
      tenantId: profile.tenantId,
      adsProfileId: profile.id,
      adsAccountId: profile.adsAccountId,
      name: profile.displayName ?? profile.adsAccountId,
      currency: profile.currencyCode,
      sourceUpdatedAt: now,
    },
    update: {},
  })
}

async function failJob(prisma: PrismaClient, jobId: string, code: string, message: string, now: Date): Promise<never> {
  await prisma.adsReportJob.update({ where: { id: jobId }, data: { status: 'FAILED', failureCode: code, failureMessage: message, finishedAt: now } })
  throw new NonRetryableError(code, message)
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10)

export async function runAdsReport(ctx: ImportContext, scope: { reportJobId: string }, deps: AdsReportRunDeps): Promise<AdsReportRunResult> {
  const { prisma } = ctx
  const now = (deps.now ?? (() => new Date()))()
  const job = await prisma.adsReportJob.findUnique({ where: { id: scope.reportJobId }, include: { adsProfile: true } })
  if (!job) throw new NonRetryableError('ADS_REPORT_JOB_NOT_FOUND', '报告任务记录不存在')
  const template = job.source === 'V1' ? adsReportTemplateOf(job.templateKey) : null
  if (!template) throw new NonRetryableError('ADS_REPORT_TEMPLATE_UNKNOWN', '报告模板不存在')
  if (job.status === 'READY') return { ready: true, reportId: job.externalReportId, imported: job.importedRows ?? 0, skipped: job.skippedRows ?? 0 }
  if (job.status === 'FAILED') throw new NonRetryableError(job.failureCode ?? 'ADS_REPORT_FAILED', job.failureMessage ?? '报告任务已失败')
  const profile = job.adsProfile
  if (!profile.adsAccountId) return failJob(prisma, job.id, 'ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号，无法使用新报告接口', now)
  if (!job.fromDate || !job.toDate) return failJob(prisma, job.id, 'ADS_REPORT_WINDOW', '报告任务缺少起止日期', now)

  if (!job.externalReportId) {
    const reportId = await deps.reporting.create({
      granularity: template.granularity,
      from: dayOf(job.fromDate),
      to: dayOf(job.toDate),
      today: deps.today,
      dimensions: [...template.dimensions],
      metrics: [...template.metrics],
      adProducts: [job.adProduct],
    })
    await prisma.adsReportJob.update({ where: { id: job.id }, data: { status: 'GENERATING', externalReportId: reportId, startedAt: now } })
    return { pending: true, reportId }
  }

  const state = await deps.reporting.retrieve(job.externalReportId)
  if (state.state === 'FAILED') return failJob(prisma, job.id, 'ADS_REPORT_FAILED', `亚马逊生成报告失败（${state.reason}）`, now)
  if (state.state === 'PENDING') {
    if (job.startedAt && now.getTime() - job.startedAt.getTime() > ADS_REPORT_MAX_WAIT_MS)
      return failJob(prisma, job.id, 'ADS_REPORT_NOT_READY', '报告超过 6 小时还没有生成完成，已放弃；可以稍后重试', now)
    return { pending: true, reportId: state.reportId }
  }

  await ensureAdsAccount(prisma, { tenantId: job.tenantId, id: profile.id, adsAccountId: profile.adsAccountId, displayName: profile.displayName, currencyCode: profile.currencyCode }, now)
  const writeScope = {
    tenantId: job.tenantId,
    adsProfileId: profile.id,
    adsAccountId: profile.adsAccountId,
    jobId: job.id,
    adProduct: (ADS_REPORT_AD_PRODUCTS as readonly string[]).includes(job.adProduct) ? job.adProduct : ADS_REPORT_AD_PRODUCTS[0],
    currency: profile.currencyCode,
    now,
  }
  const reasons: Partial<Record<ReportSkipReason, number>> = {}
  const seen: { earliest: string | null } = { earliest: null }
  const result = await importRows(ctx, shardRows(state.shardUrls, { open: deps.open }), async (inner, raw) => {
    const parsed = parseReportRow(template.key, raw)
    if ('skipped' in parsed) {
      reasons[parsed.skipped] = (reasons[parsed.skipped] ?? 0) + 1
      return 'skipped'
    }
    await writeReportRow(inner.prisma, writeScope, template.key, parsed)
    const day = parsed.keys.day || dayOf(parsed.keys.hourStart as Date)
    if (!seen.earliest || day < seen.earliest) seen.earliest = day
    return 'imported'
  })
  const reasonText = (Object.entries(reasons) as Array<[ReportSkipReason, number]>).map(([reason, rows]) => `${REPORT_SKIP_LABEL[reason]}：${rows} 行`).join('；')
  if (result.read > 0 && result.imported === 0) {
    return failJob(prisma, job.id, 'ADS_REPORT_ROWS_UNREADABLE', `报告返回了 ${result.read} 行，但没有一行能按“${template.label}”读出（${reasonText}）；常见原因是报告的字段名与预期不一致`, now)
  }
  await prisma.adsReportJob.update({
    where: { id: job.id },
    data: {
      status: 'READY',
      importedRows: result.imported,
      skippedRows: result.skipped,
      warningSignals: state.warnings.length > 0 ? state.warnings : Prisma.DbNull,
      failureCode: null,
      failureMessage: null,
      finishedAt: now,
    },
  })
  // 历史可用起点：只由日粒度任务登记，取已取得数据的最早日期，只往前推
  if (template.granularity === 'DAILY' && seen.earliest) {
    await prisma.adsProfile.updateMany({
      where: { id: profile.id, OR: [{ historyFrom: null }, { historyFrom: { gt: dayDate(seen.earliest) } }] },
      data: { historyFrom: dayDate(seen.earliest), historyProbedAt: now },
    })
  }
  if (result.skipped > 0) ctx.logger.warn({ reportJobId: job.id, skipped: result.skipped, reasons }, 'ads report rows skipped')
  return { ready: true, reportId: state.reportId, imported: result.imported, skipped: result.skipped }
}
