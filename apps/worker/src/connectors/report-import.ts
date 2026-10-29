import {
  BA_REPORT_TYPES,
  COUPON_REPORT_TYPE,
  LISTING_FYP_REPORT_TYPE,
  PROMOTION_REPORT_TYPE,
  REIMBURSEMENT_REPORT_TYPE,
  RETURNS_REPORT_TYPE,
  SALES_TAX_REPORT_TYPE,
  SALES_TRAFFIC_REPORT_TYPE,
  SELLER_PERFORMANCE_REPORT_TYPE,
  SETTLEMENT_REPORT_TYPE,
} from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import { sellerPerformanceImporter } from '../importers/account-health/seller-performance'
import { brandImporterFor } from '../importers/brand/registry'
import { syncSalesTaxReport } from '../importers/tax/sales-tax-report'
import { syncSalesTrafficReport } from '../importers/sales-traffic/report'
import { syncReimbursementsReport } from '../importers/reimbursements/report'
import { syncCatalogReport } from '../importers/catalog/report'
import { feeBaselineImporterFor } from '../importers/finance/fee-baseline'
import { syncSettlementReport } from '../importers/finance/settlement-report'
import { inventoryImporterFor, type RowsImporter } from '../importers/inventory/registry'
import { fulfillmentImporterFor } from '../importers/orders/fulfillment-reports'
import { syncOrdersReport } from '../importers/orders/report'
import { syncReturnsReport } from '../importers/returns/report'
import { fypReportImporter } from '../importers/listings/fyp-report'
import { couponReportImporter, promotionReportImporter } from '../importers/promotions/reports'
import { capturingColumns } from '../reports/job-state'
import { drain } from '../streaming/download'
import type { RawFileOpener, RawFileRecord } from '../streaming/raw-files'
import { jsonArrayRows } from '../streaming/json-array'
import { decodeUtf8, jsonRows, readLines, tsvRows } from '../streaming/rows'
import type { ImportContext } from '../types'
import type { AmazonSpApiClient } from './amazon-sp-api'

// 亚马逊平面文件报告的流式导入：报告类型 → 导入器；下载流 → 解压流 → 逐行解析 → 分批写库；原始文件同时留存到对象存储。

export type { RowsImporter }

/** 内容是 JSON 而不是制表符分隔文本的报告类型。JSON 报告整份是一个对象，单个对象超过 MAX_JSON_ELEMENT_CHARS（500 万字符）会以明确的错误失败，不静默截断。 */
const JSON_REPORT_TYPES = new Set<string>([SALES_TRAFFIC_REPORT_TYPE, SELLER_PERFORMANCE_REPORT_TYPE])

const ORDER_REPORT_TYPES: readonly string[] = ['GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL']

