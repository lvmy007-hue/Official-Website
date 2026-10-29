import { Injectable } from '@nestjs/common'
import {
  ECONOMICS_PREVIEW_STALE_DAYS,
  ECONOMICS_PREVIEW_FRESHNESS_KEYS,
  ECONOMICS_ROW_LIMIT,
  ECONOMICS_OURS_CURRENCY,
  EconomicsPreviewQuerySchema,
  ScopeSearchSchema,
  type EconomicsPreviewResponse,
  type EconomicsPreviewRow,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { EconomicsAccessService } from './economics-access.service'
import { decodeOffset, pageOf } from './economics-page'
import { PREVIEW_NO_DATA_NOTE, PREVIEW_STALE_NOTE, previewHorizon, previewNotes, previewRowOf, sortPreviewRows, summarizePreview } from './economics-preview-view'

const TRUNCATED_NOTE = '费用预览行数超过读取上限，列表不完整，请按费用类型或 SKU 过滤'

// 费用预览（07 章 7.10 第 2 个页签）：每个店铺只看最近一次查询的结果（超过 3 天没更新的不展示），按费用类型汇总预估金额与调整影响。
@Injectable()
export class EconomicsPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EconomicsAccessService,
  ) {}

  async preview(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<EconomicsPreviewResponse> {
    const access = await this.access.resolve(req, rawQuery, { fields: false, now })
    const query = EconomicsPreviewQuerySchema.parse({ changedOnly: rawQuery.changedOnly, feeType: rawQuery.feeType, q: rawQuery.q, cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { tenantId, scope } = access
    const since = new Date(now.getTime() - ECONOMICS_PREVIEW_STALE_DAYS * 86_400_000)
    const base = { tenantId, ...storeWhere(scope) }
    const [latest, anyRow, stores, freshness] = await Promise.all([
      // 每个店铺最近一次查询的时间（一次查询的所有行带同一个 queriedAt）
      this.prisma.economicsPreview.groupBy({ by: ['sellerAccountId'], where: { ...base, queriedAt: { gte: since } }, _max: { queriedAt: true }, orderBy: { sellerAccountId: 'asc' }, take: 500 }),
      this.prisma.economicsPreview.findFirst({ where: base, select: { id: true } }),
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) }, select: { id: true, displayName: true }, take: 500 }),
      sourceFreshness(this.prisma, tenantId, scope, ECONOMICS_PREVIEW_FRESHNESS_KEYS, now),
    ])
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const latestOf = latest.flatMap(group => (group._max.queriedAt ? [{ sellerAccountId: group.sellerAccountId, queriedAt: group._max.queriedAt }] : []))
    const rows =
      latestOf.length === 0
        ? []
        : await this.prisma.economicsPreview.findMany({
            where: { tenantId, OR: latestOf },
            orderBy: [{ sellerAccountId: 'asc' }, { msku: 'asc' }, { feeType: 'asc' }, { rangeStart: 'asc' }],
            take: ECONOMICS_ROW_LIMIT + 1,
          })
    const truncated = rows.length > ECONOMICS_ROW_LIMIT
    const keyword = query.q?.toLowerCase()
    const items: EconomicsPreviewRow[] = sortPreviewRows(
      rows
        .slice(0, ECONOMICS_ROW_LIMIT)
        .map(row => previewRowOf(row, names.get(row.sellerAccountId) ?? row.sellerAccountId))
        .filter(
          row =>
            (!query.changedOnly || row.impactState !== 'NO_CHANGE') &&
            (!query.feeType || row.feeType === query.feeType) &&
            (!keyword || row.msku.toLowerCase().includes(keyword) || (row.asin ?? '').toLowerCase().includes(keyword)),
        ),
    )
    const { page, pageInfo } = pageOf(items, offset, query.pageSize, binding)
    const queried = latestOf.map(item => item.queriedAt.getTime())
    const empty = latestOf.length === 0
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? (anyRow ? PREVIEW_STALE_NOTE : PREVIEW_NO_DATA_NOTE) : null,
      currency: ECONOMICS_OURS_CURRENCY,
      queriedAt: queried.length === 0 ? null : new Date(Math.min(...queried)).toISOString(),
      horizon: previewHorizon(items),
      summary: summarizePreview(items),
      items: page,
      pageInfo,
      notes: previewNotes(items, truncated, TRUNCATED_NOTE),
      freshness,
    }
  }
}
