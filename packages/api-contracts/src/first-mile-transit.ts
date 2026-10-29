import type { FirstMileMode } from './first-mile.js'

// 头程实际时效统计的响应类型（从 first-mile.ts 拆出，保持单文件不超过 400 行）。

export interface TransitMonthPoint {
  month: string
  sampleCount: number
  p50Days: number
  p90Days: number
}
export interface TransitStatRow {
  forwarderId: string
  forwarderName: string
  mode: FirstMileMode
  modeLabel: string
  sampleCount: number
  p50Days: number | null
  p90Days: number | null
  minDays: number | null
  maxDays: number | null
  monthly: TransitMonthPoint[]
  /** 企业级补货策略里这个运输方式现在设的时效（天）；没设为 null。 */
  policyTransitDays: number | null
  /** 能不能回写；不能时写明原因。 */
  applyBlocked: string | null
}
export interface TransitApplyResult {
  versionNo: number
  mode: FirstMileMode
  /** 回写后企业级补货策略里这个运输方式的时效（天）与回写前的值（原来没设为 null）。 */
  transitDays: number
  previousDays: number | null
}
export interface TransitStatsResponse {
  rows: TransitStatRow[]
  /** 企业级补货策略当前版本；没有配置为 null（需要先到补货策略页保存）。 */
  policyVersionNo: number | null
  basis: string
}
