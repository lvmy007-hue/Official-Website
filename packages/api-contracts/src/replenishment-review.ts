import { z } from 'zod'
import type { DashState } from './dashboard.js'
import type { BatchInboundPlanRef } from './batch-inbound.js'
import type { BatchSnapshot, BatchSummary, RecommendationRow, ReplenishAction } from './replenishment.js'

// 补货建议契约（二）：模拟（库存走势、上游仓储经济模拟）与批次详情、结果回看。第一部分（策略、计算链、批次与建议、动作）在 replenishment.ts。

// ---- 模拟 ----

export const SIM_HORIZON_DAYS = 90
export const SimulateBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('TREND'),
      sellerAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      sku: z.string().trim().min(1).max(120),
      /** 自定义曲线：补货数量与多少天后到仓（都不填则不画自定义曲线）。 */
      customQty: z.number().int().min(0).max(10_000_000).optional(),
      customArriveInDays: z.number().int().min(1).max(365).optional(),
      /** 在途数量没有预计到仓日，模拟按这个天数一次性到达（默认 14 天，页面会写明这个假设）。 */
      inboundArrivalDays: z.number().int().min(1).max(90).default(14),
    })
    .strict(),
  z
    .object({
      kind: z.literal('AWD'),
      sellerAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      sku: z.string().trim().min(1).max(120),
      /** 发往上游仓储的数量（件）。 */
      quantity: z.number().int().min(1).max(10_000_000),
      /** 模拟区间：开始日不早于今天，结束日不晚于今天后 90 天（Data Kiosk 限制）；不填则取今天起 30 天。 */
      endInDays: z.number().int().min(1).max(90).default(30),
    })
    .strict(),
])
export type SimulateBody = z.infer<typeof SimulateBodySchema>

export interface SimPoint {
  day: number
  date: string
  none: number
  recommended: number | null
  custom: number | null
}

export interface TrendSimulation {
  kind: 'TREND'
  state: DashState
  note: string | null
  points: SimPoint[]
  /** 各曲线的断货区间（库存降到 0 以下的连续日期段，含天数与缺口件数）。 */
  stockouts: { none: StockoutRange[]; recommended: StockoutRange[]; custom: StockoutRange[] }
  assumptions: string[]
  dailyDemand: number | null
}
export interface StockoutRange {
  from: string
  to: string
  days: number
  shortage: number
}

export interface AwdSimulation {
  kind: 'AWD'
  runId: string
  /** PENDING 排队或运行中；DONE 已出结果；FAILED 失败。 */
  status: 'PENDING' | 'DONE' | 'FAILED'
  note: string | null
  input: { quantity: number; startDate: string; endDate: string; sku: string }
  result: AwdEconomics | null
}
export interface AwdEconomics {
  currency: string | null
  sales: number | null
  fees: number | null
  netProceeds: number | null
  /** 与“不发上游仓储”的基线相比的变化需要两次模拟对比，本版只展示官方返回的估算值。 */
  rows: number
}
export type SimulationResponse = TrendSimulation | AwdSimulation

// ---- 批次详情与结果回看 ----

export interface OutcomeRow {
  recommendationId: string
  sku: string
  evaluatedAt: string
  windowStart: string
  windowEnd: string
  forecastQty: number
  actualQty: number
  /** (预测 − 实际) ÷ 实际；实际为 0 时为 null。 */
  errorPct: number | null
  stockoutDays: number
  /** 评估日库存相对“实际日销 × 目标覆盖天数”的多余件数；评估日没有库存数量时为 null（不当 0）。 */
  excessUnits: number | null
}

export interface BatchDetailResponse {
  batch: BatchSummary
  snapshot: BatchSnapshot
  items: RecommendationRow[]
  page: number
  pageSize: number
  total: number
  execution: {
    purchaseOrders: Array<{ id: string; number: string; status: string; lineCount: number }>
    /** 本批次生成的上游仓储入库订单草稿：reference 是我方的外部参考号；status 是订单当前状态（会随提交、确认变化）。 */
    awdOrders: Array<{ id: string; reference: string | null; status: string; statusLabel: string; lineCount: number }>
    /** 本批次转来的入仓计划草稿（P6-08）：stage 是计划当前阶段，会随提交、确认变化。 */
    inboundPlans: BatchInboundPlanRef[]
    actionCounts: Record<ReplenishAction, number>
    pendingTargets: number
  }
  review: {
    outcomes: OutcomeRow[]
    summary: { evaluated: number; meanAbsErrorPct: number | null; stockoutDays: number }
    /** 是否按时到仓需要入仓计划与货件接收（P2a-12、P2a-13），尚未接入。 */
    arrival: { state: 'NOT_CONNECTED'; note: string }
  }
}

export interface EvaluateResponse {
  evaluated: number
  skipped: number
  note: string
}

export const REPLENISH_METHOD = 'replenishment-chain@1'
