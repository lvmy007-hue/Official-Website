import { z } from 'zod'
import { CursorParamsSchema } from './query.js'
import type { DashState } from './dashboard.js'

// 今日实时契约（P2a-03，04 章 4.2）：三个读接口的响应形状与状态语义。
// realtimeState：
//   LIVE          推送接收端已配置且有小时事件；
//   NOT_CONNECTED 接收端未配置（14.10 部署专项暂缓）——页面显示正式“未接入”，并退化展示日终数据；
//   NO_DATA       接收端已配置，但今日尚无小时事件。

export type TodayRealtimeState = 'LIVE' | 'NOT_CONNECTED' | 'NO_DATA'

export const TODAY_ESTIMATE_NOTE = '实时估算，以日终数据为准；推送最长可能延迟 24 小时补发'
export const TODAY_NOT_CONNECTED_NOTE = '实时数据未接入：需要部署专项配置亚马逊消息推送接收端（AMAZON_NOTIFICATION_DESTINATION_ID）并完成订阅。暂缓期间退化展示最近一次日终数据。'
export const TODAY_ADS_NOTE = '今日广告依赖营销数据流第二版接收端（部署专项），暂缓期间未接入'
export const TODAY_METRIC_VERSION = 'p2a-03@1'

export const TodayEventsQuerySchema = CursorParamsSchema
export type TodayEventsQuery = z.infer<typeof TodayEventsQuerySchema>

export interface TodayCompareSlice {
  units: number
  salesAmount: number
  label: string
}

export interface TodaySummaryResponse {
  realtimeState: TodayRealtimeState
  note: string
  estimateNote: string
  /** 企业时区日历日 YYYY-MM-DD */
  businessDate: string
  /** 累计截至时刻（ISO）；未接入时为日终汇总刷新时间或 null */
  asOf: string | null
  currency: 'USD'
  metricVersion: string
  /** 今日累计（推送估算或日终退化） */
  totals: { units: number | null; salesAmount: number | null; orders: number | null }
  compare: {
    yesterdaySameHour: TodayCompareSlice | null
    lastWeekSameHour: TodayCompareSlice | null
  }
  /** 库存实时摘要 */
  inventory: {
    state: DashState
    note: string | null
    outOfStock: Array<{ asin: string; availableQty: number }>
    predictedStockout: Array<{ asin: string; availableQty: number; predictedAtHour: string; note: string }>
  }
  /** 今日广告区：部署专项未就绪时一律 NOT_CONNECTED */
  ads: { state: 'NOT_CONNECTED'; note: string; workPackage: 'P3-06' }
  /** 日终退化数据（仅 NOT_CONNECTED / 无小时事件时有意义） */
  dailyFallback: { units: number; salesAmount: number; orders: number; summaryDate: string; refreshedAt: string | null } | null
}

export interface TodayHourBucket {
  hourStart: string
  units: number
  salesAmount: number
  pageViews: number | null
  /** 过去 4 个同星期几同小时的区间 */
  band: { unitsMin: number; unitsMax: number; pageViewsMin: number | null; pageViewsMax: number | null } | null
}

export interface TodayAnomaly {
  asin: string
  hourStart: string
  metric: 'sales' | 'traffic'
  value: number
  bandMin: number
  title: string
  suggestedAction: string
}

export interface TodayHourlyResponse {
  realtimeState: TodayRealtimeState
  note: string
  estimateNote: string
  businessDate: string
  asOf: string | null
  currency: 'USD'
  hours: TodayHourBucket[]
  anomalies: TodayAnomaly[]
}

export interface TodayEventItem {
  id: string
  occurredAt: string
  kind: string
  title: string
  entityType: string
  entityId: string
  sellerAccountId: string | null
}

export interface TodayEventsResponse {
  realtimeState: TodayRealtimeState
  note: string
  items: TodayEventItem[]
  pageInfo: { pageSize: number; nextCursor: string | null; hasMore: boolean; approxTotal: number | null }
}
