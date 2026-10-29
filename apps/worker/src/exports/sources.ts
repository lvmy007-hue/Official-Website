import type { Prisma, PrismaClient } from '@prisma/client'
import { auditEvents } from './audit-source'
import type { Cell } from './csv'
import { reimbursementEvidence } from './evidence-source'
import { feeEvents } from './fee-source'
import { products } from './product-source'

// 导出的取数实现：每个可导出的数据类型（契约 EXPORT_KINDS）在这里有一个对应的“按页读取”实现，
// 一次只在内存里保留一页。范围（店铺）已由调用方按发起人当前授权算好，这里只负责筛选与读取。

export type ExportRow = Record<string, Cell>
export interface SourceContext {
  db: PrismaClient
  tenantId: string
  filters: Record<string, unknown>
  /** null 表示不限店铺（全部范围） */
  storeIds: string[] | null
}
export type ExportSource = (context: SourceContext) => AsyncIterable<ExportRow>

export const EXPORT_PAGE_SIZE = 2000
const DAY_MS = 86_400_000

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const dayStart = (value: unknown) => {
  const day = text(value)
  const parsed = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : Number.NaN
  return Number.isNaN(parsed) ? undefined : new Date(parsed)
}

async function* orders({ db, tenantId, filters, storeIds }: SourceContext): AsyncGenerator<ExportRow> {
  const from = dayStart(filters.from)
  const to = dayStart(filters.to)
  const status = text(filters.status)
  const q = text(filters.q)
  const where: Prisma.OrderWhereInput = {
    tenantId,
    ...(storeIds ? { sellerAccountId: { in: storeIds } } : {}),
    ...(status ? { status } : {}),
    ...(q ? { amazonOrderId: { contains: q, mode: 'insensitive' } } : {}),
    ...(from || to ? { purchaseDate: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + DAY_MS) } : {}) } } : {}),
  }
  let after: { purchaseDate: Date; id: string } | undefined
  for (;;) {
    const rows = await db.order.findMany({
      where: after ? { AND: [where, { OR: [{ purchaseDate: { lt: after.purchaseDate } }, { purchaseDate: after.purchaseDate, id: { gt: after.id } }] }] } : where,
      orderBy: [{ purchaseDate: 'desc' }, { id: 'asc' }],
      take: EXPORT_PAGE_SIZE,
      // 明确列出字段：买家个人信息的密文列永远不读取
      select: { id: true, amazonOrderId: true, purchaseDate: true, status: true, fulfillment: true, currency: true, amount: true, itemCount: true, sellerAccount: { select: { displayName: true } } },
    })
    for (const row of rows) {
      yield {
        amazonOrderId: row.amazonOrderId,
        storeName: row.sellerAccount.displayName,
        purchaseDate: row.purchaseDate,
        status: row.status,
        fulfillment: row.fulfillment,
        currency: row.currency,
        amount: row.amount === null ? null : Number(row.amount.toString()),
        itemCount: row.itemCount,
      }
    }
    if (rows.length < EXPORT_PAGE_SIZE) return
    const last = rows[rows.length - 1]
    after = { purchaseDate: last.purchaseDate, id: last.id }
  }
}

const decimal = (value: { toString(): string }) => Number(value.toString())

/** 经营报表：店铺日汇总，按日期升序、店铺名排序；日期是汇总所属的租户本地日期，直接按日期范围筛选。 */
async function* overviewReport({ db, tenantId, filters, storeIds }: SourceContext): AsyncGenerator<ExportRow> {
  const from = dayStart(filters.from)
  const to = dayStart(filters.to)
  const where: Prisma.StoreDailySummaryWhereInput = {
    tenantId,
    ...(storeIds ? { sellerAccountId: { in: storeIds } } : {}),
    ...(from || to ? { summaryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  }
  let afterId: string | undefined
  for (;;) {
    const rows = await db.storeDailySummary.findMany({
      where,
      orderBy: [{ summaryDate: 'asc' }, { sellerAccount: { displayName: 'asc' } }, { id: 'asc' }],
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      take: EXPORT_PAGE_SIZE,
      select: { id: true, summaryDate: true, currency: true, orders: true, units: true, salesAmount: true, refundAmount: true, feeAmount: true, sellerAccount: { select: { displayName: true } } },
    })
    for (const row of rows) {
      yield {
        summaryDate: row.summaryDate.toISOString().slice(0, 10),
        storeName: row.sellerAccount.displayName,
        currency: row.currency,
        orders: row.orders,
        units: row.units,
        salesAmount: decimal(row.salesAmount),
        refundAmount: decimal(row.refundAmount),
        feeAmount: decimal(row.feeAmount),
      }
    }
    if (rows.length < EXPORT_PAGE_SIZE) return
    afterId = rows[rows.length - 1].id
  }
}

/** 数据类型 → 取数实现。契约里新增可导出的类型时，必须在这里登记（有单元测试核对两边一致）。 */
export const EXPORT_SOURCES: Readonly<Record<string, ExportSource>> = {
  orders,
  'overview-report': overviewReport,
  'reimbursement-evidence': reimbursementEvidence,
  'fee-events': feeEvents,
  products,
  'audit-events': auditEvents,
  'custom-report': customReport,
}

async function* customReport({ filters }: SourceContext): AsyncGenerator<ExportRow> {
  const rows = Array.isArray(filters.rows) ? filters.rows : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    yield {
      id: typeof item.id === 'string' ? item.id : '',
      label: typeof item.label === 'string' ? item.label : '',
      valuesJson: typeof item.valuesJson === 'string' ? item.valuesJson : JSON.stringify(item.values ?? {}),
    }
  }
}
