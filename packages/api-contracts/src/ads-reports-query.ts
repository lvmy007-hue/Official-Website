import { z } from 'zod'
import { ADS_BACKFILL_MONTHS_DEFAULT, ADS_BACKFILL_MONTHS_MAX, ADS_REPORT_AD_PRODUCTS, ADS_REPORT_SOURCES, ADS_REPORT_STATUSES, ADS_REPORT_TEMPLATE_KEYS } from './ads-reports'
import { cursorListQuery } from './query'

// 广告报表的请求校验（P3-15）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

const ID = /^[A-Za-z0-9_-]{1,64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** 报告任务列表：状态、来源、模板、广告档案筛选，按创建时间排序（全局范围参数里的日期不用于本列表）。 */
export const AdsReportListQuerySchema = cursorListQuery({
  sortable: ['createdAt'] as const,
  defaultSort: { field: 'createdAt', dir: 'desc' },
  filters: {
    status: { type: 'enum', values: ADS_REPORT_STATUSES },
    source: { type: 'enum', values: ADS_REPORT_SOURCES },
    templateKey: { type: 'enum', values: ADS_REPORT_TEMPLATE_KEYS },
    adsProfileId: { type: 'text', max: 64 },
  },
})
export type AdsReportListQuery = z.infer<typeof AdsReportListQuerySchema>

/** 创建新报告接口任务：模板、广告产品、起止日期（含起止）。时间范围上限按模板粒度在服务端检查（ADS_REPORT_WINDOW 的说明文字）。 */
export const AdsReportCreateBodySchema = z
  .object({
    profileId: z.string().regex(ID, '广告档案编号格式不正确'),
    templateKey: z.enum(ADS_REPORT_TEMPLATE_KEYS),
    adProduct: z.enum(ADS_REPORT_AD_PRODUCTS).default('SPONSORED_PRODUCTS'),
    from: z.string().regex(DAY, '日期格式应为 YYYY-MM-DD'),
    to: z.string().regex(DAY, '日期格式应为 YYYY-MM-DD'),
  })
  .strict()
export type AdsReportCreateBody = z.infer<typeof AdsReportCreateBodySchema>

/** 历史回补：从今天往前 N 个月，按 120 天切片各建一个活动日报任务。 */
export const AdsReportBackfillBodySchema = z
  .object({
    profileId: z.string().regex(ID, '广告档案编号格式不正确'),
    adProduct: z.enum(ADS_REPORT_AD_PRODUCTS).default('SPONSORED_PRODUCTS'),
    months: z.coerce.number().int().min(1).max(ADS_BACKFILL_MONTHS_MAX).default(ADS_BACKFILL_MONTHS_DEFAULT),
  })
  .strict()
export type AdsReportBackfillBody = z.infer<typeof AdsReportBackfillBodySchema>

/** 手动触发一次新旧接口核对（核对本身每天最多跑一次，见 worker 的 shouldRunParity）。 */
export const AdsParityRunBodySchema = z.object({ profileId: z.string().regex(ID, '广告档案编号格式不正确') }).strict()
export type AdsParityRunBody = z.infer<typeof AdsParityRunBodySchema>
