import {
  SALES_TRAFFIC_DATASET_ASIN,
  SALES_TRAFFIC_DATASET_DATE,
  SALES_TRAFFIC_DATASET_TRENDS,
  SALES_TRAFFIC_NO_BRAND,
  salesTrafficWindowIssue,
  type SalesTrafficAsinGranularity,
  type SalesTrafficGranularity,
} from '@nova/api-contracts'
import type { RowOutcome } from '../streaming/batch'
import type { Row } from '../streaming/rows'
import type { ImportContext } from '../types'
import { DATE_PATTERN, quote, unwrapRecord } from './json'
import { registerDataKioskDataset, type DataKioskDataset, type KioskScope } from './registry'
import { isAsinGranularity, isDateGranularity, readKioskAsinRow, readKioskDateRow } from './sales-traffic-parse'
import { upsertAsinRow, upsertDailyRow } from './sales-traffic-write'

// 数据中心“销售与流量”三个数据集（P4-01，importers.md D-01、D-02、D-03）：analytics_salesAndTraffic_2024_04_24，需要“品牌分析”角色（403 → DK_NO_BRAND）。
//   D-01 salesAndTrafficByDate：店铺按日、周、月汇总（参数 granularity 与窗口），写 SalesTrafficDaily；
//   D-02 salesAndTrafficByAsin：按父体、子体、SKU 汇总（参数 asinGranularity 与单独一天 date），写 SalesTrafficAsinDaily；
//   D-03 salesAndTrafficTrends：ASIN 逐日趋势（一个窗口一次查询），按子体粒度写同一张 ASIN 表。
// 字段对照官方 schema（2026 年 10 月）；**查询的参数名与结果行形状没有对真实店铺核对**：查询被亚马逊拒绝时，执行器会把错误文档写进任务失败原因，
// 只需改这个文件里的查询文本。解析对缺失字段一律当“官方没给”（null），不补 0。

const MARKETPLACE_ID = 'ATVPDKIKX0DER'
const ROOT = 'analytics_salesAndTraffic_2024_04_24'
const AMOUNT = '{ amount currencyCode }'
const SALES = `sales { orderedProductSales ${AMOUNT} orderedProductSalesB2B ${AMOUNT} unitsOrdered unitsOrderedB2B totalOrderItems unitsRefunded refundRate claimsGranted }`
const TRAFFIC = 'traffic { pageViews sessions buyBoxPercentage unitSessionPercentage }'
const NO_BRAND_MESSAGE = '亚马逊拒绝了销售与流量查询（403）：该数据需要“品牌分析”角色，店铺要有品牌备案并在亚马逊后台为应用授权'

function checkWindow(params: Record<string, string>, error: string): { startDate: string; endDate: string } {
  const startDate = params.startDate ?? ''
  const endDate = params.endDate ?? ''
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate) || salesTrafficWindowIssue({ startDate, endDate })) throw new Error(error)
  return { startDate, endDate }
}

export function buildSalesTrafficDateQuery(params: Record<string, string>): string {
  const { startDate, endDate } = checkWindow(params, 'SALES_TRAFFIC_DATE_INVALID')
  const granularity = params.granularity ?? 'DAY'
  if (!isDateGranularity(granularity)) throw new Error('SALES_TRAFFIC_GRANULARITY_INVALID')
  return `{ ${ROOT} { salesAndTrafficByDate(
    startDate: ${quote(startDate)}, endDate: ${quote(endDate)}, aggregateBy: ${granularity}, marketplaceIds: [${quote(MARKETPLACE_ID)}]
  ) { startDate endDate ${SALES} ${TRAFFIC} } } }`
}

const IDENTITY: Record<SalesTrafficAsinGranularity, string> = { PARENT: 'parentAsin', CHILD: 'parentAsin childAsin', SKU: 'parentAsin childAsin sku' }

export function buildSalesTrafficAsinQuery(params: Record<string, string>): string {
  const date = params.date ?? ''
  if (!DATE_PATTERN.test(date)) throw new Error('SALES_TRAFFIC_DATE_INVALID')
  const granularity = params.asinGranularity ?? ''
  if (!isAsinGranularity(granularity)) throw new Error('SALES_TRAFFIC_GRANULARITY_INVALID')
  return `{ ${ROOT} { salesAndTrafficByAsin(
    startDate: ${quote(date)}, endDate: ${quote(date)}, aggregateBy: ${granularity}, marketplaceIds: [${quote(MARKETPLACE_ID)}]
  ) { startDate endDate ${IDENTITY[granularity]} ${SALES} ${TRAFFIC} } } }`
}

export function buildSalesTrafficTrendsQuery(params: Record<string, string>): string {
  const { startDate, endDate } = checkWindow(params, 'SALES_TRAFFIC_DATE_INVALID')
  return `{ ${ROOT} { salesAndTrafficTrends(
    startDate: ${quote(startDate)}, endDate: ${quote(endDate)}, marketplaceIds: [${quote(MARKETPLACE_ID)}]
  ) { startDate endDate parentAsin childAsin ${SALES} ${TRAFFIC} } } }`
}

const meta = () => ({ source: 'DATA_KIOSK' as const, now: new Date() })

async function handleDate(ctx: ImportContext, row: Row, scope: KioskScope, params: Record<string, string>): Promise<RowOutcome> {
  const parsed = readKioskDateRow(unwrapRecord(row, ROOT, 'salesAndTrafficByDate'))
  if (!parsed) return 'skipped'
  await upsertDailyRow(ctx.prisma, scope, (params.granularity ?? 'DAY') as SalesTrafficGranularity, parsed, meta())
  return 'imported'
}

async function handleAsin(ctx: ImportContext, row: Row, scope: KioskScope, params: Record<string, string>): Promise<RowOutcome> {
  const granularity = (params.asinGranularity ?? 'CHILD') as SalesTrafficAsinGranularity
  const parsed = readKioskAsinRow(unwrapRecord(row, ROOT, 'salesAndTrafficByAsin'), granularity)
  if (!parsed) return 'skipped'
  await upsertAsinRow(ctx.prisma, scope, granularity, parsed, meta())
  return 'imported'
}

async function handleTrends(ctx: ImportContext, row: Row, scope: KioskScope): Promise<RowOutcome> {
  const parsed = readKioskAsinRow(unwrapRecord(row, ROOT, 'salesAndTrafficTrends'), 'CHILD')
  if (!parsed) return 'skipped'
  await upsertAsinRow(ctx.prisma, scope, 'CHILD', parsed, meta())
  return 'imported'
}

const common = { reportType: 'DATA_KIOSK_SALES_TRAFFIC', roleMissing: { code: SALES_TRAFFIC_NO_BRAND, message: NO_BRAND_MESSAGE } }

export const salesTrafficDateDataset: DataKioskDataset = { id: SALES_TRAFFIC_DATASET_DATE, buildQuery: buildSalesTrafficDateQuery, handle: handleDate, ...common }
export const salesTrafficAsinDataset: DataKioskDataset = { id: SALES_TRAFFIC_DATASET_ASIN, buildQuery: buildSalesTrafficAsinQuery, handle: handleAsin, ...common }
export const salesTrafficTrendsDataset: DataKioskDataset = { id: SALES_TRAFFIC_DATASET_TRENDS, buildQuery: buildSalesTrafficTrendsQuery, handle: handleTrends, ...common }

export function registerSalesTraffic() {
  registerDataKioskDataset(salesTrafficDateDataset)
  registerDataKioskDataset(salesTrafficAsinDataset)
  registerDataKioskDataset(salesTrafficTrendsDataset)
}
