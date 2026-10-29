import { Injectable } from '@nestjs/common'
import {
  APLUS_BASIS,
  APLUS_FRESHNESS_KEY,
  APLUS_LIMITS,
  APLUS_READ,
  APLUS_ROLE_MISSING,
  APLUS_RUN_STATUS_LABEL,
  APLUS_STATUSES,
  APLUS_UPLOAD_TYPES,
  AplusListQuerySchema,
  AplusUploadsQuerySchema,
  aplusFailureText,
  type AplusListResponse,
  type AplusRunStatus,
  type AplusSectionState,
  type AplusStatus,
  type AplusSummary,
  type AplusUploadRow,
  type AplusUploadsResponse,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ObjectStorageService } from '../../platform/storage'
import { ActionGuardService } from '../../platform/write'
import { assertStoreInScope, ContextService, storeWhere, type ResolvedScope } from '../auth'
import { sourceFreshness } from '../inventory'
import { pendingRunsOf, rowOf, storesOf, writeStatusOf, BUSY_STATUSES, isRecord } from './aplus-common'
import { decodeOffset, pageOf } from './aplus-cursor'

const NOT_CONNECTED_NOTE = '还没有授权亚马逊卖家连接，授权后每天同步一次 A+ 内容'
const NO_DATA_NOTE = '尚无 A+ 内容记录：同步每天一次，需要品牌备案与品牌内容角色；也可以直接新建一份内容'
const NO_ROLE_NOTE = '店铺没有品牌备案或没有获批的 A+ 内容角色，亚马逊不返回内容；备案并获批品牌内容角色后，下一次同步会取到'
const statusRank = (status: string) => APLUS_STATUSES.indexOf(status as AplusStatus)

/**
 * GET /aplus 与 GET /aplus/uploads（05 章 5.8）。顺序：权限（403）→ 校验参数（422）→ 店铺在范围内（403）→ 读数据。
 * 列表一次最多读 listMax 条（多读一行判断是否截断），排序在数据库里完成，翻页用偏移游标（签名并绑定全部条件）；状态汇总不受筛选条件与分页影响，只按店铺收窄。
 */
