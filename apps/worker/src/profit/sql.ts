import type { ProfitBasis } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { FeeRow, SalesRow } from './types'

// 利润日表的聚合查询（P2b-09）。必须在租户上下文（runWithTenant）里调用；所有 SQL 都显式带租户条件（行级安全同时生效），
// 日期范围与时区只作为参数传入，不拼接进 SQL 文本。参数固定：$1 租户、$2 起始日、$3 结束日（含）、$4 企业时区。
//
// 日期口径与日汇总（summary-sql.ts）一致：时间列存的是 UTC 墙上时间，先按 UTC 解释、再换算到企业时区的日历日；
// 范围边界转回 UTC 后与时间列比较，能走时间列上的分区裁剪与索引。
// 发货口径按 Order.shippedAt 取日，订单表按下单时间分区，所以额外限定下单时间不早于范围起点前 SHIP_LOOKBACK_DAYS 天（下单后更久才发货的订单不计入）。

export const SHIP_LOOKBACK_DAYS = 120

type Db = Pick<PrismaClient, '$queryRawUnsafe'>
type Raw = Record<string, unknown>

const FROM_UTC = `(($2::date)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'`
const TO_UTC = `((($3::date) + 1)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'`
const LOCAL_DAY = (column: string) => `((${column} AT TIME ZONE 'UTC') AT TIME ZONE $4)::date`
const DAY_TEXT = (column: string) => `to_char(${LOCAL_DAY(column)}, 'YYYY-MM-DD')`
const LETTERS = (column: string) => `regexp_replace(lower(coalesce(${column}, '')), '[^a-z]', '', 'g')`
const NOT_CANCELED = `lower(o."status") NOT IN ('canceled', 'cancelled')`
/** 与契约 bridgeTargetOfLine 里“销售额”关键字一致：销售额类明细（不含税）。 */
const PRINCIPAL = `${LETTERS('e."feeSubtype"')} ~ 'principal|principle|productcharge|itemprice|proceeds|ordercharge' AND ${LETTERS('e."feeSubtype"')} !~ 'tax'`
const RELEASED = `(e."transactionStatus" IS NULL OR e."transactionStatus" IN ('RELEASED', 'DEFERRED_RELEASED'))`

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(String(value)))

const SALES_ORDERED = `
SELECT o."sellerAccountId" AS "sellerAccountId", coalesce(i."sellerSku", '') AS "sku", max(i."asin") AS "asin", ${DAY_TEXT('o."purchaseDate"')} AS "day", i."currency" AS "currency",
       COALESCE(sum(i."quantityOrdered"), 0)::int AS "units", COALESCE(sum(i."itemPrice"), 0) AS "revenue"
FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id" AND i."orderPurchaseDate" = o."purchaseDate" AND i."tenantId" = o."tenantId"
WHERE o."tenantId" = $1 AND o."purchaseDate" >= ${FROM_UTC} AND o."purchaseDate" < ${TO_UTC} AND ${NOT_CANCELED}
GROUP BY o."sellerAccountId", coalesce(i."sellerSku", ''), ${LOCAL_DAY('o."purchaseDate"')}, i."currency"`

const SALES_SHIPPED = `
SELECT o."sellerAccountId" AS "sellerAccountId", coalesce(i."sellerSku", '') AS "sku", max(i."asin") AS "asin", ${DAY_TEXT('o."shippedAt"')} AS "day", i."currency" AS "currency",
       COALESCE(sum(i."quantityShipped"), 0)::int AS "units",
       COALESCE(sum(i."itemPrice" * i."quantityShipped" / NULLIF(i."quantityOrdered", 0)), 0) AS "revenue"
FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id" AND i."orderPurchaseDate" = o."purchaseDate" AND i."tenantId" = o."tenantId"
WHERE o."tenantId" = $1 AND o."shippedAt" IS NOT NULL AND o."shippedAt" >= ${FROM_UTC} AND o."shippedAt" < ${TO_UTC}
  AND o."purchaseDate" >= ${FROM_UTC} - interval '${SHIP_LOOKBACK_DAYS} days' AND ${NOT_CANCELED}
GROUP BY o."sellerAccountId", coalesce(i."sellerSku", ''), ${LOCAL_DAY('o."shippedAt"')}, i."currency"`

// 结算释放口径的件数：已释放的销售额明细所属订单行的件数，落在明细入账日（销售额本身来自费用明细，见 FEES_*）。
const SALES_SETTLED = `
SELECT p."sellerAccountId" AS "sellerAccountId", p."sku" AS "sku", max(i."asin") AS "asin", p."day" AS "day", i."currency" AS "currency",
       COALESCE(sum(CASE WHEN i."quantityShipped" > 0 THEN i."quantityShipped" ELSE i."quantityOrdered" END), 0)::int AS "units", 0 AS "revenue"
FROM (
  SELECT DISTINCT e."sellerAccountId", e."sellerSku" AS "sku", e."amazonOrderId", ${DAY_TEXT('e."postedAt"')} AS "day"
  FROM "FbaFeeEvent" e
  WHERE e."tenantId" = $1 AND e."postedAt" >= ${FROM_UTC} AND e."postedAt" < ${TO_UTC}
    AND e."feeCategory" = 'NON_FEE' AND e."amazonOrderId" IS NOT NULL AND e."sellerSku" IS NOT NULL AND ${PRINCIPAL} AND ${RELEASED}
) p JOIN "OrderItem" i ON i."tenantId" = $1 AND i."sellerAccountId" = p."sellerAccountId" AND i."amazonOrderId" = p."amazonOrderId" AND i."sellerSku" = p."sku"
GROUP BY p."sellerAccountId", p."sku", p."day", i."currency"`

