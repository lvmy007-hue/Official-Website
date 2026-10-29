import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  ADS_READ,
  ADS_REPORT_HISTORY_NOTE,
  ADS_REPORT_STATUSES,
  ADS_REPORT_TEMPLATES,
  AdsReportListQuerySchema,
  type AdsReportListResponse,
  type AdsReportProfileOption,
  type AdsReportStatus,
  type AdsReportTemplatesResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsProfileWhere, adsRelationWhere, ContextService } from '../auth'
import { ConnectionsService } from '../connections'
import { enterpriseToday, profileRefOf, REPORT_SELECT, reportRowOf } from './ads-reports-common'
import { decodeOffset, pageInfoAt } from './ads-page'

const NOTE_NONE = '还没有创建过广告报告任务：可以在“模板库”里选一个模板创建，或用“补历史数据”一次取回最近两年的活动日报'
const NOTE_FILTERED = '没有符合筛选条件的报告任务；可以放宽筛选条件'
const PROFILE_OPTION_MAX = 200
const NOT_READY_NO_ACCOUNT = '这个广告档案还没有发现统一接口的广告账户编号，暂时不能使用新报告接口'
const NOT_READY_NO_CONNECTION = '还没有完成亚马逊广告授权，暂时不能创建报告任务'

// 广告报表（P3-15，08 章 8.12；freeze/api.md /ads/reports、/ads/report-templates）：报告任务列表与模板库，只读（创建、重试、回补在写服务里）。
// 列表同时列出新报告接口（V1）与旧版接口（LEGACY）的任务，旧版任务不能重试。范围走广告档案绑定的店铺（`adsRelationWhere`）。
@Injectable()
export class AdsReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly connections: ConnectionsService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsReportListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsReportListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const base: Prisma.AdsReportJobWhereInput = {
      tenantId,
      ...adsRelationWhere(scope),
      ...(query.source ? { source: query.source } : {}),
      ...(query.templateKey ? { templateKey: query.templateKey } : {}),
      ...(query.adsProfileId ? { adsProfileId: query.adsProfileId } : {}),
    }
    const where: Prisma.AdsReportJobWhereInput = query.status ? { ...base, status: query.status } : base
    const [grouped, rows] = await Promise.all([
      this.prisma.adsReportJob.groupBy({ by: ['status'], where: base, _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.adsReportJob.findMany({ where, select: REPORT_SELECT, orderBy: [{ createdAt: query.sort.dir }, { id: 'asc' }], skip: offset, take: query.pageSize }),
    ])
    const counts = Object.fromEntries(ADS_REPORT_STATUSES.map(status => [status, 0])) as Record<AdsReportStatus, number>
    for (const group of grouped) if (group.status in counts) counts[group.status as AdsReportStatus] = group._count._all
    const total = query.status ? counts[query.status] : ADS_REPORT_STATUSES.reduce((sum, status) => sum + counts[status], 0)
    const [people, retriedRows] = await Promise.all([
      memberNames(
        this.prisma,
        tenantId,
        rows.map(row => row.requestedBy),
      ),
      rows.length > 0 ? this.prisma.adsReportJob.findMany({ where: { tenantId, retryOfId: { in: rows.map(row => row.id) } }, select: { retryOfId: true }, take: rows.length }) : Promise.resolve([]),
    ])
    const retried = new Set(retriedRows.flatMap(row => (row.retryOfId ? [row.retryOfId] : [])))
    const filtered = Boolean(query.status || query.source || query.templateKey || query.adsProfileId)
    return {
      state: total > 0 ? 'OK' : 'NO_DATA',
      note: total > 0 ? null : filtered ? NOTE_FILTERED : NOTE_NONE,
      items: rows.map(row => reportRowOf(row, people, retried)),
      counts,
      pageInfo: pageInfoAt(offset, rows.length, total, query.pageSize, binding),
    }
  }

  async templates(req: RequestWithContext, rawQuery: Record<string, string> = {}): Promise<AdsReportTemplatesResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const tenantId = context.tenantId
    const [profiles, connection, today] = await Promise.all([
      this.prisma.adsProfile.findMany({
        where: { tenantId, ...adsProfileWhere(scope) },
        select: { id: true, displayName: true, profileId: true, adsAccountId: true, historyFrom: true, historyProbedAt: true, sellerAccount: { select: { displayName: true } } },
        orderBy: [{ profileId: 'asc' }, { id: 'asc' }],
        take: PROFILE_OPTION_MAX,
      }),
      this.connections.authorizedAdsConnection(tenantId),
      enterpriseToday(this.prisma, tenantId),
    ])
    const options: AdsReportProfileOption[] = profiles.map(profile => {
      const ready = Boolean(profile.adsAccountId) && Boolean(connection)
      return {
        ...profileRefOf(profile),
        ready,
        notReadyReason: ready ? null : !connection ? NOT_READY_NO_CONNECTION : NOT_READY_NO_ACCOUNT,
        historyFrom: profile.historyFrom?.toISOString().slice(0, 10) ?? null,
        historyProbedAt: profile.historyProbedAt?.toISOString() ?? null,
      }
    })
    return {
      state: options.length > 0 ? 'OK' : 'NOT_CONNECTED',
      note: options.length > 0 ? null : '还没有同步到广告档案：先完成亚马逊广告授权并同步档案，才能创建报告任务',
      templates: [...ADS_REPORT_TEMPLATES],
      profiles: options,
      historyNote: ADS_REPORT_HISTORY_NOTE,
      today,
    }
  }
}
