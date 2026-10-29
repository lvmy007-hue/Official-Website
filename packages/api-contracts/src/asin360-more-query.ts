import { z } from 'zod'
import { BA_PERIODS } from './brand-analytics.js'
import { isDateText, isPeriodStart } from './brand-analytics-math.js'

// ASIN 360 流量转化与竞品页签自己的请求参数（P4-08）：日期范围由全局范围参数（ScopeSearchSchema）校验，这里只校验品牌分析的周期种类与周期起始日。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

export const Asin360PeriodQuerySchema = z
  .object({
    period: z.enum(BA_PERIODS, { error: '周期只能是 WEEK、MONTH、QUARTER' }).default('WEEK'),
    periodStart: z
      .string()
      .trim()
      .refine(value => isDateText(value), { error: '周期起始日应为 YYYY-MM-DD' })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.periodStart && !isPeriodStart(value.period, value.periodStart)) {
      ctx.addIssue({ code: 'custom', path: ['periodStart'], message: '周期起始日与周期种类不对齐：周要选周日，月要选 1 日，季要选 1、4、7、10 月的 1 日' })
    }
  })

export type Asin360PeriodQuery = z.infer<typeof Asin360PeriodQuerySchema>
