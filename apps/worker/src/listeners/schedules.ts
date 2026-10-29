import {
  APLUS_REFRESH_INTERVAL_MS,
  AWD_REFRESH_INTERVAL_MS,
  CATALOG_REFRESH_INTERVAL_MS,
  COMPETITOR_REFRESH_INTERVAL_MS,
  CONNECTION_HEALTH_REFRESH_INTERVAL_MS,
  FEEDBACK_REFRESH_INTERVAL_MS,
  INVENTORY_REFRESH_INTERVAL_MS,
  LISTING_REFRESH_INTERVAL_MS,
  PRICING_REFRESH_INTERVAL_MS,
  PROMOTIONS_REFRESH_INTERVAL_MS,
  SETTLEMENT_REFRESH_INTERVAL_MS,
  SUPPORT_REFRESH_INTERVAL_MS,
  TAX_REFRESH_INTERVAL_MS,
  purgeExpiredBuyerInformation,
  scheduleProductionSync,
  type ScheduleDeps,
} from './schedule-jobs'
import { scheduleInventoryReports } from './report-schedule'
import { backfillReturnComments } from '../maintenance/return-comments'
import { ECONOMICS_SCHEDULE_INTERVAL_MS, scheduleEconomicsQueries } from '../datakiosk/schedule'
import { SALES_TRAFFIC_SCHEDULE_INTERVAL_MS, scheduleSalesTrafficQueries } from '../datakiosk/sales-traffic-schedule'
import { PARTITION_MAINTENANCE_INTERVAL_MS, maintainPartitions } from './maintenance'
import { RAW_FILE_PURGE_INTERVAL_MS, purgeExpiredRawFiles } from './raw-file-retention'
import { CLOSE_PURGE_INTERVAL_MS, purgeClosedTenantArtifacts } from '../lifecycle/close-retention'
import { EXPORT_PURGE_INTERVAL_MS, purgeExpiredExports } from '../exports/expire'
import { ensureDefaultRules } from '../alerts/provision'
import { ALERT_EVALUATION_INTERVAL_MS, evaluateAllTenants } from '../platform/alert-evaluate'
import { REIMBURSEMENT_SCAN_INTERVAL_MS, scanAllTenants } from '../reimbursements/run'
import { FEE_AUDIT_INTERVAL_MS, auditAllTenants } from '../fee-audit/run'
import { SETTLEMENT_RECONCILE_INTERVAL_MS, reconcileAllTenants } from '../settlements/run'
import { ADS_RULE_SCAN_INTERVAL_MS, scanAllTenants as scanAdsRulesForAllTenants } from '../ads-rules/run'
import { PRICING_RULE_SCAN_INTERVAL_MS, scanAllTenants as scanPricingRulesForAllTenants } from '../pricing-rules/run'
import { DAYPARTING_SCAN_INTERVAL_MS, runAllTenantsDayparting } from '../ads-dayparting/run'
import { ADS_CHANGE_SCAN_INTERVAL_MS, scanAllTenants as scanAdsChangesForAllTenants } from '../ads-changes/run'
import { ADS_PARITY_SCHEDULE_INTERVAL_MS, scheduleAdsParity } from '../ads-reports/schedule'
import { ADS_REPORT_AUTO_INTERVAL_MS, scheduleAdsReports } from '../ads-reports/auto-schedule'
import { ADS_ENTITY_SCHEDULE_INTERVAL_MS, scheduleAdsEntities } from '../ads-entities/schedule'
import { PROFIT_REFRESH_INTERVAL_MS } from '@nova/api-contracts'
import { refreshAllTenants as refreshProfitForAllTenants } from '../profit/run'
import { fetchFxForAllTenants } from '../platform/fx-fetch'
import { NOTIFICATION_EVENT_PURGE_INTERVAL_MS, purgeExpiredNotificationEvents } from '../platform/notification-events'
import { DND_SUMMARY_INTERVAL_MS, sendDndSummaries } from '../platform/dnd-summary'
import { WORK_ESCALATION_INTERVAL_MS, escalateOverdueWork } from '../platform/work-escalation'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * 启动全部定时任务并返回停止函数：
 * - 买家信息到期清理：启动时与之后每小时一次；
 * - 生产环境的定时同步：启动时与之后每 6 小时一次（开发与模拟模式不跑）；库存另外每 30 分钟刷新一次，上游仓储与支持案件每 2 小时刷新一次，商品目录每天一次（启动时也补一次，每个店铺同一时刻只排一个同步任务）；
 * - 官方经济数据（P2b-11）：每天一次为每个店铺排官方单品经济（重拉最近 14 天，第一次回补 90 天）与费用预览（未来 119 天）两个数据中心查询，启动 15 分钟后补一次，并清理 7 天前的预览行；
 * - 销售与流量（P4-01）：每天一次为每个店铺排数据中心查询（按日、周、月各一个，按父体、子体、SKU 与最近几天各一个，趋势一个），启动 25 分钟后补一次；店铺没有品牌分析角色时这些任务以预期的 DK_NO_BRAND 结束；
 * - 库存与费用类报告（P2a-05）：启动时与之后每 6 小时检查一次，每日报告每天一份，月度费用报告每月 16 日之后一份；
 * - 分区维护：启动时与之后每天一次，提前 3 个月续建分区并检查默认分区；
 * - 原始报告文件到期清理：启动时与之后每天一次（需要对象存储）；
 * - 注销产物到期清理（导出包 30 天、审计 730 天）：启动时与之后每天一次（需要对象存储）；
 * - 导出中心文件到期清理（保留 7 天）与卡死任务收尾：启动时与之后每小时一次（需要对象存储）；
 * - 个人免打扰汇总（P5-11）：启动时与之后每 5 分钟一次，给免打扰已结束且有被压下通知的成员发一条汇总；
 * - 赔付中心扫描（每 3 小时）：官方赔付明细匹配案件、6 类赔付机会检测与过期；
 * - 费用核查（每 6 小时，P2b-06）：配送费、佣金、仓储费、入仓配置费四类核查，结果按核查日覆盖写入，并清理过期数据；
 * - 结算交易（P2b-07）：结算报告每天检索一次（启动 10 分钟后补一次），三方核对每 6 小时一次（启动时也跑一次）；
 * - 销售税（P2b-12）：税务文档库里已生成的销售税报告每天检索一次（启动 12 分钟后补一次）；
 * - 促销与优惠券（P4-05）：促销接口每天只读同步一次（启动 14 分钟后补一次）；
 * - A+ 内容（P4-14）：每天只读同步一次内容、关联 ASIN 与发布记录（启动 26 分钟后补一次）；店铺没有品牌备案或 A+ 内容角色时任务以预期的 APL_ROLE_MISSING 结束；
 * - 连接健康检查（P5-04）：每个已授权连接每天一次（启动 3 分钟后补一次），只读调用一个轻量接口，结果写入连接的健康记录；失败不改连接状态；
 * - 竞品监控（P4-12）：每 6 小时对关注的竞品 ASIN 取商品目录与竞争摘要（启动 22 分钟后补一次；没有关注任何竞品时任务直接以“不适用”结束）；
 * - 广告实体与报表（P5-12A）：实体（活动、广告组、广告、投放对象、广告组合）每 2 小时只读同步一次（启动 21 分钟后补一次），报表每 6 小时检查、每个模板每天一份（启动 23 分钟后补一次）；没发现广告账户编号的档案与没有授权连接的企业不排；
 * - 广告变更记录（P3-14）：每 30 分钟对已同步的广告实体拍快照并与上一份对比，识别亚马逊侧或其他工具做的外部变更（本系统自己写入的不记）；
 * - 利润日表（P2b-09）：每 6 小时对最近 45 天三种收入确认口径重算一次（启动时也跑一次）；订单、财务、广告同步后另有按范围的即时刷新；
 * - 广告自动规则（P3-13）：每 30 分钟检查一次，到期的已启用规则评估一遍，命中的对象生成待办并留下执行记录（自动执行写亚马逊随 P3-17，之前只生成待办）；
 * - 汇率获取（每 6 小时）、待办超时升级（每 10 分钟）、预警评估（每 15 分钟，需要已注册评估器）、
 *   亚马逊通知事件到期清理（保留 90 天，每天，需要对象存储）。
 */
