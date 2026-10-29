import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  ADS_CHANGE_EXTERNAL_NOTE,
  ADS_CHANGE_SOURCES,
  ADS_CHANGE_WRITE_PENDING,
  ADS_READ,
  AdsChangeListQuerySchema,
  type AdsChangeListResponse,
  type AdsChangeSource,
  type AdsChangeTracking,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { adsProfileWhere, adsRelationWhere, ContextService, type ResolvedScope } from '../auth'
import { addDays, zonedDayStart } from '../overview'
import { rangeOf } from './ads-campaigns-common'
import { CHANGE_SELECT, changeRowOf } from './ads-changes-common'
import { decodeOffset, pageInfoAt } from './ads-page'

const NOTE_EMPTY = '所选范围内没有记录到广告变更：外部变更由定时对比实体快照识别，手动、自动规则与分时策略的变更在广告写入接入后记录'
const NOTE_FILTERED = '没有符合筛选条件的变更记录；可以放宽筛选条件或扩大日期范围'
const NOTE_NO_SNAPSHOT = '还没有拍过实体快照（广告活动、广告组、投放对象等还没有同步入库，或定时对比还没有运行过），外部变更暂时无法识别；同步广告实体之后，每次定时对比发现的改动会记在这里'
const PROFILE_OPTION_MAX = 200

// 广告变更记录列表（P3-14，08 章 8.11；freeze/api.md /ads/changes）：汇总四种来源的广告变更，按发生时间倒序，偏移游标翻页（游标绑定租户与全部查询条件）。
// 只读：变更记录由 worker 对比快照（外部变更）与广告写入（随 P3-17）写入。范围走广告档案绑定的店铺（`adsRelationWhere`），未绑定的档案只有“全部店铺”成员看得到。
@Injectable()
export class AdsChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 快照的新鲜度：范围内最近一次快照的时间；一次都没有就是“尚未接入”。 */
  private async tracking(tenantId: string, scope: ResolvedScope): Promise<AdsChangeTracking> {
    const latest = await this.prisma.adsEntitySnapshot.aggregate({ where: { tenantId, ...adsRelationWhere(scope) }, _max: { snapshotAt: true } })
    const at = latest._max.snapshotAt
    return at
      ? { state: 'OK', lastSnapshotAt: at.toISOString(), note: '外部变更按快照对比识别，最近一次快照的时间如上；两次快照之间的多次改动只能看到最终结果' }
      : { state: 'NOT_CONNECTED', lastSnapshotAt: null, note: NOTE_NO_SNAPSHOT }
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AdsChangeListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ADS_READ, rawQuery)
    const query = AdsChangeListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const { period, defaulted, zone } = await rangeOf(this.prisma, tenantId, { from: query.from, to: query.to })
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)

    const keyword = query.q
    const base: Prisma.AdsChangeLogWhereInput = {
      tenantId,
      ...adsRelationWhere(scope),
      occurredAt: { gte: zonedDayStart(period.from, zone), lt: zonedDayStart(addDays(period.to, 1), zone) },
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.adsProfileId ? { adsProfileId: query.adsProfileId } : {}),
      ...(keyword
        ? { OR: [{ entityLabel: { contains: keyword, mode: 'insensitive' } }, { beforeValue: { contains: keyword, mode: 'insensitive' } }, { afterValue: { contains: keyword, mode: 'insensitive' } }] }
        : {}),
    }
    const where: Prisma.AdsChangeLogWhereInput = query.source ? { ...base, actorKind: query.source } : base
    const [grouped, rows, tracking, profiles] = await Promise.all([
      this.prisma.adsChangeLog.groupBy({ by: ['actorKind'], where: base, _count: { _all: true }, orderBy: { actorKind: 'asc' } }),
      this.prisma.adsChangeLog.findMany({
        where,
        select: CHANGE_SELECT,
        orderBy: [{ occurredAt: query.sort.dir }, { id: 'asc' }],
        skip: offset,
        take: query.pageSize,
      }),
      this.tracking(tenantId, scope),
      this.prisma.adsProfile.findMany({
        where: { tenantId, ...adsProfileWhere(scope) },
        select: { id: true, displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } },
        orderBy: [{ profileId: 'asc' }, { id: 'asc' }],
        take: PROFILE_OPTION_MAX,
      }),
    ])
    const counts = Object.fromEntries(ADS_CHANGE_SOURCES.map(source => [source, 0])) as Record<AdsChangeSource, number>
    for (const group of grouped) if (group.actorKind in counts) counts[group.actorKind as AdsChangeSource] = group._count._all
    const total = query.source ? counts[query.source] : ADS_CHANGE_SOURCES.reduce((sum, source) => sum + counts[source], 0)
    const people = await memberNames(
      this.prisma,
      tenantId,
      rows.map(row => row.actorId),
    )
    const items = rows.map(row => changeRowOf(row, people))
    const filtered = Boolean(query.source || query.entityType || query.adsProfileId || keyword)
    // 一条记录都没有：快照也从没拍过就是“尚未接入”（没法区分“没有变更”与“没在记录”）；拍过了才是“尚无记录”
    const state = total > 0 ? 'OK' : tracking.state === 'NOT_CONNECTED' && !filtered ? 'NOT_CONNECTED' : 'NO_DATA'
    return {
      state,
      note: total > 0 ? null : filtered ? NOTE_FILTERED : tracking.state === 'NOT_CONNECTED' ? NOTE_NO_SNAPSHOT : NOTE_EMPTY,
      period,
      defaulted,
      items,
      counts,
      tracking,
      write: ADS_CHANGE_WRITE_PENDING,
      externalNote: ADS_CHANGE_EXTERNAL_NOTE,
      profiles: profiles.map(row => ({ id: row.id, name: row.displayName ?? row.profileId, storeName: row.sellerAccount?.displayName ?? null })),
      pageInfo: pageInfoAt(offset, items.length, total, query.pageSize, binding),
    }
  }
}
