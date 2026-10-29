import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  SYNC_DATA_DOMAINS,
  SYNC_DOMAIN_AVAILABILITY,
  SYNC_DOMAIN_LABEL,
  SYNC_READ,
  SYNC_STATES,
  SyncJobListQuerySchema,
  syncDataDomainOf,
  syncFailureText,
  syncStateOf,
  type SyncDomainSummary,
  type SyncJobListResponse,
  type SyncState,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { connectionWhere, ContextService } from '../auth'
import { decodeOffset, pageInfoAt } from './sync-page'
import { domainWhere, searchWhere, stateWhere, syncRowOf, SYNC_ROW_SELECT } from './sync-row'

const NOTE_NONE = '尚无记录：还没有同步任务。授权店铺后，系统会按计划创建同步任务；也可以在各数据页点“立即同步”。'
const NOTE_FILTERED = '没有符合筛选条件的同步任务；可以放宽筛选条件'
const SUMMARY_WINDOW_MS = 24 * 3_600_000
const SUMMARY_MAX_ROWS = 5000

type Query = ReturnType<typeof SyncJobListQuerySchema.parse>

// 同步中心的任务列表（09 章 9.8；freeze/api.md GET /sync/jobs）：按创建时间排序，可按数据域、状态、搜索词筛选；
// 响应里带各状态条数（不受状态筛选影响）与各数据域近 24 小时概况（不受任何筛选影响）。
@Injectable()
export class SyncListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now: Date = new Date()): Promise<SyncJobListResponse> {
    // 权限与范围先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, SYNC_READ, rawQuery)
    const query = SyncJobListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const base: Prisma.SyncJobWhereInput = { tenantId, connection: connectionWhere(scope) }
    const open = this.conditions(base, query, false)
    const where = this.conditions(base, query, true)

    const [counts, total, rows, summary] = await Promise.all([
      this.stateCounts(open),
      this.prisma.syncJob.count({ where }),
      this.prisma.syncJob.findMany({ where, select: SYNC_ROW_SELECT, orderBy: [{ createdAt: query.sort.dir }, { id: 'asc' }], skip: offset, take: query.pageSize }),
      this.domainSummaries(base, now),
    ])
    const items = rows.map(syncRowOf)
    const filtered = Boolean(query.q || query.domain || query.state)
    return {
      state: total > 0 ? 'OK' : 'NO_DATA',
      note: total > 0 ? null : filtered ? NOTE_FILTERED : NOTE_NONE,
      items,
      pageInfo: pageInfoAt(offset, items.length, total, query.pageSize, binding),
      counts,
      domains: summary.domains,
      summaryTruncated: summary.truncated,
    }
  }

  /** 条件：数据域与搜索词；withState 为真时再加状态筛选（各状态条数不带状态筛选）。 */
  private conditions(base: Prisma.SyncJobWhereInput, query: Query, withState: boolean): Prisma.SyncJobWhereInput {
    const and: Prisma.SyncJobWhereInput[] = []
    if (query.domain) and.push(domainWhere(query.domain))
    if (query.q) and.push(searchWhere(query.q))
    if (withState && query.state) and.push(stateWhere(query.state))
    return and.length > 0 ? { ...base, AND: and } : base
  }

  private async stateCounts(open: Prisma.SyncJobWhereInput): Promise<Record<SyncState, number>> {
    const entries = await Promise.all(SYNC_STATES.map(async state => [state, await this.prisma.syncJob.count({ where: { AND: [open, stateWhere(state)] } })] as const))
    return Object.fromEntries(entries) as Record<SyncState, number>
  }

  /** 各数据域近 24 小时的概况：最多读 5000 个任务（超过时说明被截断），在内存里按数据域归并。 */
  private async domainSummaries(base: Prisma.SyncJobWhereInput, now: Date): Promise<{ domains: SyncDomainSummary[]; truncated: boolean }> {
    const jobs = await this.prisma.syncJob.findMany({
      where: { ...base, createdAt: { gte: new Date(now.getTime() - SUMMARY_WINDOW_MS) } },
      select: { type: true, status: true, attempts: true, failureCode: true, context: true, finishedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: SUMMARY_MAX_ROWS + 1,
    })
    const truncated = jobs.length > SUMMARY_MAX_ROWS
    const domains = SYNC_DATA_DOMAINS.map((domain): SyncDomainSummary => {
      const mine = jobs.slice(0, SUMMARY_MAX_ROWS).filter(job => syncDataDomainOf(job.type, job.context) === domain)
      const states = mine.map(job => ({ job, state: syncStateOf(job) }))
      const finishedTimes = states.flatMap(item => (item.state === 'SUCCEEDED' && item.job.finishedAt ? [item.job.finishedAt.getTime()] : []))
      const lastSuccess = finishedTimes.length > 0 ? new Date(Math.max(...finishedTimes)) : null
      const lastFailure = states.find(item => item.state === 'FAILED') // 按创建时间倒序，第一条就是最近的失败
      const availability = SYNC_DOMAIN_AVAILABILITY[domain]
      return {
        domain,
        label: SYNC_DOMAIN_LABEL[domain],
        availability: availability.availability,
        note: availability.note,
        succeeded: states.filter(item => item.state === 'SUCCEEDED').length,
        failed: states.filter(item => item.state === 'FAILED').length,
        active: states.filter(item => item.state !== 'SUCCEEDED' && item.state !== 'FAILED').length,
        hasJobs: mine.length > 0,
        lastSuccessAt: lastSuccess?.toISOString() ?? null,
        lastFailureText: syncFailureText(lastFailure?.job.failureCode),
      }
    })
    return { domains, truncated }
  }
}