export function startSchedules(deps: ScheduleDeps) {
  const { logger, systemPrisma } = deps
  const purge = () => {
    void purgeExpiredBuyerInformation(deps).catch(error => logger.error({ error: message(error) }, 'buyer information purge failed'))
    // 退货买家备注存量加密（P6-14）：把升级前的明文备注加密并清空明文列，每次最多 20 批，剩余的下一小时继续
    if (deps.secrets)
      void backfillReturnComments({ systemPrisma, secrets: deps.secrets, logger, maxBatches: 20 }).catch(error => logger.error({ error: message(error) }, 'return comment backfill failed'))
  }
  const sync = () => {
    void scheduleProductionSync(deps).catch(error => logger.error({ error: message(error) }, 'scheduled sync failed'))
  }
  const inventoryRefresh = () => {
    void scheduleProductionSync(deps, ['FBA_INVENTORY']).catch(error => logger.error({ error: message(error) }, 'scheduled inventory refresh failed'))
  }
  const awdRefresh = () => {
    void scheduleProductionSync(deps, ['AWD_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled awd refresh failed'))
  }
  const supportRefresh = () => {
    void scheduleProductionSync(deps, ['SUPPORT_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled support refresh failed'))
  }
  const settlementRefresh = () => {
    void scheduleProductionSync(deps, ['SETTLEMENT_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled settlement refresh failed'))
  }
  const taxRefresh = () => {
    void scheduleProductionSync(deps, ['TAX_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled sales tax refresh failed'))
  }
  const catalogRefresh = () => {
    void scheduleProductionSync(deps, ['CATALOG_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled catalog refresh failed'))
  }
  const listingRefresh = () => {
    void scheduleProductionSync(deps, ['LISTING_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled listing quality refresh failed'))
  }
  const pricingRefresh = () => {
    void scheduleProductionSync(deps, ['PRICING_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled pricing refresh failed'))
  }
  const competitorRefresh = () => {
    void scheduleProductionSync(deps, ['COMPETITOR_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled competitor refresh failed'))
  }
  const feedbackRefresh = () => {
    void scheduleProductionSync(deps, ['FEEDBACK_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled feedback refresh failed'))
  }
  const aplusRefresh = () => {
    void scheduleProductionSync(deps, ['APLUS_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled aplus refresh failed'))
  }
  const connectionHealth = () => {
    void scheduleProductionSync(deps, ['CONNECTION_HEALTH_CHECK']).catch(error => logger.error({ error: message(error) }, 'scheduled connection health check failed'))
  }
  const promotionsRefresh = () => {
    void scheduleProductionSync(deps, ['PROMOTIONS_SYNC']).catch(error => logger.error({ error: message(error) }, 'scheduled promotions refresh failed'))
  }
  const economics = () => {
    void scheduleEconomicsQueries(deps).catch(error => logger.error({ error: message(error) }, 'scheduled economics queries failed'))
  }
  const salesTraffic = () => {
    void scheduleSalesTrafficQueries(deps).catch(error => logger.error({ error: message(error) }, 'scheduled sales traffic queries failed'))
  }
  const inventoryReports = () => {
    void scheduleInventoryReports(deps).catch(error => logger.error({ error: message(error) }, 'scheduled inventory reports failed'))
  }
  const partitions = () => {
    void maintainPartitions(systemPrisma, logger).catch(error => logger.error({ error: message(error) }, 'partition maintenance failed'))
  }

  const rawFiles = () => {
    if (!deps.storage) return
    void purgeExpiredRawFiles({ systemPrisma, storage: deps.storage, logger }).catch(error => logger.error({ error: message(error) }, 'raw file purge failed'))
  }

  const closed = () => {
    if (!deps.storage) return
    void purgeClosedTenantArtifacts({ db: systemPrisma, storage: deps.storage, logger }).catch(error => logger.error({ error: message(error) }, 'closed tenant purge failed'))
  }

  const exportFiles = () => {
    if (!deps.storage) return
    void purgeExpiredExports({ systemPrisma, storage: deps.storage, logger }).catch(error => logger.error({ error: message(error) }, 'export purge failed'))
  }

  // 汇率每 6 小时获取一次（牌价通常一天更新一次，多次获取保证主源短暂故障后当天能补上；同一来源地址同一轮只请求一次）
  const fx = () => {
    if (process.env.MOCK_CONNECTOR === 'true' && process.env.APP_MODE !== 'production') return // 模拟模式不访问外部汇率服务
    void fetchFxForAllTenants({ systemDb: systemPrisma, db: deps.prisma, logger }).catch(error => logger.error({ error: message(error) }, 'fx fetch failed'))
  }
  const workOverdue = () => {
    void escalateOverdueWork(systemPrisma).catch(error => logger.error({ error: message(error) }, 'work escalation failed'))
  }
  // 个人免打扰（P5-11）：时段结束后给有被压下通知的成员发一条汇总，每 5 分钟扫一次
  const dndSummary = () => {
    void sendDndSummaries(systemPrisma).catch(error => logger.error({ error: message(error) }, 'dnd summary failed'))
  }
  const alerts = () => {
    if (!deps.alertEvaluators) return
    void evaluateAllTenants({ systemDb: systemPrisma, db: deps.prisma, registry: deps.alertEvaluators, provision: ensureDefaultRules, logger }).catch(error =>
      logger.error({ error: message(error) }, 'alert evaluation failed'),
    )
  }
  const reimbursements = () => {
    void scanAllTenants({ systemDb: systemPrisma, db: deps.prisma, logger }).catch(error => logger.error({ error: message(error) }, 'reimbursement scan failed'))
  }
  const feeAudit = () => {
    void auditAllTenants({ systemDb: systemPrisma, db: deps.prisma, logger }).catch(error => logger.error({ error: message(error) }, 'fee audit failed'))
  }
  const settlements = () => {
    void reconcileAllTenants({ systemDb: systemPrisma, db: deps.prisma, logger }).catch(error => logger.error({ error: message(error) }, 'settlement reconcile failed'))
  }
  const pricingRules = () => {
    void scanPricingRulesForAllTenants({ systemDb: systemPrisma, db: deps.prisma, queues: deps.queues, logger }).catch(error => logger.error({ error: message(error) }, 'pricing rule scan failed'))
  }
  const adsRules = () => {
    void scanAdsRulesForAllTenants({ systemDb: systemPrisma, db: deps.prisma, queues: deps.queues, logger }).catch(error => logger.error({ error: message(error) }, 'ads rule scan failed'))
  }
  const dayparting = () => {
    void runAllTenantsDayparting({ systemDb: systemPrisma, db: deps.prisma, queues: deps.queues, logger }).catch(error => logger.error({ error: message(error) }, 'ads dayparting run failed'))
  }
  const adsChanges = () => {
    void scanAdsChangesForAllTenants({ systemDb: systemPrisma, db: deps.prisma, logger }).catch(error => logger.error({ error: message(error) }, 'ads change scan failed'))
  }
  const adsParity = () => {
    void scheduleAdsParity({ systemPrisma, prisma: deps.prisma, queues: deps.queues }).catch(error => logger.error({ error: message(error) }, 'ads parity scheduling failed'))
  }
  const adsEntities = () => {
    void scheduleAdsEntities({ systemPrisma, prisma: deps.prisma, queues: deps.queues }).catch(error => logger.error({ error: message(error) }, 'ads entity scheduling failed'))
  }
  const adsReports = () => {
    void scheduleAdsReports({ systemPrisma, prisma: deps.prisma, queues: deps.queues }).catch(error => logger.error({ error: message(error) }, 'ads report scheduling failed'))
  }
  const profit = () => {
    void refreshProfitForAllTenants({ systemDb: systemPrisma, db: deps.prisma, logger }).catch(error => logger.error({ error: message(error) }, 'profit refresh failed'))
  }
  const notificationEvents = () => {
    if (!deps.storage) return
    void purgeExpiredNotificationEvents({ systemDb: systemPrisma, storage: deps.storage, logger }).catch(error => logger.error({ error: message(error) }, 'notification event purge failed'))
  }

  const timers = [
    setInterval(fx, 6 * 60 * 60 * 1000),
    setInterval(workOverdue, WORK_ESCALATION_INTERVAL_MS),
    setInterval(dndSummary, DND_SUMMARY_INTERVAL_MS),
    setInterval(alerts, ALERT_EVALUATION_INTERVAL_MS),
    setInterval(reimbursements, REIMBURSEMENT_SCAN_INTERVAL_MS),
    setInterval(feeAudit, FEE_AUDIT_INTERVAL_MS),
    setInterval(settlements, SETTLEMENT_RECONCILE_INTERVAL_MS),
    setInterval(adsRules, ADS_RULE_SCAN_INTERVAL_MS),
    setInterval(pricingRules, PRICING_RULE_SCAN_INTERVAL_MS),
    setInterval(dayparting, DAYPARTING_SCAN_INTERVAL_MS),
    setInterval(adsChanges, ADS_CHANGE_SCAN_INTERVAL_MS),
    setInterval(profit, PROFIT_REFRESH_INTERVAL_MS),
    setInterval(notificationEvents, NOTIFICATION_EVENT_PURGE_INTERVAL_MS),
    setInterval(exportFiles, EXPORT_PURGE_INTERVAL_MS),
    setInterval(purge, 60 * 60 * 1000),
    setInterval(partitions, PARTITION_MAINTENANCE_INTERVAL_MS),
    setInterval(rawFiles, RAW_FILE_PURGE_INTERVAL_MS),
    setInterval(closed, CLOSE_PURGE_INTERVAL_MS),
  ]
  if (process.env.APP_MODE === 'production') {
    timers.push(
      setInterval(sync, 6 * 60 * 60 * 1000),
      setInterval(inventoryRefresh, INVENTORY_REFRESH_INTERVAL_MS),
      setInterval(awdRefresh, AWD_REFRESH_INTERVAL_MS),
      setInterval(catalogRefresh, CATALOG_REFRESH_INTERVAL_MS),
      setInterval(supportRefresh, SUPPORT_REFRESH_INTERVAL_MS),
      setInterval(settlementRefresh, SETTLEMENT_REFRESH_INTERVAL_MS),
      setInterval(taxRefresh, TAX_REFRESH_INTERVAL_MS),
      setInterval(promotionsRefresh, PROMOTIONS_REFRESH_INTERVAL_MS),
      setInterval(listingRefresh, LISTING_REFRESH_INTERVAL_MS),
      setInterval(pricingRefresh, PRICING_REFRESH_INTERVAL_MS),
      setInterval(competitorRefresh, COMPETITOR_REFRESH_INTERVAL_MS),
      setInterval(feedbackRefresh, FEEDBACK_REFRESH_INTERVAL_MS),
      setInterval(aplusRefresh, APLUS_REFRESH_INTERVAL_MS),
      setInterval(connectionHealth, CONNECTION_HEALTH_REFRESH_INTERVAL_MS),
      setInterval(inventoryReports, 6 * 60 * 60 * 1000),
      setInterval(economics, ECONOMICS_SCHEDULE_INTERVAL_MS),
      setInterval(salesTraffic, SALES_TRAFFIC_SCHEDULE_INTERVAL_MS),
      setInterval(adsParity, ADS_PARITY_SCHEDULE_INTERVAL_MS),
      setInterval(adsEntities, ADS_ENTITY_SCHEDULE_INTERVAL_MS),
      setInterval(adsReports, ADS_REPORT_AUTO_INTERVAL_MS),
    )
    // 启动后 5 分钟补一次目录同步：启动时的全量同步先占着任务名额（同一店铺有进行中的任务就不再排），错开避免整天被跳过
    timers.push(
      setTimeout(catalogRefresh, 5 * 60 * 1000),
      setTimeout(settlementRefresh, 10 * 60 * 1000),
      setTimeout(economics, 15 * 60 * 1000),
      setTimeout(salesTraffic, 25 * 60 * 1000),
      setTimeout(taxRefresh, 12 * 60 * 1000),
      setTimeout(promotionsRefresh, 14 * 60 * 1000),
      setTimeout(listingRefresh, 16 * 60 * 1000),
      setTimeout(pricingRefresh, 18 * 60 * 1000),
      setTimeout(competitorRefresh, 22 * 60 * 1000),
      setTimeout(feedbackRefresh, 24 * 60 * 1000),
      setTimeout(aplusRefresh, 26 * 60 * 1000),
      setTimeout(connectionHealth, 3 * 60 * 1000),
      setTimeout(adsParity, 20 * 60 * 1000),
      setTimeout(adsEntities, 21 * 60 * 1000), // 启动时的全量同步先发现广告账户编号，错开后再排实体与报表
      setTimeout(adsReports, 23 * 60 * 1000),
    )
    sync()
    inventoryReports()
  }
  purge()
  partitions()
  rawFiles()
  closed()
  exportFiles()
  fx()
  workOverdue()
  dndSummary()
  alerts()
  reimbursements()
  feeAudit()
  settlements()
  adsRules()
  pricingRules()
  dayparting()
  adsChanges()
  profit()
  notificationEvents()
  return () => {
    for (const timer of timers) clearInterval(timer)
  }
}
