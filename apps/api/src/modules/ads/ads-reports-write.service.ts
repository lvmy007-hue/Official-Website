import { Injectable } from '@nestjs/common'
import {
  ADS_BACKFILL_MAX_SLICES,
  ADS_REPORT_V1_JOB,
  ADS_REPORT_WRITE,
  adsReportRetryable,
  adsReportTemplateOf,
  adsReportWindowIssue,
  AdsReportBackfillBodySchema,
  AdsReportCreateBodySchema,
  backfillWindowsOf,
  type AdsReportBackfillResult,
  type AdsReportCreateResult,
  type AdsReportTemplate,
} from '@nova/api-contracts'
import { AppError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { adsProfileWhere, adsRelationWhere, ContextService } from '../auth'
import { ConnectionsService } from '../connections'
import { enterpriseToday, REPORT_ID_PATTERN, REPORT_SELECT, reportRowOf } from './ads-reports-common'

type Spec = { template: AdsReportTemplate; adProduct: string; from: string; to: string; retryOfId?: string; attempt?: number }
type ProfileRef = { id: string; adsAccountId: string | null }

const dayStart = (day: string) => new Date(`${day}T00:00:00Z`)

// 广告报表的写入口（P3-15，freeze/api.md POST /ads/reports、/ads/reports/:id/retry、/ads/reports/backfill）：创建新报告接口任务、重试失败任务、历史回补。
// 只在本系统里建任务记录并入队，亚马逊那边的创建、轮询与导入都在 worker 里；不修改任何广告设置，所以不受写入总开关约束。
@Injectable()
export class AdsReportsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly context: ContextService,
    private readonly connections: ConnectionsService,
  ) {}

  private async profileOf(tenantId: string, scope: Parameters<typeof adsProfileWhere>[0], profileId: string): Promise<ProfileRef> {
    const profile = await this.prisma.adsProfile.findFirst({ where: { id: profileId, tenantId, ...adsProfileWhere(scope) }, select: { id: true, adsAccountId: true } })
    if (!profile) throw new AppError(404, 'ADS_PROFILE_NOT_FOUND', '广告档案不存在或不在你的数据范围内')
    return profile
  }

  /** 建任务记录与同步任务并入队；没有广告账户编号或没有授权的连接时拒绝（409），不留半截记录。 */
  private async enqueue(req: RequestWithContext, tenantId: string, userId: string, profile: ProfileRef, spec: Spec) {
    if (!profile.adsAccountId) throw new AppError(409, 'ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号，暂时不能使用新报告接口')
    const connection = await this.connections.authorizedAdsConnection(tenantId)
    if (!connection) throw new AppError(409, 'ADS_CONNECTION_REQUIRED', '创建广告报表前，需要先完成 Amazon Ads 授权并同步 Profile')
    const { template } = spec
    const report = await this.prisma.adsReportJob.create({
      data: {
        tenantId,
        adsProfileId: profile.id,
        reportType: template.key,
        adProduct: spec.adProduct,
        source: 'V1',
        templateKey: template.key,
        granularity: template.granularity,
        dimensions: [...template.dimensions],
        metricKeys: [...template.metrics],
        fromDate: dayStart(spec.from),
        toDate: dayStart(spec.to),
        status: 'PENDING',
        requestId: req.requestId,
        requestedBy: userId,
        retryOfId: spec.retryOfId ?? null,
        attempt: spec.attempt ?? 1,
      },
      select: { id: true },
    })
    const job = await this.prisma.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: ADS_REPORT_V1_JOB,
        status: 'PENDING',
        requestId: req.requestId,
        context: { reportJobId: report.id, templateKey: template.key },
        ...syncJobMeta(connection.id, ADS_REPORT_V1_JOB, [report.id]),
      },
    })
    try {
      await this.queue.add('sync', { tenantId, syncJobId: job.id, requestId: req.requestId, reportJobId: report.id, adsProfileId: profile.id }, job.id, {
        type: ADS_REPORT_V1_JOB,
        priority: job.priority,
      })
    } catch (error) {
      // 入队失败：任务不能一直显示“排队中”，标成失败并说明原因，用户可以重试
      await this.prisma.adsReportJob.update({
        where: { id: report.id },
        data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', failureMessage: '任务没能进入后台队列，请稍后重试', finishedAt: new Date() },
      })
      await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: new Date() } })
      throw error
    }
    return { reportId: report.id, syncJobId: job.id }
  }

  private async rowOf(tenantId: string, id: string) {
    const record = await this.prisma.adsReportJob.findFirstOrThrow({ where: { id, tenantId }, select: REPORT_SELECT })
    const people = await memberNames(this.prisma, tenantId, [record.requestedBy])
    return reportRowOf(record, people, new Set())
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<AdsReportCreateResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_REPORT_WRITE, {})
    const input = AdsReportCreateBodySchema.parse(rawBody)
    const template = adsReportTemplateOf(input.templateKey)
    if (!template) throw new AppError(422, 'ADS_REPORT_TEMPLATE_UNKNOWN', '报告模板不存在')
    const profile = await this.profileOf(context.tenantId, scope, input.profileId)
    const issue = adsReportWindowIssue({ granularity: template.granularity, from: input.from, to: input.to, today: await enterpriseToday(this.prisma, context.tenantId) })
    if (issue) throw new AppError(422, 'ADS_REPORT_WINDOW', issue)
    const made = await this.enqueue(req, context.tenantId, context.userId, profile, { template, adProduct: input.adProduct, from: input.from, to: input.to })
    return { report: await this.rowOf(context.tenantId, made.reportId), syncJobId: made.syncJobId }
  }

  async retry(req: RequestWithContext, id: string): Promise<AdsReportCreateResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_REPORT_WRITE, {})
    if (!REPORT_ID_PATTERN.test(id)) throw new AppError(404, 'ADS_REPORT_NOT_FOUND', '报告任务不存在')
    const old = await this.prisma.adsReportJob.findFirst({
      where: { id, tenantId: context.tenantId, ...adsRelationWhere(scope) },
      select: { id: true, source: true, status: true, templateKey: true, adProduct: true, fromDate: true, toDate: true, attempt: true, adsProfile: { select: { id: true, adsAccountId: true } } },
    })
    if (!old) throw new AppError(404, 'ADS_REPORT_NOT_FOUND', '报告任务不存在或不在你的数据范围内')
    const retried = (await this.prisma.adsReportJob.count({ where: { tenantId: context.tenantId, retryOfId: old.id } })) > 0
    if (retried) throw new AppError(409, 'ADS_REPORT_ALREADY_RETRIED', '这个失败任务已经重试过了，请看重试产生的新任务')
    if (!adsReportRetryable({ source: old.source, status: old.status }, false)) throw new AppError(409, 'ADS_REPORT_NOT_RETRYABLE', '只有新报告接口的失败任务可以重试')
    const template = adsReportTemplateOf(old.templateKey)
    if (!template || !old.fromDate || !old.toDate) throw new AppError(409, 'ADS_REPORT_NOT_RETRYABLE', '任务缺少模板或日期，无法重试')
    const from = old.fromDate.toISOString().slice(0, 10)
    const to = old.toDate.toISOString().slice(0, 10)
    // 窗口按今天重新检查：小时报告只保留 14 天，隔了几天再重试可能已经取不到了
    const issue = adsReportWindowIssue({ granularity: template.granularity, from, to, today: await enterpriseToday(this.prisma, context.tenantId) })
    if (issue) throw new AppError(422, 'ADS_REPORT_WINDOW', issue)
    const made = await this.enqueue(req, context.tenantId, context.userId, old.adsProfile, { template, adProduct: old.adProduct, from, to, retryOfId: old.id, attempt: old.attempt + 1 })
    return { report: await this.rowOf(context.tenantId, made.reportId), syncJobId: made.syncJobId }
  }

  /** 历史回补：从今天往前 N 个月，按 120 天切片各建一个活动日报任务；同一档案有没做完的回补任务时拒绝（409）。 */
  async backfill(req: RequestWithContext, rawBody: unknown): Promise<AdsReportBackfillResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_REPORT_WRITE, {})
    const input = AdsReportBackfillBodySchema.parse(rawBody)
    const template = adsReportTemplateOf('CAMPAIGN_DAILY') as AdsReportTemplate
    const profile = await this.profileOf(context.tenantId, scope, input.profileId)
    const windows = backfillWindowsOf(await enterpriseToday(this.prisma, context.tenantId), input.months)
    if (windows.length === 0 || windows.length > ADS_BACKFILL_MAX_SLICES) throw new AppError(422, 'ADS_BACKFILL_RANGE', '回补的月数不合法')
    const running = await this.prisma.adsReportJob.count({
      where: { tenantId: context.tenantId, adsProfileId: profile.id, source: 'V1', templateKey: template.key, status: { in: ['PENDING', 'GENERATING'] } },
    })
    if (running > 0) throw new AppError(409, 'ADS_BACKFILL_RUNNING', '这个广告档案还有没完成的活动日报任务，请等它们完成后再回补')
    const ids: string[] = []
    for (const window of windows) ids.push((await this.enqueue(req, context.tenantId, context.userId, profile, { template, adProduct: input.adProduct, ...window })).reportId)
    const records = await this.prisma.adsReportJob.findMany({
      where: { tenantId: context.tenantId, id: { in: ids } },
      select: REPORT_SELECT,
      orderBy: [{ fromDate: 'desc' }, { id: 'asc' }],
      take: ids.length,
    })
    const people = await memberNames(this.prisma, context.tenantId, [context.userId])
    return { reports: records.map(record => reportRowOf(record, people, new Set())), windows }
  }
}
