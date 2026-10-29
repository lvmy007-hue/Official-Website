import type { PrismaClient } from '@prisma/client'
import type { SummaryRange } from './summary-sql'

// 广告日汇总的刷新 SQL（P3-04，10 章 10.1）。必须在租户上下文（runWithTenant）里调用：
// 先删除该日期范围内的旧汇总，再从 AdsMetric 聚合写入，两步在同一事务里，所以可以对同一范围重复执行、结果完全相同。
// 所有 SQL 都显式带租户条件（行级安全同时生效），日期范围只作为参数传入，不拼接进 SQL 文本。
//
// 口径（metricVersion = ADS_SUMMARY_VERSION）：
//   来源只取 AdsMetric 里 entityType = CAMPAIGN 的行：广告组、广告、投放对象、关键词的行是同一笔花费的更细拆分，一起加会重复计数；
//   一行 = 广告档案 × 广告产品 × 活动 × 报告日 × 币种；活动编号取 externalCampaignId，没有就取 entityId，再没有就是空串（账户级）；
//   spend、sales：来源行的 cost、sales 求和，只要有一行给了值就有值，全部没给就是空（不是 0）；
//   报告日（reportDate）是广告账户自己的日历日，原样当作 summaryDate，不换算到企业时区；
//   不按币种折算：同一档案同一天不同币种各一行，读取方不能把不同币种直接相加；
//   adsAccountId 取来源行上的账户编号，没有就取档案上的（档案也没有就是空，旧接口的数据多半如此）。
// 没有任何指标行的日子不生成行（稀疏）：读取方把缺行当作“没有记录”，是否“还没同步”由数据新鲜度判断。

export const ADS_SUMMARY_TASK = 'ads_daily_summary'
export const ADS_SUMMARY_VERSION = 'p3-04@1'

type Db = Pick<PrismaClient, '$transaction'>

// 报告日是不带时区的时间戳列，范围按日期整日比较（含 dateTo 当天）。
const DAY_RANGE = `m."reportDate" >= $2::date AND m."reportDate" < ($3::date + 1)`

const DELETE_ADS = `DELETE FROM "AdsDailySummary" WHERE "tenantId" = $1 AND "summaryDate" BETWEEN $2::date AND $3::date`

const INSERT_ADS = `
INSERT INTO "AdsDailySummary" ("id", "tenantId", "adsProfileId", "adsAccountId", "adProduct", "campaignId", "summaryDate", "impressions", "clicks", "spend", "sales", "orders", "currency", "metricVersion", "refreshedAt", "updatedAt")
SELECT gen_random_uuid()::text, $1, m."adsProfileId", max(COALESCE(m."adsAccountId", p."adsAccountId")), m."adProduct", COALESCE(m."externalCampaignId", m."entityId", ''), m."reportDate"::date,
       COALESCE(sum(m."impressions"), 0)::int, COALESCE(sum(m."clicks"), 0)::int, sum(m."cost"), sum(m."sales"), COALESCE(sum(m."purchases"), 0)::int, m."currency", $4, now(), now()
FROM "AdsMetric" m
LEFT JOIN "AdsProfile" p ON p."id" = m."adsProfileId" AND p."tenantId" = m."tenantId"
WHERE m."tenantId" = $1 AND m."entityType" = 'CAMPAIGN' AND ${DAY_RANGE}
GROUP BY m."adsProfileId", m."adProduct", COALESCE(m."externalCampaignId", m."entityId", ''), m."reportDate"::date, m."currency"`

/** 重算范围内的广告日汇总，返回写入的行数。 */
export async function refreshAdsDailySummary(db: Db, range: SummaryRange): Promise<number> {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe(DELETE_ADS, range.tenantId, range.dateFrom, range.dateTo)
    return tx.$executeRawUnsafe(INSERT_ADS, range.tenantId, range.dateFrom, range.dateTo, ADS_SUMMARY_VERSION)
  })
}
