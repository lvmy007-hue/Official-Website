import { ADS_DAILY_REFETCH_DAYS, ADS_REPORT_LIMITS, dayStamp, type AdsReportGranularity } from './ads-connector'
import { ADS_REPORT_AD_PRODUCTS, ADS_REPORT_TEMPLATES, type AdsReportTemplateKey } from './ads-reports'

// 广告落库同步器（P5-12A，importers.md A-01、A-02）的共用常量与纯函数（后台任务与接口共用；只有常量与纯函数，没有 zod）。
// 实体同步（ADS_ENTITY_SYNC）：每个已发现统一接口账户编号的广告档案每 2 小时读一遍广告活动、广告组、广告、投放对象、关键词与否定投放；
// 报表同步没有新的任务类型：每天由定时器为每个档案、每个在投的广告产品、每个模板建一个报告任务（沿用 P3-15 的 ADS_REPORT_V1），窗口规则见 adsScheduledWindow。
// 所有取值都没有对真实广告账户验证（见 CR-056、CR-104 的假设清单）。

/** 实体同步的同步任务类型（队列域 ads）。 */
export const ADS_ENTITY_SYNC_JOB = 'ADS_ENTITY_SYNC'
/** 实体每 2 小时同步一次（importers.md A-01）。 */
export const ADS_ENTITY_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 报表定时器每 6 小时检查一次，距上一次同类任务不足 ADS_REPORT_MIN_GAP_HOURS 的不重复排，所以实际是每天一次。 */
export const ADS_REPORT_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000
export const ADS_REPORT_MIN_GAP_HOURS = 20
/** 一个模板第一次同步时回看的天数（按日）；更早的历史用“历史回补”（POST /ads/reports/backfill）。 */
export const ADS_INITIAL_FILL_DAYS = 30
/** 每个企业每次最多为多少个广告档案排报告任务（每个档案每产品 8 个模板），防止一次排出几千个任务。 */
export const ADS_SCHEDULE_PROFILE_LIMIT = 200

/** 亚马逊不删除广告对象，只归档：完整读完仍没出现的对象，状态记为已归档。 */
export const ADS_ARCHIVED_STATE = 'ARCHIVED'
/** 归档保护：返回空、或者一次要归档超过一半（至少 minRows 行基数）时，多半是接口出了问题，不归档并在结果里写明原因。 */
export const ADS_ARCHIVE_GUARD = { minRows: 20, maxRatio: 0.5 } as const

export type AdsArchiveSkip = 'INCOMPLETE' | 'EMPTY_RESPONSE' | 'TOO_MANY'
export type AdsArchiveDecision = { archive: boolean; reason: AdsArchiveSkip | null }

/**
 * 一类实体读完之后要不要把“这次没出现”的行归档。
 * read：这次读到的条目数；active：库里这个账户下还没归档的行数；stale：其中这次没出现的行数。
 * 翻页没翻完一律不归档；一条都没读到而库里有行，说明返回为空而不是全删光了；比例过大同样不信。
 */
export function adsArchiveDecision(input: { complete: boolean; read: number; active: number; stale: number }): AdsArchiveDecision {
  if (!input.complete) return { archive: false, reason: 'INCOMPLETE' }
  if (input.stale <= 0) return { archive: false, reason: null }
  if (input.read === 0) return { archive: false, reason: 'EMPTY_RESPONSE' }
  if (input.active >= ADS_ARCHIVE_GUARD.minRows && input.stale / input.active > ADS_ARCHIVE_GUARD.maxRatio) return { archive: false, reason: 'TOO_MANY' }
  return { archive: true, reason: null }
}

export const ADS_ARCHIVE_SKIP_LABEL: Record<AdsArchiveSkip, string> = {
  INCOMPLETE: '翻页没有翻完',
  EMPTY_RESPONSE: '接口返回为空',
  TOO_MANY: '要归档的比例过大',
}

const DAY_MS = 86_400_000

/**
 * 定时报告的取数窗口（含起止，今天为止）：已经成功取过的模板每天重拉最近 3 天（亚马逊按流量日期回补）；
 * 第一次取的按日模板回看 30 天，按小时模板取 14 天（保留期上限）。today 不合法返回 null。
 */
export function adsScheduledWindow(granularity: AdsReportGranularity, today: string, filled: boolean): { from: string; to: string } | null {
  const end = dayStamp(today)
  if (end === null) return null
  const limit = ADS_REPORT_LIMITS[granularity].maxDays ?? ADS_INITIAL_FILL_DAYS
  const days = filled ? ADS_DAILY_REFETCH_DAYS : granularity === 'HOURLY' ? limit : Math.min(ADS_INITIAL_FILL_DAYS, limit)
  return { from: new Date(end - (days - 1) * DAY_MS).toISOString().slice(0, 10), to: today }
}

/** 定时报告要取的广告产品：只取档案下确实有活动的产品；没有任何活动记录时先取商品推广（最常见，其他产品随实体同步发现后再加）。 */
export function adsScheduledProducts(campaignProducts: readonly string[]): string[] {
  const known = ADS_REPORT_AD_PRODUCTS.filter(product => campaignProducts.includes(product))
  return known.length > 0 ? known : [ADS_REPORT_AD_PRODUCTS[0]]
}

/**
 * 定时报告对某个广告产品要取的模板。商品推广取全部八个；品牌推广与展示型推广只取活动日报（花费、销售额与利润分摊的基础）——
 * 其余模板对这两个产品是否支持、字段是否一致没有对照过真实账户，不定时排（用户仍可以手动申请）。
 */
export function adsScheduledTemplates(adProduct: string): AdsReportTemplateKey[] {
  return adProduct === ADS_REPORT_AD_PRODUCTS[0] ? ADS_REPORT_TEMPLATES.map(template => template.key) : ['CAMPAIGN_DAILY']
}

/** 排队中或生成中的任务超过这么久还没结束，就当它卡死了（报告最长等 6 小时），不再挡住新的任务，否则这个模板会永远排不上。 */
export const ADS_REPORT_STALE_HOURS = 12

/** 这个档案的某个模板最近已有排队中、生成中或刚刚成功的任务就不重复排。 */
export function adsReportDue(recent: { status: string; createdAt: Date } | null, now: Date): boolean {
  if (!recent) return true
  if (recent.status === 'PENDING' || recent.status === 'GENERATING') return now.getTime() - recent.createdAt.getTime() > ADS_REPORT_STALE_HOURS * 3_600_000
  if (recent.status === 'FAILED') return true
  return now.getTime() - recent.createdAt.getTime() >= ADS_REPORT_MIN_GAP_HOURS * 3_600_000
}
