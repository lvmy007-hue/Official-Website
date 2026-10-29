import type { SalesTrafficAsinGranularity, SalesTrafficGranularity, SalesTrafficSource } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { ParsedAsinRow, ParsedDateRow } from './sales-traffic-parse'

// 销售与流量落库（P4-01）：按唯一键覆盖写入，重试与重复拉取不会产生重复行。
// 更新时只写官方这次给了值的列（null 不覆盖已有值）：数据中心的不同数据集（按日期、按 ASIN、趋势）会写到同一行的不同列，
// 其中一个这次没给某列，不能把另一个写进去的值抹掉。新建行没给的列保持为空（不是 0）。

export interface TrafficScope {
  tenantId: string
  sellerAccountId: string
}

export interface WriteMeta {
  source: SalesTrafficSource
  now: Date
  reportJobId?: string | null
}

/** 去掉 null 与 undefined 的键。 */
const present = <T extends Record<string, unknown>>(values: T): Partial<T> => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)) as Partial<T>
const dayDate = (text: string) => new Date(`${text}T00:00:00Z`)

export async function upsertDailyRow(prisma: Pick<PrismaClient, 'salesTrafficDaily'>, scope: TrafficScope, granularity: SalesTrafficGranularity, row: ParsedDateRow, meta: WriteMeta): Promise<void> {
  const metrics = present({
    orderedSales: row.orderedSales,
    unitsOrdered: row.unitsOrdered,
    ordersCount: row.ordersCount,
    sessions: row.sessions,
    pageViews: row.pageViews,
    buyBoxPct: row.buyBoxPct,
    unitSessionPct: row.unitSessionPct,
    unitsRefunded: row.unitsRefunded,
    refundRate: row.refundRate,
    claimsGranted: row.claimsGranted,
  })
  const data = { ...metrics, currency: row.currency ?? 'USD', sourceUpdatedAt: meta.now, syncedAt: meta.now, ...(meta.reportJobId ? { sourceReportJobId: meta.reportJobId } : {}) }
  const date = dayDate(row.date)
  await prisma.salesTrafficDaily.upsert({
    where: { tenantId_sellerAccountId_date_granularity_source: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, date, granularity, source: meta.source } },
    create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, date, granularity, source: meta.source, ...data },
    update: data,
  })
}

export async function upsertAsinRow(
  prisma: Pick<PrismaClient, 'salesTrafficAsinDaily'>,
  scope: TrafficScope,
  granularity: SalesTrafficAsinGranularity,
  row: ParsedAsinRow,
  meta: WriteMeta,
): Promise<void> {
  const metrics = present({
    orderedSales: row.orderedSales,
    units: row.unitsOrdered,
    ordersCount: row.ordersCount,
    sessions: row.sessions,
    pageViews: row.pageViews,
    buyBoxPct: row.buyBoxPct,
    unitSessionPct: row.unitSessionPct,
    b2bSales: row.b2bSales,
    b2bUnits: row.b2bUnits,
    parentAsin: row.parentAsin,
  })
  const data = { ...metrics, currency: row.currency ?? 'USD', sourceUpdatedAt: meta.now, syncedAt: meta.now, ...(meta.reportJobId ? { sourceReportJobId: meta.reportJobId } : {}) }
  const date = dayDate(row.date)
  await prisma.salesTrafficAsinDaily.upsert({
    where: {
      tenantId_sellerAccountId_asin_asinGranularity_sku_date_source: {
        tenantId: scope.tenantId,
        sellerAccountId: scope.sellerAccountId,
        asin: row.asin,
        asinGranularity: granularity,
        sku: row.sku,
        date,
        source: meta.source,
      },
    },
    create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, asin: row.asin, asinGranularity: granularity, sku: row.sku, date, source: meta.source, ...data },
    update: data,
  })
}
