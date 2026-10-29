import { z } from 'zod'
import { DASH_GRANULARITIES } from './dashboard'

// 广告控制台的请求参数（P3-05）：范围参数（店铺、日期、对比期）走全局范围校验，这里只有页面自己的粒度。
// 单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。
export const AdsOverviewQuerySchema = z.object({ granularity: z.enum(DASH_GRANULARITIES).default('day') })
export type AdsOverviewQuery = z.infer<typeof AdsOverviewQuerySchema>
