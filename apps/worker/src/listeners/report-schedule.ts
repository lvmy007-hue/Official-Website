import { BA_REPORT_TYPES, COUPON_REPORT_TYPE, LISTING_FYP_REPORT_TYPE, PROMOTION_REPORT_TYPE, SALES_TRAFFIC_REPORT_TYPE, SELLER_PERFORMANCE_REPORT_TYPE, lastCompletePeriod } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { ScheduleDeps } from './schedule-jobs'

// 库存与费用类报告的定时申请（P2a-05，importers.md R-08 至 R-22）：
// 每日报告每天一份（快照类取申请时刻的状态，台账与移除类带最近几天的窗口，导入按幂等键覆盖），
// 月度费用报告每月 16 日之后申请一次（仓储费取上一个自然月）。
// 报告任务与用户手动创建的走同一条链路：FbaReportJob + FBA_REPORT_CREATE 同步任务 → 申请 → 轮询 → 流式导入。

const DAY_MS = 24 * 60 * 60 * 1000
const MARKETPLACE_ID = 'ATVPDKIKX0DER'
/** 每月几号之后申请月度费用报告（仓储费、超限费、长期仓储费出账之后）。 */
export const MONTHLY_REPORT_FROM_DAY = 16

export interface DueReport {
  reportType: string
  from: Date | null
  to: Date | null
  /** 去重窗口：这个窗口内已经有同类型报告任务就不再申请。 */
  dedupeMs: number
  /** 只对数据中心已经有销售与流量数据的店铺申请（报告需要同样的品牌分析角色；没有数据中心数据也就没有可核对的对象）。 */
  requiresKioskSalesTraffic?: boolean
  /** 一个时间窗口只申请一次（按起始日判断，不看创建时间）：品牌分析按自然周、月发布，失败或没有品牌角色时不每天重复申请。 */
  perWindow?: boolean
}

const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

/** 周报在周内数据出齐之后（周二至周六，UTC）申请上一个自然周；月报在每月 6 日之后申请上一个自然月；季度报告只能手工申请（不排程）。 */
export const BRAND_WEEKLY_DAYS = [2, 3, 4, 5, 6]
export const BRAND_MONTHLY_FROM_DAY = 6

export function dueBrandReports(now: Date): DueReport[] {
  const at = (day: string) => new Date(`${day}T00:00:00Z`)
  const windows = [...(BRAND_WEEKLY_DAYS.includes(now.getUTCDay()) ? [lastCompletePeriod('WEEK', now)] : []), ...(now.getUTCDate() >= BRAND_MONTHLY_FROM_DAY ? [lastCompletePeriod('MONTH', now)] : [])]
  return windows.flatMap(window => BA_REPORT_TYPES.map(reportType => ({ reportType, from: at(window.start), to: at(window.end), dedupeMs: 0, perWindow: true })))
}

/** 现在该申请哪些报告（纯函数，便于测试）。 */
export function dueReports(now: Date): DueReport[] {
  const today = startOfDay(now)
  const snapshot = (reportType: string): DueReport => ({ reportType, from: null, to: null, dedupeMs: 20 * 60 * 60 * 1000 })
  const windowed = (reportType: string, days: number): DueReport => ({ reportType, from: new Date(today.getTime() - days * DAY_MS), to: today, dedupeMs: 20 * 60 * 60 * 1000 })
  const due: DueReport[] = [
    snapshot('GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA'),
    snapshot('GET_AFN_INVENTORY_DATA'),
    snapshot('GET_RESERVED_INVENTORY_DATA'),
    snapshot('GET_STRANDED_INVENTORY_UI_DATA'),
    snapshot('GET_FBA_INVENTORY_PLANNING_DATA'),
    snapshot('GET_FBA_RECOMMENDED_REMOVAL_DATA'),
    snapshot('GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT'),
    windowed('GET_LEDGER_SUMMARY_VIEW_DATA', 3),
    windowed('GET_LEDGER_DETAIL_VIEW_DATA', 3),
    windowed('GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA', 30),
    windowed('GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA', 30),
    windowed('GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA', 30),
    // 订单页（P2b-01）：包裹与替换关联；窗口取最近 7 天，订单晚同步的行下一天还会再看到
    windowed('GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', 7),
    windowed('GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA', 7),
    // 退货页（P2b-02）：客户退货报告，窗口取最近 30 天（亚马逊对单次窗口有上限，30 天留足余量；晚入账的退货下一天还会再看到）
    windowed('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA', 30),
    // 赔付中心（P2b-03）：官方赔付明细，窗口取最近 30 天（赔付到账晚于申请，下一天还会再看到；导入按幂等键覆盖）
    windowed('GET_FBA_REIMBURSEMENTS_DATA', 30),
    // 费用核查（P2b-06）：预估配送费与佣金预览是快照类报告，每天一份，作为核查基准
    snapshot('GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA'),
    snapshot('GET_REFERRAL_FEE_PREVIEW_REPORT'),
    // 刊登质量（P4-10）：被搜索抑制的刊登是快照类报告，每天一份
    snapshot(LISTING_FYP_REPORT_TYPE),
    // 账户健康（P5-02）：卖家表现报告是当前表现的快照，每天一份；账户状态变化推送接收端建成之前，状态变化最长晚一天出现
    snapshot(SELLER_PERFORMANCE_REPORT_TYPE),
    // 促销与优惠券（P4-05）：促销绩效与优惠券绩效，窗口取最近 30 天（效果数据晚于活动日到达，下一天还会再看到；导入按映射编号与日覆盖）
    windowed(PROMOTION_REPORT_TYPE, 30),
    windowed(COUPON_REPORT_TYPE, 30),
    // 销售与流量（P4-01）：昨天（UTC 日）一整天，JSON 格式；导入器只在窗口恰好一天时读 ASIN 部分，并与数据中心核对差异
    { reportType: SALES_TRAFFIC_REPORT_TYPE, from: new Date(today.getTime() - DAY_MS), to: new Date(today.getTime() - 1), dedupeMs: 20 * 60 * 60 * 1000, requiresKioskSalesTraffic: true },
  ]
  due.push(...dueBrandReports(now))
  if (now.getUTCDate() >= MONTHLY_REPORT_FROM_DAY) {
    const monthly = 25 * DAY_MS
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    due.push(
      { reportType: 'GET_FBA_STORAGE_FEE_CHARGES_DATA', from: lastMonth, to: thisMonth, dedupeMs: monthly },
      { reportType: 'GET_FBA_OVERAGE_FEE_CHARGES_DATA', from: null, to: null, dedupeMs: monthly },
      { reportType: 'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA', from: null, to: null, dedupeMs: monthly },
    )
  }
  return due
}

