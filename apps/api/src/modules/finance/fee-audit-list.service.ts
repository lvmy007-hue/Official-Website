import { Injectable } from '@nestjs/common'
import {
  FEE_AUDIT_CONVERT,
  FEE_AUDIT_FRESHNESS_KEYS,
  FEE_AUDIT_READ,
  FEE_AUDIT_KINDS,
  FEE_AUDIT_KIND_BASIS,
  FEE_AUDIT_KIND_LABEL,
  FeeAuditQuerySchema,
  SIZE_TIER_CHANGE_DAYS,
  sizeTierChanged,
  type FeeAuditKind,
  type FeeAuditKindSummary,
  type FeeAuditListResponse,
  type SizeTierChangeRow,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { AUDIT_SELECT, auditRow } from './fee-audit-common'

const DAY_MS = 86_400_000
const NO_DATA_NOTE =
  '尚无费用核查结果：需要先有预估配送费与佣金预览报告（每天各一份）作为基准，以及已同步的费用事件与订单；店铺授权并完成这些同步后，后台每 6 小时核查一次。没有基准的 SKU 不显示，也不当作“正常”'
const FILTERED_NOTE = '没有符合条件的核查结果；可以放宽筛选条件'

const sum = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : Number(value.toString()))

// 费用核查列表（07 章 7.6）：只看每个店铺最近一个核查日的结果（旧核查日是历史，不在列表里重复出现），游标分页，按累计差额从大到小。
// 页面顶部的各类汇总不受类别、状态筛选影响，只受成员数据范围影响；近期尺寸分段变化来自基准快照。
@Injectable()
export class FeeAuditListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<FeeAuditListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, FEE_AUDIT_READ, rawQuery)
    const query = FeeAuditQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const store = storeWhere(scope)
    const latest = await this.prisma.feeAudit.groupBy({ by: ['sellerAccountId'], where: { tenantId, ...store }, _max: { snapshotDate: true } })
    const days = latest.flatMap(row => (row._max.snapshotDate ? [{ sellerAccountId: row.sellerAccountId, snapshotDate: row._max.snapshotDate }] : []))
    const base: Prisma.FeeAuditWhereInput = { tenantId, ...store, OR: days.length > 0 ? days : [{ id: '__none__' }] }
    const q = query.q
    const where: Prisma.FeeAuditWhereInput = {
      AND: [
        base,
        query.kind ? { feeKind: query.kind } : {},
        query.status ? { status: query.status } : {},
        q ? { OR: [{ sku: { startsWith: q, mode: 'insensitive' } }, { asin: { startsWith: q.toUpperCase() } }, { shipmentRef: { startsWith: q, mode: 'insensitive' } }] } : {},
      ],
    }
    const binding = bindingOf(tenantId, query)
    const [rows, summary, sizeTierChanges, freshness] = await Promise.all([
      this.prisma.feeAudit.findMany({
        where: { AND: [where, this.cursor.after(query.cursor, query.sort, binding) as Prisma.FeeAuditWhereInput] },
        orderBy: this.cursor.orderBy(query.sort),
        take: query.pageSize + 1,
        select: AUDIT_SELECT,
      }),
      this.summary(base),
      this.sizeTierChanges(tenantId, store, now),
      sourceFreshness(this.prisma, tenantId, scope, FEE_AUDIT_FRESHNESS_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: query.sort, binding })
    const items = page.items.map(auditRow)
    const filtered = Boolean(query.kind || query.status || q)
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : filtered && days.length > 0 ? FILTERED_NOTE : NO_DATA_NOTE,
      items,
      pageInfo: page.pageInfo,
      summary,
      sizeTierChanges,
      snapshotDate: days.length > 0 ? days.map(row => row.snapshotDate.toISOString().slice(0, 10)).sort()[days.length - 1] : null,
      canConvert: hasPermission(context.permissions, FEE_AUDIT_CONVERT),
      freshness,
    }
  }

  /** 各类核查的汇总：对象数、疑似多收对象数、发生次数、按币种分别合计的累计差额。 */
  private async summary(base: Prisma.FeeAuditWhereInput): Promise<FeeAuditKindSummary[]> {
    const [all, suspected] = await Promise.all([
      this.prisma.feeAudit.groupBy({ by: ['feeKind', 'currency'], where: base, _count: { _all: true }, _sum: { occurrences: true, overchargeAmount: true } }),
      this.prisma.feeAudit.groupBy({ by: ['feeKind'], where: { AND: [base, { occurrences: { gt: 0 } }] }, _count: { _all: true } }),
    ])
    return FEE_AUDIT_KINDS.map((kind: FeeAuditKind) => {
      const rows = all.filter(row => row.feeKind === kind)
      return {
        kind,
        label: FEE_AUDIT_KIND_LABEL[kind],
        note: FEE_AUDIT_KIND_BASIS[kind],
        subjects: rows.reduce((total, row) => total + row._count._all, 0),
        suspected: suspected.find(row => row.feeKind === kind)?._count._all ?? 0,
        occurrences: rows.reduce((total, row) => total + (row._sum.occurrences ?? 0), 0),
        overcharge: rows
          .map(row => ({ currency: row.currency, amount: Math.round(sum(row._sum.overchargeAmount) * 100) / 100 }))
          .filter(item => item.amount > 0)
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      }
    })
  }

  /** 最近 14 天尺寸分段变化的 SKU（每个店铺每个 SKU 只列最近一次）。 */
  private async sizeTierChanges(tenantId: string, store: ReturnType<typeof storeWhere>, now: Date): Promise<SizeTierChangeRow[]> {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const rows = await this.prisma.feeBaseline.findMany({
      where: { tenantId, ...store, snapshotDate: { gte: new Date(today - SIZE_TIER_CHANGE_DAYS * DAY_MS) }, sizeTier: { not: null }, prevSizeTier: { not: null } },
      select: { sellerAccountId: true, sku: true, asin: true, snapshotDate: true, sizeTier: true, prevSizeTier: true, sellerAccount: { select: { displayName: true } } },
      orderBy: { snapshotDate: 'desc' },
      take: 5000,
    })
    const seen = new Set<string>()
    const out: SizeTierChangeRow[] = []
    for (const row of rows) {
      if (!row.sizeTier || !row.prevSizeTier || !sizeTierChanged(row.prevSizeTier, row.sizeTier)) continue
      const key = `${row.sellerAccountId}|${row.sku}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        sellerAccountId: row.sellerAccountId,
        storeName: row.sellerAccount.displayName,
        sku: row.sku,
        asin: row.asin || null,
        previousTier: row.prevSizeTier,
        currentTier: row.sizeTier,
        changedOn: row.snapshotDate.toISOString().slice(0, 10),
      })
      if (out.length >= 50) break
    }
    return out
  }
}
