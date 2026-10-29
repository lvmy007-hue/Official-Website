import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  REPORT_CATALOG,
  REPORT_DOMAINS,
  REPORT_LIST_WINDOW_MAX,
  REPORT_READ,
  REPORT_STATUSES,
  ReportCenterListQuerySchema,
  reportTypesOfDomain,
  type ReportDomain,
  type ReportListResponse,
  type ReportRow,
  type ReportSource,
  type ReportStatus,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsRelationWhere, connectionWhere, ContextService, storeWhere, type ResolvedScope } from '../auth'
import { ADS_SELECT, adsRowOf, FBA_SELECT, KIOSK_SELECT, kioskRowOf, kioskStoreNames, reportStatusOf, spRowsOf, syncStatusOf, type AdsRecord, type FbaRecord, type KioskRecord } from './reports-common'
import { decodeOffset, pageInfoAt } from './reports-page'

const NOTE_NONE = '尚无记录：还没有创建过报告任务。可以点“创建报告任务”向亚马逊申请，广告报告在广告报表页创建，数据中心查询由系统定时发起。'
const NOTE_FILTERED = '没有符合筛选条件的报告任务；可以放宽筛选条件'
const SP_DOMAINS: readonly ReportDomain[] = ['LOGISTICS', 'BUSINESS', 'BRAND', 'FINANCE']
const KIOSK_TYPE = 'DATA_KIOSK_QUERY'
// 报表中心状态 → 数据中心查询（同步任务）的状态
const KIOSK_STATUS: Record<ReportStatus, string[]> = { PENDING: ['PENDING'], GENERATING: ['RUNNING'], READY: ['SUCCEEDED'], FAILED: ['FAILED_PERMANENT'], CANCELLED: [] }

type Query = ReturnType<typeof ReportCenterListQuerySchema.parse>
type Tagged = { at: number; id: string } & ({ kind: 'sp'; record: FbaRecord } | { kind: 'ads'; record: AdsRecord } | { kind: 'kiosk'; record: KioskRecord })

const emptyCounts = () => Object.fromEntries(REPORT_STATUSES.map(status => [status, 0])) as Record<ReportStatus, number>

/** 哪些来源参与：业务域与来源筛选取交集。 */
function includedSources(query: Query): Record<ReportSource, boolean> {
  const byDomain = (source: ReportSource) => !query.domain || (source === 'SP_API' ? SP_DOMAINS.includes(query.domain) : source === 'ADS' ? query.domain === 'ADS' : query.domain === 'DATA_CENTER')
  return {
    SP_API: byDomain('SP_API') && (!query.source || query.source === 'SP_API'),
    ADS: byDomain('ADS') && (!query.source || query.source === 'ADS'),
    DATA_KIOSK: byDomain('DATA_KIOSK') && (!query.source || query.source === 'DATA_KIOSK'),
  }
}

// 报表中心列表（09 章 9.3；freeze/api.md GET /reports）：把亚马逊报告、广告报告、数据中心查询合并成一张表，按创建时间排序。
// 每个来源各读“已翻过的位置 + 一页 + 1”条再合并，最多读 REPORT_LIST_WINDOW_MAX 条（再早的任务不合并，响应里 truncated 说明）；各状态条数、各业务域条数在数据库里分组统计。
@Injectable()
export class ReportsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now: Date = new Date()): Promise<ReportListResponse> {
    // 权限与范围先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, REPORT_READ, rawQuery)
    const query = ReportCenterListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const use = includedSources(query)
    const filter = { tenantId, scope, query }