/** 为每个已授权的亚马逊卖家连接申请到期的库存与费用类报告；返回创建的报告任务数。 */
export async function scheduleInventoryReports(deps: ScheduleDeps, now: Date = new Date()): Promise<number> {
  const { prisma, systemPrisma, queues } = deps
  if (process.env.APP_MODE !== 'production' || process.env.MOCK_CONNECTOR === 'true') return 0
  const connections = await systemPrisma.platformConnection.findMany({
    where: { state: 'AUTHORIZED', provider: 'AMAZON_SP_API', encryptedRefreshToken: { not: null }, sellerAccountId: { not: null }, tenant: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } } },
    select: { id: true, tenantId: true, sellerAccountId: true },
  })
  let created = 0
  for (const connection of connections) {
    const sellerAccountId = connection.sellerAccountId
    if (!sellerAccountId) continue
    await runWithTenant(connection.tenantId, async () => {
      for (const report of dueReports(now)) {
        const existing = await prisma.fbaReportJob.count({
          where: {
            sellerAccountId,
            marketplaceId: MARKETPLACE_ID,
            reportType: report.reportType,
            ...(report.perWindow ? { fromDate: report.from, toDate: report.to } : { createdAt: { gte: new Date(now.getTime() - report.dedupeMs) } }),
          },
        })
        if (existing > 0) continue
        if (report.requiresKioskSalesTraffic && (await prisma.salesTrafficDaily.findFirst({ where: { sellerAccountId, source: 'DATA_KIOSK' }, select: { id: true } })) === null) continue
        const job = await prisma.fbaReportJob.create({
          data: {
            tenantId: connection.tenantId,
            sellerAccountId,
            marketplaceId: MARKETPLACE_ID,
            reportType: report.reportType,
            fromDate: report.from ?? undefined,
            toDate: report.to ?? undefined,
            status: 'PENDING',
            requestId: 'schedule',
          },
        })
        const type = 'FBA_REPORT_CREATE'
        const syncJob = await prisma.syncJob.create({
          data: {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            type,
            status: 'PENDING',
            requestId: 'schedule',
            context: { reportJobId: job.id, reportType: report.reportType, marketplaceId: MARKETPLACE_ID },
            domain: syncDomainOf(type),
            priority: PRIORITY.SCHEDULED,
            sourceKey: syncSourceKey(connection.id, type, job.id),
          },
        })
        await prisma.fbaReportJob.update({ where: { id: job.id }, data: { syncJobId: syncJob.id } }) // 报表中心详情页据此显示关联的同步任务
        await queues.addSync(
          type,
          { tenantId: connection.tenantId, syncJobId: syncJob.id, requestId: 'schedule', reportJobId: job.id, reportType: report.reportType, marketplaceId: MARKETPLACE_ID },
          { jobId: syncJob.id, priority: PRIORITY.SCHEDULED },
        )
        created += 1
      }
    })
  }
  return created
}