@Injectable()
export class AplusReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly objects: ObjectStorageService,
  ) {}

  private async summaryOf(tenantId: string, where: Prisma.AplusContentWhereInput, runWhere: Prisma.AplusWriteRunWhereInput): Promise<AplusSummary> {
    const [groups, pending] = await Promise.all([
      this.prisma.aplusContent.groupBy({ by: ['status'], where, _count: { _all: true }, orderBy: { status: 'asc' }, take: 20 }),
      this.prisma.aplusWriteRun.groupBy({
        by: ['contentId'],
        where: { ...runWhere, tenantId, contentId: { not: null }, status: { in: [...BUSY_STATUSES] } },
        orderBy: { contentId: 'asc' },
        take: APLUS_LIMITS.listMax,
      }),
    ])
    const byStatus = Object.fromEntries(APLUS_STATUSES.map(status => [status, 0])) as Record<AplusStatus, number>
    for (const group of groups) if (group.status in byStatus) byStatus[group.status as AplusStatus] = group._count._all
    return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus, pending: pending.length }
  }

  /** 没有内容时的说明：连接的店铺都缺品牌内容角色就写前提，否则写通用说明。 */
  private async noDataNote(tenantId: string, scope: ResolvedScope, connected: readonly string[]): Promise<string> {
    const rows = await this.prisma.dataFreshness.findMany({
      where: { tenantId, sourceKey: APLUS_FRESHNESS_KEY, ...storeWhere(scope) },
      select: { sellerAccountId: true, lastErrorCode: true },
      take: 1000,
    })
    const missing = new Set(rows.filter(row => row.lastErrorCode === APLUS_ROLE_MISSING).map(row => row.sellerAccountId))
    return connected.length > 0 && connected.every(id => missing.has(id)) ? NO_ROLE_NOTE : NO_DATA_NOTE
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<AplusListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_READ, rawQuery)
    const query = AplusListQuerySchema.parse(rawQuery)
    if (query.storeId) assertStoreInScope(scope, query.storeId)
    const tenantId = context.tenantId
    const storeFilter = query.storeId ? { sellerAccountId: query.storeId } : {}
    const base: Prisma.AplusContentWhereInput = { tenantId, ...storeWhere(scope), ...storeFilter }
    const where: Prisma.AplusContentWhereInput = {
      ...base,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q?.trim() ? { name: { contains: query.q.trim(), mode: 'insensitive' } } : {}),
      ...(query.asin?.trim() ? { asinRelations: { some: { tenantId, asin: query.asin.trim().toUpperCase() } } } : {}),
    }
    const orderBy = [{ [query.sort.field]: query.sort.dir }, { id: 'asc' }] as Prisma.AplusContentOrderByWithRelationInput[]
    const [found, stores, summary, connections, freshness, write] = await Promise.all([
      this.prisma.aplusContent.findMany({ where, orderBy, take: APLUS_LIMITS.listMax + 1 }),
      storesOf(this.prisma, tenantId, scope),
      this.summaryOf(tenantId, base, { ...storeWhere(scope), ...storeFilter }),
      this.prisma.platformConnection.findMany({
        where: { tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null }, ...storeWhere(scope), ...(query.storeId ? { sellerAccountId: query.storeId } : {}) },
        select: { sellerAccountId: true },
        take: 500,
      }),
      sourceFreshness(this.prisma, tenantId, scope, [APLUS_FRESHNESS_KEY], now),
      writeStatusOf(this.guard, context),
    ])
    const truncated = found.length > APLUS_LIMITS.listMax
    const rows = found.slice(0, APLUS_LIMITS.listMax)
    // 状态按生命周期顺序（草稿 → 已提交 → 已批准 → 被拒 → 已发布）排，而不是字母顺序；同状态保持数据库给出的先后
    if (query.sort.field === 'status') {
      const sign = query.sort.dir === 'desc' ? -1 : 1
      rows.sort((a, b) => sign * (statusRank(a.status) - statusRank(b.status)))
    }
    const binding = bindingOf(tenantId, query)
    const { page, pageInfo } = pageOf(rows, decodeOffset(query.cursor, binding), query.pageSize, binding)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const pending = await pendingRunsOf(
      this.prisma,
      tenantId,
      page.map(row => row.id),
    )
    const connected = [...new Set(connections.map(row => row.sellerAccountId).filter((id): id is string => id !== null))]
    const state: AplusSectionState = connected.length === 0 ? 'NOT_CONNECTED' : summary.total === 0 ? 'NO_DATA' : 'OK'
    const note = state === 'NOT_CONNECTED' ? NOT_CONNECTED_NOTE : state === 'NO_DATA' ? await this.noDataNote(tenantId, scope, connected) : null
    return {
      state,
      note,
      items: page.map(row => rowOf(row, names.get(row.sellerAccountId) ?? '', pending.get(row.id) ?? null)),
      pageInfo,
      summary,
      stores,
      freshness,
      write,
      truncated,
      basis: APLUS_BASIS,
    }
  }

  /** GET /aplus/uploads：图片库，最近的上传记录（kind = UPLOAD 的写入记录）。 */
  async uploads(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AplusUploadsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, APLUS_READ, {})
    const query = AplusUploadsQuerySchema.parse(rawQuery)
    if (query.storeId) assertStoreInScope(scope, query.storeId)
    const tenantId = context.tenantId
    const [rows, stores, write] = await Promise.all([
      this.prisma.aplusWriteRun.findMany({
        where: { tenantId, kind: 'UPLOAD', ...storeWhere(scope), ...(query.storeId ? { sellerAccountId: query.storeId } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: APLUS_LIMITS.uploadsShown,
      }),
      storesOf(this.prisma, tenantId, scope),
      writeStatusOf(this.guard, context),
    ])
    const users = await memberNames(
      this.prisma,
      tenantId,
      rows.map(row => row.requestedBy),
    )
    const names = new Map(stores.map(store => [store.id, store.name]))
    const items: AplusUploadRow[] = []
    for (const run of rows) {
      const request = isRecord(run.requestJson) ? run.requestJson : {}
      const { fileName, contentType, sizeBytes, width, height } = request
      // 请求内容缺字段的记录（只可能是手工改库造成的）不展示，不拿默认值冒充
      if (typeof fileName !== 'string' || typeof contentType !== 'string' || typeof sizeBytes !== 'number' || typeof width !== 'number' || typeof height !== 'number') continue
      const result = isRecord(run.resultJson) ? run.resultJson : {}
      const status = run.status as AplusRunStatus
      items.push({
        id: run.id,
        storeId: run.sellerAccountId,
        storeName: names.get(run.sellerAccountId) ?? '',
        fileName,
        contentType,
        sizeBytes,
        width,
        height,
        status,
        statusLabel: APLUS_RUN_STATUS_LABEL[status] ?? run.status,
        uploadDestinationId: typeof result.uploadDestinationId === 'string' ? result.uploadDestinationId : null,
        failureCode: run.failureCode,
        failureText: aplusFailureText(run.failureCode),
        createdAt: run.createdAt.toISOString(),
        requestedBy: run.requestedBy ? nameOrFormer(users, run.requestedBy) : null,
      })
    }
    return { items, stores, write, maxBytes: Math.min(APLUS_LIMITS.imageMaxBytes, this.objects.maxUploadBytes()), types: APLUS_UPLOAD_TYPES }
  }
}