const SALES: Record<ProfitBasis, string> = { ORDERED: SALES_ORDERED, SHIPPED: SALES_SHIPPED, SETTLED: SALES_SETTLED }

const FEE_COLUMNS = (day: string) =>
  `e."sellerAccountId", coalesce(e."sellerSku", '') AS "sku", e."asin", ${day} AS "d", e."feeCategory", e."feeSubtype", e."transactionStatus", e."currency", e."amount"`
const GROUPED = (inner: string) => `
SELECT x."sellerAccountId" AS "sellerAccountId", x."sku" AS "sku", max(x."asin") AS "asin", to_char(x."d", 'YYYY-MM-DD') AS "day", x."feeCategory" AS "category", x."feeSubtype" AS "subtype",
       x."transactionStatus" AS "status", x."currency" AS "currency", x."mode" AS "mode", sum(x."amount") AS "amount", count(*)::int AS "lines"
FROM (${inner}) x
GROUP BY x."sellerAccountId", x."sku", x."d", x."feeCategory", x."feeSubtype", x."transactionStatus", x."currency", x."mode"`

// 按订单确认日取日的明细（退款与赔付除外：它们按入账日）：与订单关联，订单的确认日在范围内。
const linked = (scope: string, dayColumn: string) => `
  SELECT ${FEE_COLUMNS(LOCAL_DAY(dayColumn))}, 'ORDER' AS "mode"
  FROM "FbaFeeEvent" e JOIN "Order" o ON o."tenantId" = e."tenantId" AND o."sellerAccountId" = e."sellerAccountId" AND o."amazonOrderId" = e."amazonOrderId"
  WHERE e."tenantId" = $1 AND e."feeCategory" NOT IN ('REFUND', 'REIMBURSEMENT') AND ${scope}`

// 按入账日取日的明细：退款、赔付、没有订单号的账户级明细，以及订单还没同步的明细。
const POSTED = `
  SELECT ${FEE_COLUMNS(LOCAL_DAY('e."postedAt"'))},
         CASE WHEN e."amazonOrderId" IS NULL OR e."feeCategory" IN ('REFUND', 'REIMBURSEMENT') THEN 'POSTED' ELSE 'UNLINKED' END AS "mode"
  FROM "FbaFeeEvent" e
  WHERE e."tenantId" = $1 AND e."postedAt" >= ${FROM_UTC} AND e."postedAt" < ${TO_UTC}
    AND (e."feeCategory" IN ('REFUND', 'REIMBURSEMENT') OR e."amazonOrderId" IS NULL
         OR NOT EXISTS (SELECT 1 FROM "Order" o2 WHERE o2."tenantId" = e."tenantId" AND o2."sellerAccountId" = e."sellerAccountId" AND o2."amazonOrderId" = e."amazonOrderId"))`

const FEES_ORDERED = GROUPED(
  `${linked(`o."purchaseDate" >= ${FROM_UTC} AND o."purchaseDate" < ${TO_UTC} AND ${NOT_CANCELED}`, 'o."purchaseDate"')}
  UNION ALL ${POSTED}`,
)
const FEES_SHIPPED = GROUPED(
  `${linked(
    `o."shippedAt" IS NOT NULL AND o."shippedAt" >= ${FROM_UTC} AND o."shippedAt" < ${TO_UTC} AND o."purchaseDate" >= ${FROM_UTC} - interval '${SHIP_LOOKBACK_DAYS} days' AND ${NOT_CANCELED}`,
    'o."shippedAt"',
  )}
  UNION ALL ${POSTED}`,
)
// 结算释放口径：全部按入账日，状态在应用层判断（递延中的不计入并打标记）。
const FEES_SETTLED = GROUPED(`
  SELECT ${FEE_COLUMNS(LOCAL_DAY('e."postedAt"'))}, 'POSTED' AS "mode"
  FROM "FbaFeeEvent" e
  WHERE e."tenantId" = $1 AND e."postedAt" >= ${FROM_UTC} AND e."postedAt" < ${TO_UTC}`)

const FEES: Record<ProfitBasis, string> = { ORDERED: FEES_ORDERED, SHIPPED: FEES_SHIPPED, SETTLED: FEES_SETTLED }

export interface QueryScope {
  tenantId: string
  from: string
  to: string
  timeZone: string
}

export async function loadSales(db: Db, basis: ProfitBasis, scope: QueryScope): Promise<SalesRow[]> {
  const rows = await db.$queryRawUnsafe<Raw[]>(SALES[basis], scope.tenantId, scope.from, scope.to, scope.timeZone)
  return rows.map(row => ({
    sellerAccountId: String(row.sellerAccountId),
    sku: String(row.sku ?? ''),
    asin: row.asin === null || row.asin === undefined ? null : String(row.asin),
    day: String(row.day),
    currency: String(row.currency),
    units: num(row.units),
    revenue: num(row.revenue),
  }))
}

export async function loadFeeLines(db: Db, basis: ProfitBasis, scope: QueryScope): Promise<FeeRow[]> {
  const rows = await db.$queryRawUnsafe<Raw[]>(FEES[basis], scope.tenantId, scope.from, scope.to, scope.timeZone)
  return rows.map(row => ({
    sellerAccountId: String(row.sellerAccountId),
    sku: String(row.sku ?? ''),
    asin: row.asin === null || row.asin === undefined ? null : String(row.asin),
    day: String(row.day),
    category: String(row.category),
    subtype: row.subtype === null || row.subtype === undefined ? null : String(row.subtype),
    status: row.status === null || row.status === undefined ? null : String(row.status),
    currency: String(row.currency),
    mode: String(row.mode) as FeeRow['mode'],
    amount: num(row.amount),
    lines: num(row.lines),
  }))
}
