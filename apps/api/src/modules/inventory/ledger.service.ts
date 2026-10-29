import { Injectable } from '@nestjs/common'
import {
  classifyLedgerEvent,
  LEDGER_ADJUSTMENT_LABEL,
  LEDGER_EVENT_GROUP_LABEL,
  LEDGER_GROUP_KEYWORDS,
  LedgerDetailQuerySchema,
  LedgerSummaryQuerySchema,
  type LedgerDetailQuery,
  type LedgerDetailResponse,
  type LedgerEventGroup,
  type LedgerResponse,
  type LedgerSummaryResponse,
  type LedgerSummaryRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { LEDGER_KEYS, sourceFreshness } from './inventory-freshness'
import { ledgerReferenceKind } from './inventory-detail-math'
import { foldLedgerSummary, latestMonthKeys } from './ledger-math'
import { previousMonths } from './inventory-health.service'
import { InventoryPolicyService } from './inventory-policy.service'

const PERMISSION = 'inventory.read'
const SUMMARY_TAKE = 20_000
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (date: Date) => date.toISOString().slice(0, 10)

/** 数据库里按“包含”匹配事件类型：报告里的写法可能带空格或下划线，所以每个关键字多列几种写法。 */
const DB_WORDS: Record<Exclude<LedgerEventGroup, 'other'>, readonly string[]> = {
  ...LEDGER_GROUP_KEYWORDS,
  customerReturn: ['customerreturn', 'customer return', 'customer_return'],
  vendorReturn: ['vendorreturn', 'vendor return', 'vendor_return'],
}
const contains = (words: readonly string[]): Prisma.InventoryLedgerEntryWhereInput[] => words.map(word => ({ eventType: { contains: word, mode: 'insensitive' } }))

export function groupWhere(group: LedgerEventGroup): Prisma.InventoryLedgerEntryWhereInput {
  if (group !== 'other') return { OR: contains(DB_WORDS[group]) }
  return { NOT: { OR: Object.values(DB_WORDS).flatMap(words => contains(words)) } }
}

// 库存台账（06 章 6.4）：汇总（店铺 × FNSKU × 月，带“期初 + 变动 = 期末”平衡校验与库存接口比对）与明细（逐条流水，游标分页）。
// 平衡校验不通过的行只标记、不改数据；预警与赔付机会不在本包生成（见 CR-032）。
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly policies: InventoryPolicyService,
    private readonly cursor: CursorService,
  ) {}

  async ledger(req: RequestWithContext, rawQuery: Record<string, string>): Promise<LedgerResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, rawQuery)
    if (rawQuery.view === 'detail') return this.detail(context.tenantId, scope, LedgerDetailQuerySchema.parse(rawQuery))
    return this.summary(context.tenantId, scope, rawQuery)
  }

  private async stores(tenantId: string, scope: ResolvedScope) {
    const rows = await this.prisma.sellerAccount.findMany({
      where: { tenantId, ...(scope.unrestricted ? {} : { id: { in: scope.sellerAccountIds } }) },
      select: { id: true, displayName: true },
      take: 500,
    })
    return new Map(rows.map(row => [row.id, row.displayName]))
  }

  private searchWhere(q: string | undefined): Prisma.InventoryLedgerSummaryWhereInput {
    if (!q) return {}
    return { OR: [{ fnsku: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }, { asin: { contains: q, mode: 'insensitive' } }] }
  }

  private async summary(tenantId: string, scope: ResolvedScope, rawQuery: Record<string, string>): Promise<LedgerSummaryResponse> {
    const query = LedgerSummaryQuerySchema.parse(rawQuery)
    const today = await this.policies.todayOf(tenantId)
    const from = query.from ?? previousMonths(today, 2)[0]
    const to = query.to ?? today
    const [rows, names, freshness] = await Promise.all([
      this.prisma.inventoryLedgerSummary.findMany({
        where: { tenantId, ...storeWhere(scope), date: { gte: asDate(from), lte: asDate(to) }, ...this.searchWhere(query.q) },
        orderBy: [{ date: 'desc' }, { id: 'asc' }],
        take: SUMMARY_TAKE,
      }),
      this.stores(tenantId, scope),
      sourceFreshness(this.prisma, tenantId, scope, LEDGER_KEYS),
    ])
    const folded = foldLedgerSummary(rows)
    const unbalancedCount = folded.filter(row => !row.balanced).length
    const dir = query.sort.dir === 'asc' ? 1 : -1
    const sorted = (query.unbalanced ? folded.filter(row => !row.balanced) : folded).sort(
      (a, b) => dir * a.month.localeCompare(b.month) || a.sku.localeCompare(b.sku) || a.fnsku.localeCompare(b.fnsku),
    )
    const start = (query.page - 1) * query.pageSize
    const pageRows = sorted.slice(start, start + query.pageSize)
    const latest = latestMonthKeys(folded)
    const live = await this.liveQuantities(
      tenantId,
      pageRows.filter(row => latest.has(row.key)),
    )
    const items: LedgerSummaryRow[] = pageRows.map(row => {
      const qty = latest.has(row.key) ? (live.get(`${row.sellerAccountId}|${row.fnsku}`) ?? null) : null
      return {
        ...row,
        storeName: names.get(row.sellerAccountId) ?? '',
        live: latest.has(row.key) ? { ledgerDate: row.periodEnd, ledgerEnding: row.endingQty, liveQty: qty, difference: qty === null ? null : row.endingQty - qty } : null,
      }
    })
    const truncated = rows.length >= SUMMARY_TAKE
    return {
      view: 'summary',
      state: folded.length ? 'OK' : 'NO_DATA',
      note: folded.length
        ? truncated
          ? '所选范围内的台账记录过多，只读取了最近的一部分，较早月份可能不完整；请缩小时间范围或店铺'
          : null
        : '尚无库存台账记录；台账汇总报告同步后这里会按月汇总每个 SKU 的期初、接收、发货、退货、调整与期末',
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: sorted.length,
      from,
      to,
      unbalancedCount,
      truncated,
      freshness,
    }
  }

  /** 库存接口当前的仓内数量（可售 + 预留 + 不可售），按店铺与 FNSKU 汇总；记录里任一数量为空时该项按没有记录处理。 */
  private async liveQuantities(tenantId: string, rows: Array<{ sellerAccountId: string; fnsku: string }>): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    if (rows.length === 0) return result
    const records = await this.prisma.fbaInventoryRecord.findMany({
      where: {
        tenantId,
        OR: [...new Set(rows.map(row => row.sellerAccountId))].map(id => ({ sellerAccountId: id, fnsku: { in: rows.filter(row => row.sellerAccountId === id).map(row => row.fnsku) } })),
      },
      select: { sellerAccountId: true, fnsku: true, fulfillableQuantity: true, reservedQuantity: true, unfulfillableQuantity: true },
      take: 5000,
    })
    for (const record of records) {
      if (!record.fnsku) continue
      const key = `${record.sellerAccountId}|${record.fnsku}`
      result.set(key, (result.get(key) ?? 0) + (record.fulfillableQuantity ?? 0) + (record.reservedQuantity ?? 0) + (record.unfulfillableQuantity ?? 0))
    }
    return result
  }

  private async detail(tenantId: string, scope: ResolvedScope, query: LedgerDetailQuery): Promise<LedgerDetailResponse> {
    const sort = { field: 'eventDate', dir: query.sort.dir } as const
    const binding = bindingOf(tenantId, query)
    const search: Prisma.InventoryLedgerEntryWhereInput = query.q
      ? {
          OR: [
            { fnsku: { contains: query.q, mode: 'insensitive' } },
            { sku: { contains: query.q, mode: 'insensitive' } },
            { asin: { contains: query.q, mode: 'insensitive' } },
            { referenceId: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}
    const range: Prisma.InventoryLedgerEntryWhereInput = query.from && query.to ? { eventDate: { gte: asDate(query.from), lte: asDate(query.to) } } : {}
    const [rows, names, freshness] = await Promise.all([
      this.prisma.inventoryLedgerEntry.findMany({
        where: {
          AND: [{ tenantId, ...storeWhere(scope) }, range, search, query.group ? groupWhere(query.group) : {}, this.cursor.after(query.cursor, sort, binding) as Prisma.InventoryLedgerEntryWhereInput],
        },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
      }),
      this.stores(tenantId, scope),
      sourceFreshness(this.prisma, tenantId, scope, LEDGER_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const hasAny = page.items.length > 0 || Boolean(query.cursor)
    return {
      view: 'detail',
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : '没有符合条件的台账明细；台账明细报告同步后这里会列出每一笔库存变动',
      items: page.items.map(entry => {
        const kind = classifyLedgerEvent(entry.eventType, entry.reasonCode)
        return {
          id: entry.id,
          sellerAccountId: entry.sellerAccountId,
          storeName: names.get(entry.sellerAccountId) ?? '',
          eventDate: dateText(entry.eventDate),
          eventTime: entry.eventTime ? entry.eventTime.toISOString() : null,
          fnsku: entry.fnsku,
          sku: entry.sku,
          asin: entry.asin,
          fulfillmentCenter: entry.fulfillmentCenter,
          disposition: entry.disposition,
          reasonCode: entry.reasonCode,
          eventType: entry.eventType,
          group: kind.group,
          groupLabel: LEDGER_EVENT_GROUP_LABEL[kind.group],
          adjustmentLabel: kind.adjustment ? LEDGER_ADJUSTMENT_LABEL[kind.adjustment] : null,
          quantity: entry.quantity,
          referenceId: entry.referenceId,
          referenceKind: entry.referenceId ? ledgerReferenceKind(entry.eventType) : null,
          reconciledQty: entry.reconciledQty,
          unreconciledQty: entry.unreconciledQty,
        }
      }),
      pageInfo: page.pageInfo,
      freshness,
    }
  }
}
