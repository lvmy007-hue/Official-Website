import type { PrismaClient } from '@prisma/client'

// 日汇总的刷新 SQL（P2a-01，10 章 10.1）。必须在租户上下文（runWithTenant）里调用：
// 先删除该日期范围内的旧汇总，再按原始数据重新聚合写入，两步在同一事务里，所以可以对同一范围重复执行、结果完全相同。
// 所有 SQL 都显式带租户条件（行级安全同时生效），日期范围只作为参数传入，不拼接进 SQL 文本。
//
// 日期口径：summaryDate 是数据口径时区（企业的 timezone，默认美国太平洋时区）的日历日。
// 订单按下单时间、退款与费用按入账时间落到各自的本地日。库里的时间列存的是 UTC 墙上时间，所以先按 UTC 解释、再换算到企业时区。
// 范围边界：本地日 dateFrom 零点（含）到 dateTo 次日零点（不含），转回 UTC 后再与时间列比较，能走时间列上的分区裁剪与索引。
//
// 口径（metricVersion = METRIC_VERSION）：
//   订单数：去重的订单，取消订单不计（M-004）；
//   件数、销售额：订单行的数量与商品金额（不含税、不含运费）合计，取消订单不计，只含美元；这是“订购口径”的订单表估算，
//     官方的订购口径（销售与流量 SalesTrafficDaily / SalesTrafficAsinDaily 的 orderedSales 与 unitsOrdered，M-001，P4-01 起）有数据的日子（店铺按日、ASIN 按子体）
//     覆盖订单表的估算，salesSource 写 DATA_KIOSK（数据中心优先，没有才用报告补充 REPORT），官方没给销售额的日子仍是 ORDERS；
//     订单数仍取订单表（官方的 totalOrderItems 是订单行数不是订单数）；会话数、页面浏览量、购物车获得率只来自官方数据，没有就是空；
//     官方日期是亚马逊美国站（太平洋时区）的日历日，与企业数据口径时区不同时按日期原样对应，不换算（见 CR-076）；
//   退款额：财务交易里类型为 Refund 的金额，取相反数（退款入账为负），按入账日；
//   费用：费用明细里路径以 Fees 开头的项与服务费（ServiceFee），取相反数（费用入账为负）；费用的精细分类由 P2b-05 接管并升版本；
//   广告（P3-04 起）：已绑定店铺的美元广告活动指标按报告日求和写入 adsSpend、adsSales，没有指标行的日子保持为空；ASIN 日汇总的广告列仍为空（要等广告商品指标有同步器）。
// 没有订单、退款、费用的日子不生成行（稀疏）：读取方把缺行当作“该日没有这类业务”，是否“还没同步”由数据新鲜度判断。

export const METRIC_VERSION = 'p4-01@1'

type Db = Pick<PrismaClient, '$transaction'>

// 本地日范围 → UTC 墙上时间范围（参数 $2、$3 为日期文本，$4 为时区）
const FROM_UTC = `(($2::date)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'`
const TO_UTC = `((($3::date) + 1)::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC'`
const LOCAL_DAY = (column: string) => `((${column} AT TIME ZONE 'UTC') AT TIME ZONE $4)::date`
const ORDER_SCOPE = `o."tenantId" = $1 AND o."purchaseDate" >= ${FROM_UTC} AND o."purchaseDate" < ${TO_UTC} AND lower(o."status") NOT IN ('canceled', 'cancelled')`

// 广告（P3-04）：只取已绑定店铺的广告档案、美元、活动级指标行；报告日是广告账户自己的日历日，原样当作店铺的日期（不换算时区）。
// 没有广告指标行的日子 adsSpend、adsSales 保持为空（不是 0）；多个档案绑到同一店铺时求和。
const ADS_SCOPE = `m."tenantId" = $1 AND m."entityType" = 'CAMPAIGN' AND m."currency" = 'USD' AND p."sellerAccountId" IS NOT NULL AND m."reportDate" >= $2::date AND m."reportDate" < ($3::date + 1)`

