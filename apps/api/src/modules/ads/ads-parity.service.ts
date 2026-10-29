import { Injectable } from '@nestjs/common'
import {
  ADS_PARITY_CATEGORIES,
  ADS_PARITY_DIFF_LIMIT,
  ADS_PARITY_JOB,
  ADS_PARITY_STATUSES,
  ADS_PARITY_SUNSET_NOTE,
  ADS_READ,
  ADS_REPORT_WRITE,
  AdsParityRunBodySchema,
  type AdsParityCategory,
  type AdsParityDiffsResponse,
  type AdsParityResponse,
  type AdsParityRunResult,
  type AdsParityRunRow,
  type AdsParityStatus,
} from '@nova/api-contracts'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { adsProfileWhere, adsRelationWhere, ContextService } from '../auth'
import { ConnectionsService } from '../connections'
import { profileRefOf, REPORT_ID_PATTERN } from './ads-reports-common'

const RUN_LIMIT = 60
const PROFILE_LIMIT = 200
const NOTE_NONE = '还没有广告档案：先完成亚马逊广告授权并同步档案，才能做新旧接口核对'
const NOTE_NO_RUN = '还没有做过新旧接口核对：已经发现广告账户编号的档案会每天自动核对一次，也可以在这里手动触发'

const pick = <T extends string>(list: readonly T[], value: string, fallback: T): T => ((list as readonly string[]).includes(value) ? (value as T) : fallback)
const dayText = (date: Date) => date.toISOString().slice(0, 10)

type RunRecord = {
  id: string
  adsProfileId: string
  windowStart: Date
  windowEnd: Date
  legacyCount: number
  newCount: number
  matchedCount: number
  unexplainedCount: number
  warningCount: number
  status: string
  startedAt: Date
  finishedAt: Date | null
}

