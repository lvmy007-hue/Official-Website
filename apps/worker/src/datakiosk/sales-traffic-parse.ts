import { SALES_TRAFFIC_ASIN_GRANULARITIES, SALES_TRAFFIC_GRANULARITIES, percentToFraction, type SalesTrafficAsinGranularity, type SalesTrafficGranularity } from '@nova/api-contracts'
import { count, dateOf, get, money, round } from './json'

// 销售与流量结果行的解析（P4-01，importers.md D-01、D-02、D-03、R-34）：数据中心行与报告 JSON 行共用的取值逻辑，纯函数，不碰数据库。
// 数据中心的行是 { startDate, endDate, sales: {...}, traffic: {...} }（ASIN 行另有 parentAsin、childAsin、sku）；
// 报告 JSON 的行把同样的两块叫 salesByDate / trafficByDate、salesByAsin / trafficByAsin。两边字段名一致，所以统一成“销售块 + 流量块”再读。
// 字段对照官方 analytics_salesAndTraffic_2024_04_24 的 schema 与 GET_SALES_AND_TRAFFIC_REPORT 的 JSON 样例（2026 年 10 月）；**未对真实店铺核对**：
// 官方没给的值一律是 null（不补 0）；比率是官方百分数，换算成 0 到 1 的小数；负数、超过整型上限的计数当作“没给”。

export interface TrafficFigures {
  orderedSales: number | null
  unitsOrdered: number | null
  ordersCount: number | null
  sessions: number | null
  pageViews: number | null
  buyBoxPct: number | null
  unitSessionPct: number | null
  unitsRefunded: number | null
  refundRate: number | null
  claimsGranted: number | null
  b2bSales: number | null
  b2bUnits: number | null
  /** 订购销售额的币种；没有销售额时为 null（调用方用美元兜底会误标，所以交给写入层决定）。 */
  currency: string | null
}

const INT_MAX = 2_147_483_647
/** 数量类：必须是 0 到整型上限之间的数，否则当作官方没给。 */
const qty = (value: unknown): number | null => {
  const n = count(value)
  return n !== null && n >= 0 && n <= INT_MAX ? Math.trunc(n) : null
}

/** 销售块与流量块 → 统一字段。两块都不是对象时返回 null（这一行没有可用的指标）。 */
export function readFigures(sales: unknown, traffic: unknown): TrafficFigures | null {
  const isObject = (value: unknown) => Boolean(value) && typeof value === 'object'
  if (!isObject(sales) && !isObject(traffic)) return null
  const ordered = money(get(sales, 'orderedProductSales'))
  const b2b = money(get(sales, 'orderedProductSalesB2B'))
  return {
    orderedSales: ordered ? round(ordered.amount) : null,
    unitsOrdered: qty(get(sales, 'unitsOrdered')),
    ordersCount: qty(get(sales, 'totalOrderItems')),
    sessions: qty(get(traffic, 'sessions')),
    pageViews: qty(get(traffic, 'pageViews')),
    buyBoxPct: percentToFraction(get(traffic, 'buyBoxPercentage')),
    unitSessionPct: percentToFraction(get(traffic, 'unitSessionPercentage')),
    unitsRefunded: qty(get(sales, 'unitsRefunded')),
    refundRate: percentToFraction(get(sales, 'refundRate')),
    claimsGranted: qty(get(sales, 'claimsGranted')),
    b2bSales: b2b ? round(b2b.amount) : null,
    b2bUnits: qty(get(sales, 'unitsOrderedB2B')),
    currency: ordered?.currency ?? b2b?.currency ?? null,
  }
}

export interface ParsedDateRow extends TrafficFigures {
  date: string
}

export interface ParsedAsinRow extends TrafficFigures {
  date: string
  asin: string
  /** SKU 粒度才有值；其他粒度为空串（唯一键用）。 */
  sku: string
  parentAsin: string | null
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** 数据中心的店铺日期行；没有日期或没有任何指标返回 null。 */
export function readKioskDateRow(item: unknown): ParsedDateRow | null {
  const date = dateOf(get(item, 'startDate'))
  const figures = readFigures(get(item, 'sales'), get(item, 'traffic'))
  return date && figures ? { date, ...figures } : null
}

/** 报告 JSON 的店铺日期行（date、salesByDate、trafficByDate）。 */
export function readReportDateRow(item: unknown): ParsedDateRow | null {
  const date = dateOf(get(item, 'date'))
  const figures = readFigures(get(item, 'salesByDate'), get(item, 'trafficByDate'))
  return date && figures ? { date, ...figures } : null
}

type AsinIdentity = { asin: string; sku: string; parentAsin: string | null }

/** 按粒度取这一行的身份：父体用 parentAsin；子体用 childAsin；SKU 用 childAsin + sku。缺身份返回 null。 */
function asinIdentity(item: unknown, granularity: SalesTrafficAsinGranularity): AsinIdentity | null {
  const parent = text(get(item, 'parentAsin'))
  const child = text(get(item, 'childAsin'))
  const sku = text(get(item, 'sku'))
  if (granularity === 'PARENT') return parent ? { asin: parent, sku: '', parentAsin: null } : null
  if (!child) return null
  if (granularity === 'SKU') return sku ? { asin: child, sku, parentAsin: parent } : null
  return { asin: child, sku: '', parentAsin: parent }
}

/** 数据中心的 ASIN 行。一行必须落在单独的一天（开始日 = 结束日，没给结束日按开始日）：跨多天的汇总行放不进日表，返回 null。 */
export function readKioskAsinRow(item: unknown, granularity: SalesTrafficAsinGranularity): ParsedAsinRow | null {
  const date = dateOf(get(item, 'startDate'))
  const end = dateOf(get(item, 'endDate'))
  const identity = asinIdentity(item, granularity)
  const figures = readFigures(get(item, 'sales'), get(item, 'traffic'))
  if (!date || (end && end !== date) || !identity || !figures) return null
  return { date, ...identity, ...figures }
}

/** 报告 JSON 的 ASIN 行：行里没有日期，日期由调用方给（报告窗口只有一天时才有意义）。 */
export function readReportAsinRow(item: unknown, granularity: SalesTrafficAsinGranularity, date: string): ParsedAsinRow | null {
  const identity = asinIdentity(item, granularity)
  const figures = readFigures(get(item, 'salesByAsin'), get(item, 'trafficByAsin'))
  return identity && figures ? { date, ...identity, ...figures } : null
}

export const isDateGranularity = (value: unknown): value is SalesTrafficGranularity => (SALES_TRAFFIC_GRANULARITIES as readonly unknown[]).includes(value)
export const isAsinGranularity = (value: unknown): value is SalesTrafficAsinGranularity => (SALES_TRAFFIC_ASIN_GRANULARITIES as readonly unknown[]).includes(value)