// 官方销售与流量（P4-01）：同一店铺同一天优先取数据中心行（没有销售额的行排在后面，让有销售额的报告行补上），只取日粒度、美元。
const KIOSK_STORE = `(
  SELECT DISTINCT ON (st."sellerAccountId", st."date") st."sellerAccountId", st."date" AS "d", st."orderedSales" AS "sales", st."unitsOrdered" AS "units", st."sessions", st."source"
  FROM "SalesTrafficDaily" st
  WHERE st."tenantId" = $1 AND st."granularity" = 'DAY' AND st."currency" = 'USD' AND st."date" >= $2::date AND st."date" <= $3::date
  ORDER BY st."sellerAccountId", st."date", (st."orderedSales" IS NULL), st."source"
)`
// ASIN 日：子体粒度、SKU 为空串的行（D-02 子体与 D-03 趋势都写这一种），同样数据中心优先。
const KIOSK_ASIN = `(
  SELECT DISTINCT ON (st."sellerAccountId", st."date", st."asin") st."sellerAccountId", st."date" AS "d", st."asin", st."orderedSales" AS "sales", st."units", st."sessions", st."pageViews", st."buyBoxPct", st."source"
  FROM "SalesTrafficAsinDaily" st
  WHERE st."tenantId" = $1 AND st."asinGranularity" = 'CHILD' AND st."sku" = '' AND st."currency" = 'USD' AND st."date" >= $2::date AND st."date" <= $3::date
  ORDER BY st."sellerAccountId", st."date", st."asin", (st."orderedSales" IS NULL), st."source"
)`

const DELETE_STORE = `DELETE FROM "StoreDailySummary" WHERE "tenantId" = $1 AND "summaryDate" BETWEEN $2::date AND $3::date`
const DELETE_ASIN = `DELETE FROM "AsinDailySummary" WHERE "tenantId" = $1 AND "summaryDate" BETWEEN $2::date AND $3::date`

const INSERT_STORE = `
INSERT INTO "StoreDailySummary" (
  "id", "tenantId", "sellerAccountId", "summaryDate", "orders", "units", "salesAmount", "refundAmount", "feeAmount", "adsSpend", "adsSales", "sessions", "currency", "metricVersion", "salesSource", "refreshedAt", "updatedAt"
)
SELECT gen_random_uuid()::text, $1, k."sellerAccountId", k."d", COALESCE(a."orders", 0), COALESCE(w."units", a."units", 0), COALESCE(w."sales", a."sales", 0), COALESCE(r."refund", 0), COALESCE(f."fee", 0),
  g."spend", g."sales", w."sessions", 'USD', $5, CASE WHEN w."sales" IS NOT NULL THEN w."source" ELSE 'ORDERS' END, now(), now()
FROM (
  SELECT "sellerAccountId", "d" FROM (
    SELECT o."sellerAccountId", ${LOCAL_DAY('o."purchaseDate"')} AS "d" FROM "Order" o WHERE ${ORDER_SCOPE}
    UNION
    SELECT t."sellerAccountId", ${LOCAL_DAY('t."postedAt"')} FROM "FbaFinancialTransaction" t
      WHERE t."tenantId" = $1 AND t."postedAt" >= ${FROM_UTC} AND t."postedAt" < ${TO_UTC} AND t."transactionType" = 'Refund' AND t."currency" = 'USD'
    UNION
    SELECT e."sellerAccountId", ${LOCAL_DAY('e."postedAt"')} FROM "FbaFeeEvent" e
      WHERE e."tenantId" = $1 AND e."postedAt" >= ${FROM_UTC} AND e."postedAt" < ${TO_UTC} AND e."currency" = 'USD' AND (lower(split_part(coalesce(e."description", ''), '/', 1)) IN ('fees', 'fee') OR e."eventType" = 'ServiceFee')
    UNION
    SELECT p."sellerAccountId", m."reportDate"::date FROM "AdsMetric" m JOIN "AdsProfile" p ON p."id" = m."adsProfileId" AND p."tenantId" = m."tenantId" WHERE ${ADS_SCOPE}
    UNION
    SELECT w."sellerAccountId", w."d" FROM ${KIOSK_STORE} w WHERE w."sales" IS NOT NULL OR w."sessions" IS NOT NULL
  ) u GROUP BY "sellerAccountId", "d"
) k
LEFT JOIN (
  SELECT o."sellerAccountId", ${LOCAL_DAY('o."purchaseDate"')} AS "d", count(DISTINCT o."id")::int AS "orders",
         COALESCE(sum(i."quantityOrdered") FILTER (WHERE i."currency" = 'USD'), 0)::int AS "units",
         COALESCE(sum(i."itemPrice") FILTER (WHERE i."currency" = 'USD'), 0) AS "sales"
  FROM "Order" o LEFT JOIN "OrderItem" i ON i."orderId" = o."id" AND i."orderPurchaseDate" = o."purchaseDate" AND i."tenantId" = o."tenantId"
  WHERE ${ORDER_SCOPE}
  GROUP BY 1, 2
) a ON a."sellerAccountId" = k."sellerAccountId" AND a."d" = k."d"
LEFT JOIN (
  SELECT t."sellerAccountId", ${LOCAL_DAY('t."postedAt"')} AS "d", -sum(t."amount") AS "refund"
  FROM "FbaFinancialTransaction" t
  WHERE t."tenantId" = $1 AND t."postedAt" >= ${FROM_UTC} AND t."postedAt" < ${TO_UTC} AND t."transactionType" = 'Refund' AND t."currency" = 'USD'
  GROUP BY 1, 2
) r ON r."sellerAccountId" = k."sellerAccountId" AND r."d" = k."d"
LEFT JOIN (
  SELECT e."sellerAccountId", ${LOCAL_DAY('e."postedAt"')} AS "d", -sum(e."amount") AS "fee"
  FROM "FbaFeeEvent" e
  WHERE e."tenantId" = $1 AND e."postedAt" >= ${FROM_UTC} AND e."postedAt" < ${TO_UTC} AND e."currency" = 'USD' AND (lower(split_part(coalesce(e."description", ''), '/', 1)) IN ('fees', 'fee') OR e."eventType" = 'ServiceFee')
  GROUP BY 1, 2
) f ON f."sellerAccountId" = k."sellerAccountId" AND f."d" = k."d"
LEFT JOIN (
  SELECT p."sellerAccountId", m."reportDate"::date AS "d", sum(m."cost") AS "spend", sum(m."sales") AS "sales"
  FROM "AdsMetric" m JOIN "AdsProfile" p ON p."id" = m."adsProfileId" AND p."tenantId" = m."tenantId"
  WHERE ${ADS_SCOPE}
  GROUP BY 1, 2
) g ON g."sellerAccountId" = k."sellerAccountId" AND g."d" = k."d"
LEFT JOIN ${KIOSK_STORE} w ON w."sellerAccountId" = k."sellerAccountId" AND w."d" = k."d"`

