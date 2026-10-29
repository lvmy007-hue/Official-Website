import { Injectable } from '@nestjs/common'
import {
  APLUS_BASIS,
  APLUS_FRESHNESS_KEY,
  APLUS_LIMITS,
  APLUS_READ,
  APLUS_RUN_KIND_LABEL,
  APLUS_RUN_STATUS_LABEL,
  APLUS_STATUS_LABEL,
  BUSINESS_REPORTS_READ,
  aplusActionsOf,
  aplusCompareOf,
  aplusCompareWindows,
  aplusFailureText,
  aplusModulesFromAmazon,
  aplusRejectionOf,
  type AplusAsinRow,
  type AplusDailyPoint,
  type AplusDetailResponse,
  type AplusRunKind,
  type AplusRunRow,
  type AplusRunStatus,
  type AplusStatus,
  type AplusTimelineEvent,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { iso, modulesOf, rowOf, runStateOf, titlesOf, writeStatusOf } from './aplus-common'
import { loadCompareDaily } from './aplus-compare-load'

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/**
 * GET /aplus/:id（05 章 5.8）：模块预览、关联 ASIN、审核时间线、拒绝原因与修复建议、发布前后对照、写入记录与按钮可用性。
 * 顺序：权限（403）→ 按成员店铺范围找内容（范围外与别的企业一律 404）→ 读数据。
 * 发布前后对照需要“分析”权限（analytics.read），没有这个权限时对照是“无权限”（不是整个接口 403）。
 */
@Injectable()
export class AplusDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
  ) {}

  /** 关联 ASIN 在发布日前后窗口内的逐日合计；没有上线时间不查；没有查看销售流量的权限是 RESTRICTED。 */
  private async compareDaily(context: ApiContext, input: { storeId: string; contentId: string; publishedAt: string | null; now: Date }): Promise<readonly AplusDailyPoint[] | null | 'RESTRICTED'> {
    if (!input.publishedAt) return null
    if (!hasPermission([...context.permissions], BUSINESS_REPORTS_READ)) return 'RESTRICTED'
    const relations = await this.prisma.aplusAsinRelation.findMany({
      where: { tenantId: context.tenantId, contentId: input.contentId },
      select: { asin: true },
      orderBy: { asin: 'asc' },
      take: APLUS_LIMITS.listMax,
    })
    if (relations.length === 0) return null
    const windows = aplusCompareWindows(input.publishedAt, input.now)
    const to = windows.after.to > windows.before.to ? windows.after.to : windows.before.to
    return loadCompareDaily(this.prisma, { tenantId: context.tenantId, storeId: input.storeId, asins: relations.map(row => row.asin), from: windows.before.from, to })
  }

  async detail(req: RequestWithContext, id: string, now = new Date()): Promise<AplusDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_READ, {})
    const tenantId = context.tenantId
    const content = await this.prisma.aplusContent.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!content) throw appError('RESOURCE_NOT_FOUND', '内容不存在')
    const storeId = content.sellerAccountId
    const [store, state, relations, events, runs, freshness, write] = await Promise.all([
      this.prisma.sellerAccount.findFirst({ where: { id: storeId, tenantId }, select: { displayName: true } }),
      runStateOf(this.prisma, tenantId, id),
      this.prisma.aplusAsinRelation.findMany({ where: { tenantId, contentId: id }, orderBy: [{ asin: 'asc' }, { id: 'asc' }], take: APLUS_LIMITS.asinsShown + 1 }),
      this.prisma.aplusReviewEvent.findMany({ where: { tenantId, contentId: id }, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }], take: APLUS_LIMITS.timelineMax }),
      this.prisma.aplusWriteRun.findMany({ where: { tenantId, contentId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: APLUS_LIMITS.runsShown }),
      sourceFreshness(this.prisma, tenantId, scope, [APLUS_FRESHNESS_KEY], now),
      writeStatusOf(this.guard, context),
    ])
    const shown = relations.slice(0, APLUS_LIMITS.asinsShown)
    const [titles, users, daily] = await Promise.all([
      titlesOf(
        this.prisma,
        tenantId,
        storeId,
        shown.map(row => row.asin),
      ),
      memberNames(
        this.prisma,
        tenantId,
        runs.map(run => run.requestedBy),
      ),
      this.compareDaily(context, { storeId, contentId: id, publishedAt: iso(content.publishedAt), now }),
    ])
    const status = content.status as AplusStatus
    const item = rowOf(content, store?.displayName ?? '', state.pending)
    const modules = modulesOf(content.draftJson)
    const view = aplusModulesFromAmazon(modules)
    const hasKey = content.contentReferenceKey !== null
    return {
      item,
      modules,
      editable: view.editable,
      editNote: view.note,
      version: content.version,
      asins: shown.map<AplusAsinRow>(row => ({ asin: row.asin, title: titles.get(row.asin) ?? null, publishedAt: iso(row.publishedAt) })),
      asinsTruncated: relations.length > APLUS_LIMITS.asinsShown,
      timeline: events.map<AplusTimelineEvent>(event => ({
        status: event.status as AplusStatus,
        statusLabel: APLUS_STATUS_LABEL[event.status as AplusStatus] ?? event.status,
        message: event.message,
        occurredAt: event.occurredAt.toISOString(),
        source: event.source === 'LOCAL' ? 'LOCAL' : 'SYNC',
      })),
      rejection: aplusRejectionOf(status, content.rejectionReason),
      compare: aplusCompareOf({ status, publishedAt: item.publishedAt, asinCount: content.asinCount, now, daily }),
      runs: runs.map<AplusRunRow>(run => ({
        id: run.id,
        kind: run.kind as AplusRunKind,
        kindLabel: APLUS_RUN_KIND_LABEL[run.kind as AplusRunKind] ?? run.kind,
        status: run.status as AplusRunStatus,
        statusLabel: APLUS_RUN_STATUS_LABEL[run.status as AplusRunStatus] ?? run.status,
        failureCode: run.failureCode,
        failureText: aplusFailureText(run.failureCode),
        warnings: stringList(run.warningsJson),
        requestedBy: run.requestedBy ? nameOrFormer(users, run.requestedBy) : null,
        createdAt: run.createdAt.toISOString(),
        finishedAt: iso(run.finishedAt),
      })),
      write,
      actions: aplusActionsOf({
        status,
        hasKey,
        busy: state.pending !== null,
        asinCount: content.asinCount,
        editable: view.editable,
        editNote: view.note,
        createFailed: !hasKey && state.createFailed,
      }),
      freshness,
      basis: APLUS_BASIS,
    }
  }
}
