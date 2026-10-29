import { Injectable } from '@nestjs/common'
import {
  ADS_READ,
  ADS_WRITE_JOB,
  ADS_WRITE_KIND_INFO,
  ADS_WRITE_PREVIEW_NOTE,
  ADS_WRITE_SUBMITTED_ACTION,
  AdsWriteBatchBodySchema,
  adsChangePercent,
  adsWriteAfterText,
  adsWriteSwitches,
  adsWriteWarnings,
  type AdsWriteKind,
  type AdsWriteOp,
  type AdsWritePreviewItem,
  type AdsWritePreviewResponse,
  type AdsWriteSubmitResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import type { Prisma } from '@prisma/client'
import { AppError, appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'
import { ActionGuardService, AuditWriter, IntegrationSwitchPort } from '../../platform/write'
import { ContextService } from '../auth'
import { ConnectionsService } from '../connections'
import { kindsOf, permissionsOfKinds, RUN_SELECT, runRowOf, sameValue, switchViews, WRITE_MESSAGE_MAX } from './ads-write-common'
import { AdsWriteResolver, type ResolvedWrite } from './ads-write-resolve'

const COMPARABLE: readonly AdsWriteKind[] = ['CAMPAIGN_STATE', 'CAMPAIGN_BUDGET', 'CAMPAIGN_BID_STRATEGY', 'AD_GROUP_STATE', 'AD_GROUP_BID', 'TARGET_STATE', 'TARGET_BID']

export interface SubmitOptions {
  /** 这个入口允许的写入类型（例如活动入口只允许 CAMPAIGN_*）。 */
  allow: (kind: AdsWriteKind) => boolean
  /** 并进审计内容的入口说明（例如批量加词的来源）；只放短文字、数字、布尔。 */
  audit?: Record<string, string | number | boolean>
}

// 广告写入的统一入口（P3-17，08 章开头）：预览与提交共用同一套解析与判断。
// 提交顺序：权限（先于参数）→ 参数（422）→ 对象存在且在范围内（404，整批）→ 与当前值相同（422）→ 广告账户编号（409）
//   → 动作守卫（权限、广告连接、动作开关与来源开关，409/403，整批）→ 事务内建写入记录与同步任务并写审计 → 提交后登记流程并入队。
// 整批全有或全无地受理；亚马逊的调用在后台任务里逐项进行，各项成败独立，结果看写入记录的状态。
@Injectable()
export class AdsWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly switches: IntegrationSwitchPort,
    private readonly audit: AuditWriter,
    private readonly workflow: WorkflowService,
    private readonly queue: QueueService,
    private readonly connections: ConnectionsService,
    private readonly resolver: AdsWriteResolver,
  ) {}

  // enforce：提交时每类写入的权限都要有（先于参数校验）；预览只要 ads.read，有没有写权限在响应里说明。
  private async prepare(req: RequestWithContext, rawBody: unknown, options: SubmitOptions, enforce: boolean) {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, {})
    if (enforce) for (const permission of permissionsOfKinds(kindsOf(rawBody))) await this.context.authorize(req, permission)
    const body = AdsWriteBatchBodySchema.parse(rawBody)
    const wrong = body.ops.findIndex(op => !options.allow(op.kind))
    if (wrong >= 0) throw appError('VALIDATION_FAILED', `第 ${wrong + 1} 项的修改类型不能用在这个入口`, { fieldErrors: { ops: [`第 ${wrong + 1} 项的修改类型不能用在这个入口`] } })
    const resolved = await this.resolver.resolve(context.tenantId, scope, body.ops as AdsWriteOp[])
    return { context, resolved }
  }

  private blockerOf(item: ResolvedWrite): string | null {
    if (!item.target) return item.blocker
    const after = adsWriteAfterText(item.op)
    if (COMPARABLE.includes(item.op.kind) && sameValue(item.target.before, after)) return '与当前值相同，无需修改'
    if (!item.target.adsAccountId) return '广告档案还没有发现统一接口的广告账户编号，暂时不能写入'
    return null
  }

  /** 统一的写前预览：只读本系统数据，不调用亚马逊，不写任何记录。 */
  async preview(req: RequestWithContext, rawBody: unknown): Promise<AdsWritePreviewResponse> {
    const { context, resolved } = await this.prepare(req, rawBody, { allow: () => true }, false)
    const items: AdsWritePreviewItem[] = []
    for (const item of resolved) {
      const blocker = this.blockerOf(item)
      const after = adsWriteAfterText(item.op)
      const before = item.target?.before ?? null
      items.push({
        index: item.index,
        kind: item.op.kind,
        kindLabel: ADS_WRITE_KIND_INFO[item.op.kind].label,
        entityId: item.op.entityId,
        entityLabel: item.target?.label ?? null,
        blocker,
        before,
        after,
        changePercent: ['CAMPAIGN_BUDGET', 'AD_GROUP_BID', 'TARGET_BID'].includes(item.op.kind) ? adsChangePercent(before, after) : null,
        warnings: adsWriteWarnings(item.op, before),
        forecast: item.op.kind === 'CAMPAIGN_BUDGET' && item.target ? await this.forecastOf(context.tenantId, item.target.adsProfileId, item.target.externalId, item.op.amount ?? 0) : null,
      })
    }
    const keys = resolved.flatMap(item => adsWriteSwitches(item.op.kind, 'MANUAL'))
    const switches = await switchViews(this.switches, context.tenantId, keys)
    const connection = await this.connections.authorizedAdsConnection(context.tenantId)
    const permitted = resolved.every(item => hasPermission(context.permissions, ADS_WRITE_KIND_INFO[item.op.kind].permission))
    const reason = (permitted ? null : '当前账号没有执行此操作的权限') ?? items.find(item => item.blocker)?.blocker ?? (connection ? null : '尚未完成亚马逊广告授权，或授权已失效')
    const switchOff = switches.find(view => !view.enabled)
    return {
      items,
      switches,
      permitted,
      canSubmit: permitted && !reason && !switchOff,
      reason: reason ?? switchOff?.reason ?? null,
      note: ADS_WRITE_PREVIEW_NOTE,
    }
  }

  /** 已有的官方活动预测只读本系统的记录（预测的请求入口没有做）；没有针对这个预算的记录就写明原因。 */
  private async forecastOf(tenantId: string, adsProfileId: string, campaignExternalId: string, budget: number): Promise<AdsWritePreviewItem['forecast']> {
    const run = await this.prisma.adsForecastRun.findFirst({
      where: { tenantId, adsProfileId, campaignId: campaignExternalId, requestedBudget: budget },
      select: { requestedAt: true },
      orderBy: { requestedAt: 'desc' },
    })
    if (!run) return { state: 'NO_DATA', note: '没有针对这个预算的官方活动预测记录；预测的请求入口尚未接入，请先在广告后台查看预测', low: null, high: null }
    return { state: 'OK', note: `已有针对这个预算的官方活动预测（${run.requestedAt.toISOString().slice(0, 10)} 请求），明细见活动详情的“预测与推荐”页签`, low: null, high: null }
  }

  async submit(req: RequestWithContext, rawBody: unknown, options: SubmitOptions): Promise<AdsWriteSubmitResponse> {
    const { context, resolved } = await this.prepare(req, rawBody, options, true)
    for (const item of resolved) {
      const blocker = this.blockerOf(item)
      if (!blocker) continue
      const text = `第 ${item.index + 1} 项：${blocker}`
      if (!item.target) throw appError('RESOURCE_NOT_FOUND', text)
      if (!item.target.adsAccountId) throw new AppError(409, 'ADS_ACCOUNT_MISSING', text)
      throw appError('VALIDATION_FAILED', text, { fieldErrors: { ops: [text] } })
    }
    const guarded = new Set<string>()
    for (const item of resolved) {
      const info = ADS_WRITE_KIND_INFO[item.op.kind]
      for (const switchKey of adsWriteSwitches(item.op.kind, 'MANUAL')) {
        const key = `${info.permission}|${switchKey}`
        if (guarded.has(key)) continue
        guarded.add(key)
        await this.guard.assert(context, { permission: info.permission, connection: { provider: 'AMAZON_ADS_API' }, switchKey })
      }
    }
    const connection = await this.connections.authorizedAdsConnection(context.tenantId)
    if (!connection) throw new AppError(409, 'ADS_CONNECTION_REQUIRED', '写入广告前，需要先完成 Amazon Ads 授权')
    const created = await this.prisma.$transaction(async tx => {
      const made: Array<{ runId: string; jobId: string; priority: number }> = []
      for (const item of resolved) {
        const target = item.target!
        const { kind, entityId: _entityId, ...rest } = item.op
        const run = await tx.adsWriteRun.create({
          data: {
            tenantId: context.tenantId,
            adsProfileId: target.adsProfileId,
            kind,
            source: 'MANUAL',
            entityType: target.entityType,
            entityId: target.entityId,
            externalId: target.externalId,
            entityLabel: target.label.slice(0, 200),
            requestJson: { ...rest, campaignExternalId: target.campaignExternalId, table: target.table } as Prisma.InputJsonValue,
            beforeValue: target.before === null ? null : target.before.slice(0, WRITE_MESSAGE_MAX),
            afterValue: adsWriteAfterText(item.op).slice(0, WRITE_MESSAGE_MAX),
            status: 'PENDING',
            requestId: req.requestId,
            requestedBy: context.userId,
          },
          select: { id: true },
        })
        const job = await tx.syncJob.create({
          data: {
            tenantId: context.tenantId,
            connectionId: connection.id,
            type: ADS_WRITE_JOB,
            status: 'PENDING',
            requestId: req.requestId,
            context: { adsWriteRunId: run.id },
            ...syncJobMeta(connection.id, ADS_WRITE_JOB, [run.id]),
          },
          select: { id: true, priority: true },
        })
        await tx.adsWriteRun.update({ where: { id: run.id }, data: { syncJobId: job.id } })
        made.push({ runId: run.id, jobId: job.id, priority: job.priority })
      }
      await this.audit.record(
        req,
        {
          action: ADS_WRITE_SUBMITTED_ACTION,
          resourceType: 'AdsWriteRun',
          resourceId: made[0]?.runId ?? null,
          after: {
            count: made.length,
            items: resolved.slice(0, 20).map(item => ({ kind: item.op.kind, entityId: item.op.entityId, before: item.target?.before ?? null, after: adsWriteAfterText(item.op) })),
            ...options.audit,
          },
        },
        { client: tx },
      )
      return made
    })
    for (const made of created) await this.dispatch(req, context.tenantId, connection.id, made)
    const rows = await this.prisma.adsWriteRun.findMany({
      where: { tenantId: context.tenantId, id: { in: created.map(made => made.runId) } },
      select: RUN_SELECT,
      orderBy: { id: 'asc' },
      take: created.length,
    })
    const order = new Map(created.map((made, index) => [made.runId, index]))
    return { runs: rows.map(runRowOf).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)), state: 'QUEUED' }
  }

  /** 提交之后登记流程并入队；入队失败时这一项标为失败（用户可以重新提交），不影响同批其他项。 */
  private async dispatch(req: RequestWithContext, tenantId: string, connectionId: string, made: { runId: string; jobId: string; priority: number }) {
    try {
      await this.workflow.registerWriteRun(req, {
        tenantId,
        kind: WORKFLOW_KINDS.ADS_WRITE,
        dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.ADS_WRITE, made.runId, made.jobId),
        intent: { tenantId, connectionId, adsWriteRunId: made.runId } satisfies WriteRunIntent,
        syncJobId: made.jobId,
        priority: made.priority,
      })
      await this.queue.add('sync', { tenantId, syncJobId: made.jobId, requestId: req.requestId, adsWriteRunId: made.runId }, made.jobId, { type: ADS_WRITE_JOB, priority: made.priority })
    } catch {
      const now = new Date()
      await this.prisma.adsWriteRun.updateMany({ where: { id: made.runId, tenantId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      await this.prisma.syncJob.updateMany({ where: { id: made.jobId, tenantId }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
    }
  }
}