const INSERT_ASIN = `
INSERT INTO "AsinDailySummary" (
  "id", "tenantId", "sellerAccountId", "summaryDate", "asin", "sku", "units", "salesAmount", "sessions", "pageViews", "buyBoxPct", "currency", "metricVersion", "salesSource", "refreshedAt", "updatedAt"
)
SELECT gen_random_uuid()::text, $1, COALESCE(s."sellerAccountId", w."sellerAccountId"), COALESCE(s."d", w."d"), COALESCE(s."asin", w."asin"), s."sku",
  COALESCE(w."units", s."units", 0), COALESCE(w."sales", s."sales", 0), w."sessions", w."pageViews", w."buyBoxPct", 'USD', $5, CASE WHEN w."sales" IS NOT NULL THEN w."source" ELSE 'ORDERS' END, now(), now()
FROM (
  SELECT o."sellerAccountId", ${LOCAL_DAY('o."purchaseDate"')} AS "d", i."asin", max(i."sellerSku") AS "sku", COALESCE(sum(i."quantityOrdered"), 0)::int AS "units", COALESCE(sum(i."itemPrice"), 0) AS "sales"
  FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o."id" AND i."orderPurchaseDate" = o."purchaseDate" AND i."tenantId" = o."tenantId"
  WHERE ${ORDER_SCOPE} AND i."asin" IS NOT NULL AND i."currency" = 'USD'
  GROUP BY 1, 2, 3
) s
FULL OUTER JOIN ${KIOSK_ASIN} w ON w."sellerAccountId" = s."sellerAccountId" AND w."d" = s."d" AND w."asin" = s."asin"`

export interface SummaryRange {
  tenantId: string
  dateFrom: string
  dateTo: string
}

/** 企业的数据口径时区；读不到或不是有效时区时回退到美国太平洋时区（与企业默认值一致）。 */
export async function tenantTimeZone(db: Pick<PrismaClient, 'tenant'>, tenantId: string): Promise<string> {
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const zone = tenant?.timezone ?? 'America/Los_Angeles'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return 'America/Los_Angeles'
  }
}

async function refresh(db: Db & Pick<PrismaClient, 'tenant'>, range: SummaryRange, kind: 'store' | 'asin'): Promise<number> {
  const zone = await tenantTimeZone(db, range.tenantId)
  return db.$transaction(
    async tx => {
      const args = [range.tenantId, range.dateFrom, range.dateTo, zone] as const
      await tx.$executeRawUnsafe(kind === 'store' ? DELETE_STORE : DELETE_ASIN, ...args.slice(0, 3))
      return tx.$executeRawUnsafe(kind === 'store' ? INSERT_STORE : INSERT_ASIN, ...args, METRIC_VERSION)
    },
    { timeout: 30_000 },
  )
}

export const refreshStoreDailySummary = (db: Db & Pick<PrismaClient, 'tenant'>, range: SummaryRange) => refresh(db, range, 'store')
export const refreshAsinDailySummary = (db: Db & Pick<PrismaClient, 'tenant'>, range: SummaryRange) => refresh(db, range, 'asin')