const utcToday = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** 按报告类型选择导入器；没有对应导入器时抛错（调用方应在下载之前调用）。snapshotDate：企业数据口径时区的“今天”，没有日期列的快照类报告用它。 */
export function reportImporterFor(
  reportJob: { id?: string; reportType: string; documentId: string | null; sellerAccountId: string | null; fromDate?: Date | null; toDate?: Date | null },
  scope: { tenantId: string; sellerAccountId: string; marketplaceId: string; snapshotDate?: Date },
): RowsImporter {
  const { tenantId, sellerAccountId, marketplaceId } = scope
  const type = reportJob.reportType
  const inventory = inventoryImporterFor(type, { tenantId, sellerAccountId, snapshotDate: scope.snapshotDate ?? utcToday(), reportJobId: reportJob.id }, marketplaceId)
  if (inventory) return inventory
  // 订单页（P2b-01）的物流报告：包裹（R-03）与替换关联（R-05），个人信息列一律不读
  const fulfillment = fulfillmentImporterFor(type, { tenantId, sellerAccountId, reportJobId: reportJob.id })
  if (fulfillment) return fulfillment
  // 费用核查（P2b-06）：预估配送费（R-23）与佣金预览（R-24）两份基准报告
  const baseline = feeBaselineImporterFor(type, { tenantId, sellerAccountId, snapshotDate: scope.snapshotDate ?? utcToday(), reportJobId: reportJob.id })
  if (baseline) return baseline
  if (type === 'GET_MERCHANT_LISTINGS_ALL_DATA') return (ctx, rows) => syncCatalogReport(ctx, rows, reportJob, tenantId, marketplaceId)
  // 退货页（P2b-02）：客户退货报告（R-26）；只认这一个类型（卖家自发货退货报告不是本系统范围）
  if (type === RETURNS_REPORT_TYPE) return (ctx, rows) => syncReturnsReport(ctx, rows, tenantId, sellerAccountId, marketplaceId, { reportJobId: reportJob.id })
  // 赔付中心（P2b-03，CR-002）：官方赔付明细报告（R-27）
  if (type === REIMBURSEMENT_REPORT_TYPE) return (ctx, rows) => syncReimbursementsReport(ctx, rows, tenantId, sellerAccountId, { reportJobId: reportJob.id })
  // 结算交易（P2b-07，R-28）：只认唯一保留的结算报告格式 V2 flat file（另两种格式 2026-11-11 移除）
  if (type === SETTLEMENT_REPORT_TYPE) return (ctx, rows) => syncSettlementReport(ctx, rows, tenantId, sellerAccountId, marketplaceId, { reportJobId: reportJob.id })
  // 销售税（P2b-12，R-33）：税务文档库报告，只能检索不能申请；按州汇总，不读订单号与收货地址列
  if (type === SALES_TAX_REPORT_TYPE) return (ctx, rows) => syncSalesTaxReport(ctx, rows, tenantId, sellerAccountId, { reportJobId: reportJob.id })
  // 销售与流量（P4-01，R-34）：JSON 报告，数据中心（D-01、D-02）的补充来源；与数据中心同键数据差异超过阈值时只记录不覆盖
  if (type === SALES_TRAFFIC_REPORT_TYPE)
    return (ctx, rows) => syncSalesTrafficReport(ctx, rows, tenantId, sellerAccountId, { reportJobId: reportJob.id, from: reportJob.fromDate, to: reportJob.toDate })
  // 品牌分析（P4-04，R-35 至 R-39）：五份 JSON 报告，周期取行内起止日、没有则取申请窗口
  const brand = brandImporterFor(type, { tenantId, sellerAccountId }, { reportJobId: reportJob.id, from: reportJob.fromDate, to: reportJob.toDate })
  if (brand) return brand
  // 促销与优惠券（P4-05，R-40、R-41）：绩效报告按映射编号与日写入，与促销接口的 trackingId 关联
  if (type === PROMOTION_REPORT_TYPE) return promotionReportImporter({ tenantId, sellerAccountId }, { reportJobId: reportJob.id })
  if (type === COUPON_REPORT_TYPE) return couponReportImporter({ tenantId, sellerAccountId }, { reportJobId: reportJob.id })
  // 刊登质量（P4-10，R-32）：被搜索抑制的刊登，写成搜索抑制类刊登问题
  if (type === LISTING_FYP_REPORT_TYPE) return fypReportImporter({ tenantId, sellerAccountId }, { reportJobId: reportJob.id })
  // 账户健康（P5-02，R-42）：卖家表现报告（JSON），每个店铺每天一份快照；解析是宽松的，字段依据文档整理（CR-092 未验证清单）
  if (type === SELLER_PERFORMANCE_REPORT_TYPE)
    return sellerPerformanceImporter({ tenantId, sellerAccountId, marketplaceId }, { reportJobId: reportJob.id, snapshotDate: scope.snapshotDate ?? utcToday() })
  // 订单报告（R-01、R-02）：按下单日期与按更新时间两种，与订单接口同键
  if (ORDER_REPORT_TYPES.includes(type)) return (ctx, rows) => syncOrdersReport(ctx, rows, tenantId, sellerAccountId, marketplaceId)
  // 到这里的都不是报表中心目录里的类型（目录里每一项都有导入器，由 report-catalog.test.ts 逐项核对），不是“导入器没写完”：
  // 创建入口只认目录，所以只有绕过入口写进库里的任务才会走到这里，按不可重试的失败处理。
  throw new NonRetryableError('REPORT_TYPE_NOT_REGISTERED', `报告类型 ${type} 不在报表中心目录里`)
}

export interface ReportDocumentMeta {
  tenantId: string
  reportJobId: string
  reportType: string
  /** 留存登记所需：店铺归属与时间范围。 */
  record: Omit<RawFileRecord, 'rowCount'>
  /** 原始文件名（用于对象存储路径）。 */
  fileName: string
}

/**
 * 下载并流式导入一份报告文档。读到数据行但一行都没写入，说明列名与预期不符，按失败处理（不把空导入当成功）。
 * 原始文件（解压之前）同时写入对象存储：导入成功后登记，失败则丢弃。
 */
export async function importReportDocument(
  deps: ImportContext & { openRawFile?: RawFileOpener },
  client: Pick<AmazonSpApiClient, 'openReportDocument'>,
  documentId: string,
  importer: RowsImporter,
  meta: ReportDocumentMeta,
): Promise<{ imported: number; read: number; skipped: number | undefined; columns: string[]; downloadUrl: string | undefined }> {
  const raw = deps.openRawFile?.({ tenantId: meta.tenantId, domain: 'reports', name: meta.fileName })
  try {
    const { metadata, stream } = await client.openReportDocument(documentId, { sink: raw?.sink })
    const parsed = BA_REPORT_TYPES.includes(meta.reportType) ? jsonArrayRows(decodeUtf8(stream)) : JSON_REPORT_TYPES.has(meta.reportType) ? jsonRows(decodeUtf8(stream)) : tsvRows(readLines(stream))
    // 第一行的键就是文件的字段名，留下来与上一份同类报告对比（报表中心的“新出现的字段”警告）
    let columns: string[] = []
    const result = await importer(
      deps,
      capturingColumns(parsed, found => (columns = found)),
    )
    await drain(stream)
    if (result.read > 0 && result.imported === 0) throw new Error('REPORT_ROWS_NOT_IMPORTED')
    await raw?.complete({ ...meta.record, rowCount: result.read })
    return { imported: result.imported, read: result.read, skipped: result.skipped, columns, downloadUrl: typeof metadata.url === 'string' ? metadata.url : undefined }
  } catch (error) {
    await raw?.discard()
    throw error
  }
}