    const [counts, domainCounts, tagged] = await Promise.all([this.statusCounts(filter, use), this.domainCounts(filter), this.window(filter, use, offset)])
    const total = query.status ? counts[query.status] : REPORT_STATUSES.reduce((sum, status) => sum + counts[status], 0)
    const reachable = Math.min(total, REPORT_LIST_WINDOW_MAX)
    const pageEnd = Math.min(offset + query.pageSize, REPORT_LIST_WINDOW_MAX)
    const page = tagged.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : query.sort.dir === 'desc' ? b.at - a.at : a.at - b.at)).slice(offset, pageEnd)
    const items = await this.rowsOf(tenantId, page, now)
    const filtered = Boolean(query.q || query.domain || query.status || query.source)
    return {
      state: total > 0 ? 'OK' : 'NO_DATA',
      note: total > 0 ? null : filtered ? NOTE_FILTERED : NOTE_NONE,
      items,
      pageInfo: pageInfoAt(offset, items.length, reachable, total, query.pageSize, binding),
      counts,
      domainCounts,
      truncated: total > REPORT_LIST_WINDOW_MAX,
    }
  }

  // ---- 条件 ----

  private matchedKeys(source: ReportSource, q: string): string[] {
    const needle = q.toLowerCase()
    return REPORT_CATALOG.filter(item => item.source === source && (item.key.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle))).map(item => item.key)
  }

  private spWhere(f: Filter, withStatus: boolean, withDomain: boolean): Prisma.FbaReportJobWhereInput {
    const { tenantId, scope, query } = f
    const and: Prisma.FbaReportJobWhereInput[] = []
    if (withDomain && query.domain && SP_DOMAINS.includes(query.domain)) and.push({ reportType: { in: reportTypesOfDomain(query.domain) } })
    if (query.q) and.push({ OR: [{ reportType: { contains: query.q, mode: 'insensitive' } }, { reportType: { in: this.matchedKeys('SP_API', query.q) } }] })
    return { tenantId, ...storeWhere(scope), ...(withStatus && query.status ? { status: query.status } : {}), ...(and.length > 0 ? { AND: and } : {}) }
  }

  private adsWhere(f: Filter, withStatus: boolean): Prisma.AdsReportJobWhereInput {
    const { tenantId, scope, query } = f
    const keys = query.q ? this.matchedKeys('ADS', query.q) : []
    return {
      tenantId,
      ...adsRelationWhere(scope),
      ...(withStatus && query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ reportType: { contains: query.q, mode: 'insensitive' } }, { templateKey: { in: keys } }] } : {}),
    }
  }

  private kioskWhere(f: Filter, withStatus: boolean): Prisma.SyncJobWhereInput {
    const { tenantId, scope, query } = f
    const keys = query.q ? this.matchedKeys('DATA_KIOSK', query.q) : []
    return {
      tenantId,
      type: KIOSK_TYPE,
      connection: connectionWhere(scope),
      ...(withStatus && query.status ? { status: { in: KIOSK_STATUS[query.status] } } : {}),
      ...(query.q ? { OR: keys.length > 0 ? keys.map(key => ({ context: { path: ['dataset'], equals: key } })) : [{ id: { in: [] } }] } : {}),
    }
  }

  // ---- 统计 ----

  /** 各状态条数：受业务域、来源、搜索词影响，不受状态筛选影响。 */
  private async statusCounts(f: Filter, use: Record<ReportSource, boolean>): Promise<Record<ReportStatus, number>> {
    const counts = emptyCounts()
    const [sp, ads, kiosk] = await Promise.all([
      use.SP_API ? this.prisma.fbaReportJob.groupBy({ by: ['status'], where: this.spWhere(f, false, true), _count: { _all: true }, orderBy: { status: 'asc' } }) : [],
      use.ADS ? this.prisma.adsReportJob.groupBy({ by: ['status'], where: this.adsWhere(f, false), _count: { _all: true }, orderBy: { status: 'asc' } }) : [],
      use.DATA_KIOSK ? this.prisma.syncJob.groupBy({ by: ['status'], where: this.kioskWhere(f, false), _count: { _all: true }, orderBy: { status: 'asc' } }) : [],
    ])
    for (const group of sp) counts[reportStatusOf(group.status)] += group._count._all
    for (const group of ads) counts[reportStatusOf(group.status)] += group._count._all
    for (const group of kiosk) counts[syncStatusOf(group.status)] += group._count._all
    return counts
  }

  /** 各业务域条数：受状态、来源、搜索词影响，不受业务域筛选影响；目录里没有的历史类型不计入任何业务域。 */
  private async domainCounts(f: Filter): Promise<Record<ReportDomain, number>> {
    const counts = Object.fromEntries(REPORT_DOMAINS.map(domain => [domain, 0])) as Record<ReportDomain, number>
    const open = { ...f, query: { ...f.query, domain: undefined } }
    const useOpen = includedSources(open.query)
    const [sp, ads, kiosk] = await Promise.all([
      useOpen.SP_API ? this.prisma.fbaReportJob.groupBy({ by: ['reportType'], where: this.spWhere(open, true, false), _count: { _all: true }, orderBy: { reportType: 'asc' } }) : [],
      useOpen.ADS ? this.prisma.adsReportJob.count({ where: this.adsWhere(open, true) }) : 0,
      useOpen.DATA_KIOSK ? this.prisma.syncJob.count({ where: this.kioskWhere(open, true) }) : 0,
    ])
    for (const group of sp) {
      const domain = REPORT_CATALOG.find(item => item.source === 'SP_API' && item.key === group.reportType)?.domain
      if (domain) counts[domain] += group._count._all
    }
    counts.ADS += ads
    counts.DATA_CENTER += kiosk
    return counts
  }

  // ---- 行 ----

  /** 各来源最前面的 offset + pageSize + 1 条（上限为读取窗口）。 */
  private async window(f: Filter, use: Record<ReportSource, boolean>, offset: number): Promise<Tagged[]> {
    const take = Math.min(offset + f.query.pageSize + 1, REPORT_LIST_WINDOW_MAX)
    const orderBy = [{ createdAt: f.query.sort.dir }, { id: 'asc' as const }]
    const [sp, ads, kiosk] = await Promise.all([
      use.SP_API ? this.prisma.fbaReportJob.findMany({ where: this.spWhere(f, true, true), select: FBA_SELECT, orderBy, take }) : [],
      use.ADS ? this.prisma.adsReportJob.findMany({ where: this.adsWhere(f, true), select: ADS_SELECT, orderBy, take }) : [],
      use.DATA_KIOSK ? this.prisma.syncJob.findMany({ where: this.kioskWhere(f, true), select: KIOSK_SELECT, orderBy, take }) : [],
    ])
    return [
      ...sp.map((record): Tagged => ({ kind: 'sp', record, id: record.id, at: record.createdAt.getTime() })),
      ...ads.map((record): Tagged => ({ kind: 'ads', record, id: record.id, at: record.createdAt.getTime() })),
      ...kiosk.map((record): Tagged => ({ kind: 'kiosk', record, id: record.id, at: record.createdAt.getTime() })),
    ]
  }

  private async rowsOf(tenantId: string, page: readonly Tagged[], now: Date): Promise<ReportRow[]> {
    const sp = page.flatMap(item => (item.kind === 'sp' ? [item.record] : []))
    const ads = page.flatMap(item => (item.kind === 'ads' ? [item.record] : []))
    const kiosk = page.flatMap(item => (item.kind === 'kiosk' ? [item.record] : []))
    const [spRows, people, storeNames] = await Promise.all([
      spRowsOf(this.prisma, tenantId, sp, now),
      memberNames(
        this.prisma,
        tenantId,
        ads.map(job => job.requestedBy),
      ),
      kioskStoreNames(this.prisma, tenantId, kiosk),
    ])
    const byId = new Map<string, ReportRow>([...spRows, ...ads.map(job => adsRowOf(job, people)), ...kiosk.map(job => kioskRowOf(job, storeNames))].map(row => [row.id, row]))
    return page.flatMap(item => byId.get(item.id) ?? [])
  }
}

interface Filter {
  tenantId: string
  scope: ResolvedScope
  query: Query
}
