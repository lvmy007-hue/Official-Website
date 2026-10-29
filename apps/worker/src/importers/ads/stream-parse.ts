import { ADS_STREAM_ID_UNRESOLVED } from '@nova/api-contracts'
import { decodeUtf8, jsonRows, type Row } from '../../streaming/rows'

// 营销数据流第二版（Marketing Stream v2，importers.md A-03）的解析器。**接收端（存储桶与队列通知）是部署专项，暂缓（14.10）**：
// 这里只做“拿到一个投递文件之后怎么解析”，不接队列、不写库；P3-06 今日广告接入时再接。
// 数据集：ads-performance-v1（小时级）与 ads-converted-product-v1（日级，ASIN 级转化，含光环销售）。
// **字段名没有对照真实投递文件**（官方约 400 项指标、50 余个维度）：只读业务页用到的核心列，其余列不落库、由原始文件留存；
// 兼容下划线与驼峰两种写法。已知限制（官方文档）：不含预算消耗与实体变更；投放对象只带编号；低于阈值的搜索词归入“其他”。

export type StreamEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'AD' | 'TARGET'

export type StreamHourly = {
  hourStart: Date
  entityType: StreamEntityType
  entityId: string
  campaignId: string | null
  searchTerm: string | null
  /** 搜索词低于阈值被官方归入“其他”：不是某个具体的词。 */
  otherBucket: boolean
  impressions: number | null
  clicks: number | null
  cost: number | null
  sales: number | null
  purchases: number | null
  currency: string | null
}

export type StreamConverted = {
  date: string
  campaignId: string
  advertisedAsin: string
  purchasedAsin: string
  units: number | null
  sales: number | null
  /** 光环销售：买走的商品与被推广的商品不是同一个 ASIN。 */
  isHalo: boolean
}

export type StreamSkip = { skipped: 'NO_HOUR' | 'NO_ENTITY' | 'NO_DATE' | 'NO_CAMPAIGN' | 'NO_ASIN' }

const first = (row: Row, names: string[]) => {
  for (const name of names) {
    const value = row[name]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}
const textOf = (row: Row, names: string[]) => {
  const value = first(row, names)
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}
const numberOf = (row: Row, names: string[]): number | null => {
  const value = first(row, names)
  if (value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

const OTHER_TERMS = new Set(['other', 'others', '__other__', '其他'])
const hourOf = (value: string): Date | null => {
  if (!value) return null
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value)
  if (Number.isNaN(date.getTime())) return null
  date.setUTCMinutes(0, 0, 0)
  return date
}

/** 小时级表现：按最具体的编号定实体类型（投放对象 > 广告 > 广告组 > 活动）。 */
export function parseStreamHourly(row: Row): StreamHourly | StreamSkip {
  const hourStart = hourOf(textOf(row, ['time_window_start', 'timeWindowStart', 'hour_start', 'hourStart', 'start_time']))
  if (!hourStart) return { skipped: 'NO_HOUR' }
  const campaignId = textOf(row, ['campaign_id', 'campaignId']) || null
  const candidates: Array<[StreamEntityType, string]> = [
    ['TARGET', textOf(row, ['target_id', 'targetId', 'keyword_id', 'keywordId'])],
    ['AD', textOf(row, ['ad_id', 'adId'])],
    ['AD_GROUP', textOf(row, ['ad_group_id', 'adGroupId'])],
    ['CAMPAIGN', campaignId ?? ''],
  ]
  const found = candidates.find(([, id]) => id)
  if (!found) return { skipped: 'NO_ENTITY' }
  const searchTerm = textOf(row, ['search_term', 'searchTerm', 'customer_search_term']) || null
  return {
    hourStart,
    entityType: found[0],
    entityId: found[1],
    campaignId,
    searchTerm,
    otherBucket: searchTerm !== null && OTHER_TERMS.has(searchTerm.toLowerCase()),
    impressions: numberOf(row, ['impressions']),
    clicks: numberOf(row, ['clicks']),
    cost: numberOf(row, ['cost', 'spend']),
    sales: numberOf(row, ['sales', 'sales_1d', 'sales1d', 'attributed_sales']),
    purchases: numberOf(row, ['purchases', 'purchases_1d', 'purchases1d', 'orders']),
    currency: textOf(row, ['currency', 'currency_code', 'currencyCode']) || null,
  }
}

/** 日级转化商品：被推广商品与购买商品不同就是光环销售。 */
export function parseStreamConverted(row: Row): StreamConverted | StreamSkip {
  const date = /^(\d{4}-\d{2}-\d{2})/.exec(textOf(row, ['date', 'conversion_date', 'conversionDate', 'time_window_start', 'timeWindowStart']))?.[1]
  if (!date) return { skipped: 'NO_DATE' }
  const campaignId = textOf(row, ['campaign_id', 'campaignId'])
  if (!campaignId) return { skipped: 'NO_CAMPAIGN' }
  const advertisedAsin = textOf(row, ['advertised_asin', 'advertisedAsin']).toUpperCase()
  const purchasedAsin = textOf(row, ['purchased_asin', 'purchasedAsin']).toUpperCase()
  if (!advertisedAsin || !purchasedAsin) return { skipped: 'NO_ASIN' }
  return {
    date,
    campaignId,
    advertisedAsin,
    purchasedAsin,
    units: numberOf(row, ['units', 'units_sold', 'unitsSold', 'purchases']),
    sales: numberOf(row, ['sales', 'sales_14d', 'sales14d']),
    isHalo: advertisedAsin !== purchasedAsin,
  }
}

export type StreamDataset = 'ads-performance-v1' | 'ads-converted-product-v1'
export type StreamStats = { read: number; skipped: number; skippedReasons: Record<string, number> }
export const newStreamStats = (): StreamStats => ({ read: 0, skipped: 0, skippedReasons: {} })

/** 一个投递文件（字节流）→ 解析后的记录流；跳过的行计数。文件是逐行 JSON 或 JSON 数组都行。 */
export async function* streamRecords(source: AsyncIterable<Buffer | string>, dataset: StreamDataset, stats: StreamStats = newStreamStats()): AsyncGenerator<StreamHourly | StreamConverted> {
  for await (const row of jsonRows(decodeUtf8(source))) {
    stats.read += 1
    const parsed = dataset === 'ads-performance-v1' ? parseStreamHourly(row) : parseStreamConverted(row)
    if ('skipped' in parsed) {
      stats.skipped += 1
      stats.skippedReasons[parsed.skipped] = (stats.skippedReasons[parsed.skipped] ?? 0) + 1
    } else yield parsed
  }
}

/** 投放对象只带编号：查得到名称就用名称，查不到显示编号并标记 STREAM_ID_UNRESOLVED（名称由广告实体同步提供）。 */
export function streamLabel(names: ReadonlyMap<string, string>, entityType: StreamEntityType, entityId: string): { label: string; code?: typeof ADS_STREAM_ID_UNRESOLVED } {
  const name = names.get(`${entityType}:${entityId}`)
  return name ? { label: name } : { label: entityId, code: ADS_STREAM_ID_UNRESOLVED }
}
