import { z } from 'zod'
import { WEB_VITAL_NAMES } from './route-template.js'

// 前端性能埋点上报（P1-09，12 章 12.4）：只上报“指标名、耗时、路由模板”，
// 不含用户、租户、店铺、订单等任何标识，也不含地址栏参数，避免采集个人信息。
// 指标名与路径模板归一在 route-template.ts（不依赖 zod，前端首屏用）。

export const WebVitalItemSchema = z
  .object({
    name: z.enum(WEB_VITAL_NAMES),
    valueMs: z.number().finite().min(0).max(600_000),
    /** 路由模板，如 `/app/orders/$orderId`；接口耗时则为接口路径模板。不得含具体编号与查询参数。 */
    route: z
      .string()
      .max(120)
      .regex(/^[\w\-/:$.{}]*$/, '路由模板只能包含字母、数字与路径符号'),
  })
  .strict()

export const WebVitalsReportSchema = z.object({ items: z.array(WebVitalItemSchema).min(1).max(30) }).strict()
export type WebVitalsReport = z.infer<typeof WebVitalsReportSchema>