// 迁移期对照（P3-15，08 章 8.12；freeze/api.md /ads/parity*）：同一时间窗内旧版日指标与新报告接口比对，差异分时间口径、归因口径、范围、未解释四类，
// 连续多次没有未解释差异后旧通道关闭（核对运行与关闭规则在 worker，P3-01）。这里只读核对结果，并允许手动触发一次核对任务。
@Injectable()
export class AdsParityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly context: ContextService,
    private readonly connections: ConnectionsService,
  ) {}

  private async countsOf(tenantId: string, runIds: readonly string[]) {
    const counts = new Map<string, Record<AdsParityCategory, number>>()
    if (runIds.length === 0) return counts
    const grouped = await this.prisma.adsParityDiff.groupBy({
      by: ['runId', 'category'],
      where: { tenantId, runId: { in: [...runIds] } },
      _count: { _all: true },
      orderBy: [{ runId: 'asc' }, { category: 'asc' }],
    })
    for (const group of grouped) {
      const entry = counts.get(group.runId) ?? (Object.fromEntries(ADS_PARITY_CATEGORIES.map(category => [category, 0])) as Record<AdsParityCategory, number>)
      if (group.category in entry) entry[group.category as AdsParityCategory] = group._count._all
      counts.set(group.runId, entry)
    }
    return counts
  }

  private runRow(record: RunRecord, profileName: string, counts: ReadonlyMap<string, Record<AdsParityCategory, number>>): AdsParityRunRow {
    return {
      id: record.id,
      adsProfileId: record.adsProfileId,
      profileName,
      windowStart: dayText(record.windowStart),
      windowEnd: dayText(record.windowEnd),
      legacyCount: record.legacyCount,
      newCount: record.newCount,
      matchedCount: record.matchedCount,
      unexplainedCount: record.unexplainedCount,
      warningCount: record.warningCount,
      status: pick(ADS_PARITY_STATUSES, record.status, 'HAS_DIFFS'),
      startedAt: record.startedAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString() ?? null,
      counts: counts.get(record.id) ?? (Object.fromEntries(ADS_PARITY_CATEGORIES.map(category => [category, 0])) as Record<AdsParityCategory, number>),
    }
  }

  async overview(req: RequestWithContext, rawQuery: Record<string, string> = {}): Promise<AdsParityResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const tenantId = context.tenantId
    const profiles = await this.prisma.adsProfile.findMany({
      where: { tenantId, ...adsProfileWhere(scope) },
      select: {
        id: true,
        displayName: true,
        profileId: true,
        adsAccountId: true,
        sellerAccount: { select: { displayName: true } },
        parityState: { select: { legacyEnabled: true, consecutivePasses: true, requiredPasses: true, lastRunAt: true, closedAt: true, closedReason: true } },
      },
      orderBy: [{ profileId: 'asc' }, { id: 'asc' }],
      take: PROFILE_LIMIT,
    })
    const ids = profiles.map(profile => profile.id)
    const runs: RunRecord[] =
      ids.length > 0 ? await this.prisma.adsParityRun.findMany({ where: { tenantId, adsProfileId: { in: ids } }, orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: RUN_LIMIT }) : []
    const counts = await this.countsOf(
      tenantId,
      runs.map(run => run.id),
    )
    const names = new Map(profiles.map(profile => [profile.id, profile.displayName ?? profile.profileId]))
    const lastStatus = new Map<string, AdsParityStatus>()
    for (const run of runs) if (!lastStatus.has(run.adsProfileId)) lastStatus.set(run.adsProfileId, pick(ADS_PARITY_STATUSES, run.status, 'HAS_DIFFS'))
    return {
      state: ids.length === 0 ? 'NOT_CONNECTED' : runs.length === 0 ? 'NO_DATA' : 'OK',
      note: ids.length === 0 ? NOTE_NONE : runs.length === 0 ? NOTE_NO_RUN : null,
      sunsetNote: ADS_PARITY_SUNSET_NOTE,
      profiles: profiles.map(profile => ({
        ...profileRefOf({ id: profile.id, displayName: profile.displayName, profileId: profile.profileId, sellerAccount: profile.sellerAccount }),
        adsAccountReady: Boolean(profile.adsAccountId),
        legacyEnabled: profile.parityState?.legacyEnabled ?? true,
        consecutivePasses: profile.parityState?.consecutivePasses ?? 0,
        requiredPasses: profile.parityState?.requiredPasses ?? 7,
        lastRunAt: profile.parityState?.lastRunAt?.toISOString() ?? null,
        closedAt: profile.parityState?.closedAt?.toISOString() ?? null,
        closedReason: profile.parityState?.closedReason ?? null,
        lastStatus: lastStatus.get(profile.id) ?? null,
      })),
      runs: runs.map(run => this.runRow(run, names.get(run.adsProfileId) ?? run.adsProfileId, counts)),
    }
  }

  /** 一次核对的差异明细：未解释的排最前，最多返回 ADS_PARITY_DIFF_LIMIT 行。 */
  async diffs(req: RequestWithContext, runId: string, rawQuery: Record<string, string> = {}): Promise<AdsParityDiffsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    if (!REPORT_ID_PATTERN.test(runId)) throw new AppError(404, 'ADS_PARITY_RUN_NOT_FOUND', '核对记录不存在')
    const run = await this.prisma.adsParityRun.findFirst({
      where: { id: runId, tenantId: context.tenantId, ...adsRelationWhere(scope) },
      include: { adsProfile: { select: { displayName: true, profileId: true } } },
    })
    if (!run) throw new AppError(404, 'ADS_PARITY_RUN_NOT_FOUND', '核对记录不存在或不在你的数据范围内')
    const counts = await this.countsOf(context.tenantId, [run.id])
    // 未解释的排最前：先单独取未解释，再补其它类，各自按创建先后；一次最多取上限 + 1 行判断是否截断
    const unexplained = await this.prisma.adsParityDiff.findMany({
      where: { tenantId: context.tenantId, runId: run.id, category: 'UNEXPLAINED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ADS_PARITY_DIFF_LIMIT + 1,
    })
    const rest =
      unexplained.length > ADS_PARITY_DIFF_LIMIT
        ? []
        : await this.prisma.adsParityDiff.findMany({
            where: { tenantId: context.tenantId, runId: run.id, category: { not: 'UNEXPLAINED' } },
            orderBy: [{ category: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            take: ADS_PARITY_DIFF_LIMIT + 1 - unexplained.length,
          })
    const all = [...unexplained, ...rest]
    const items = all.slice(0, ADS_PARITY_DIFF_LIMIT)
    return {
      run: this.runRow(run, run.adsProfile.displayName ?? run.adsProfile.profileId, counts),
      items: items.map(diff => ({
        id: diff.id,
        category: pick(ADS_PARITY_CATEGORIES, diff.category, 'UNEXPLAINED'),
        entityKey: diff.entityKey,
        field: diff.field,
        legacyValue: diff.legacyValue,
        newValue: diff.newValue,
        explanation: diff.explanation,
      })),
      truncated: all.length > ADS_PARITY_DIFF_LIMIT,
    }
  }

  /** 手动触发一次核对：只排任务（核对在 worker 里跑，每个档案每天最多真跑一次）。 */
  async run(req: RequestWithContext, rawBody: unknown): Promise<AdsParityRunResult> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_REPORT_WRITE, {})
    const input = AdsParityRunBodySchema.parse(rawBody)
    const profile = await this.prisma.adsProfile.findFirst({ where: { id: input.profileId, tenantId: context.tenantId, ...adsProfileWhere(scope) }, select: { id: true, adsAccountId: true } })
    if (!profile) throw new AppError(404, 'ADS_PROFILE_NOT_FOUND', '广告档案不存在或不在你的数据范围内')
    if (!profile.adsAccountId) throw new AppError(409, 'ADS_ACCOUNT_MISSING', '这个广告档案还没有发现统一接口的广告账户编号，暂时不能核对')
    const connection = await this.connections.authorizedAdsConnection(context.tenantId)
    if (!connection) throw new AppError(409, 'ADS_CONNECTION_REQUIRED', '需要先完成 Amazon Ads 授权')
    const job = await this.prisma.syncJob.create({
      data: {
        tenantId: context.tenantId,
        connectionId: connection.id,
        type: ADS_PARITY_JOB,
        status: 'PENDING',
        requestId: req.requestId,
        context: { adsProfileId: profile.id },
        ...syncJobMeta(connection.id, ADS_PARITY_JOB, [profile.id]),
      },
    })
    try {
      await this.queue.add('sync', { tenantId: context.tenantId, syncJobId: job.id, requestId: req.requestId, adsProfileId: profile.id }, job.id, { type: ADS_PARITY_JOB, priority: job.priority })
    } catch (error) {
      await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: new Date() } })
      throw error
    }
    return { syncJobId: job.id }
  }
}
