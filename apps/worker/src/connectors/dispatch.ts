import type { LockLease } from '@nova/workflow'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import {
  APLUS_SYNC_JOB,
  CATALOG_SYNC_JOB,
  COMPETITOR_SYNC_JOB,
  FEEDBACK_SYNC_JOB,
  LISTING_SYNC_JOB,
  PRICING_FEE_ESTIMATE_JOB,
  PRICING_SYNC_JOB,
  PROMOTIONS_SYNC_JOB,
  SALES_TAX_REPORT_TYPE,
  SALES_TAX_SYNC_JOB,
  SETTLEMENT_SYNC_JOB,
  SUPPORT_SYNC_JOB,
} from '@nova/api-contracts'
import { ADS_ENTITY_JOB_TYPES, discoverAccountsSafely, processAdsEntities } from '../ads-entities/dispatch'
import { ADS_REPORT_JOB_TYPES, processAdsReports } from '../ads-reports/dispatch'
import { syncAdsProfiles } from '../importers/ads/profiles'
import { syncCatalogItems } from '../importers/catalog/items-sync'
import { syncSupportCases } from '../importers/support/sync'
import { syncPromotions } from '../importers/promotions/sync'
import { syncListings } from '../importers/listings/items-sync'
import { syncPricing } from '../importers/pricing/sync'
import { syncCompetitors } from '../importers/competitors/sync'
import { syncFeedback } from '../importers/feedback/sync'
import { syncAdsReport } from '../importers/ads/reports'
import { syncFinanceV2024 } from '../importers/finance/v2024-sync'
import { syncInventory } from '../importers/inventory/api'
import { syncSubscribeSave } from '../importers/replenishment/subscribe-save'
import { localDay } from '../importers/shared'
import { tenantTimeZone } from '../derivers/summary-sql'
import { syncOrdersV2026 } from '../importers/orders/v2026-sync'
import { runDataKioskQuery, type KioskCheckpoint } from '../datakiosk/executor'
import { runFinanceParity, runOrdersParity } from '../parity/run'
import type { WorkerSecrets } from '../crypto/secrets'
import type { createReliability } from '../runtime/reliability'
import { runWriteWorkflow, type createWriteWorkflows } from '../runtime/workflows'
import type { JsonObject, SyncPayload } from '../types'
import { AmazonAdsApiClient } from './amazon-ads-api'
import { AmazonSpApiClient } from './amazon-sp-api'
import { CatalogApi } from './catalog-api'
import { FeedbackApi } from './feedback-api'
import { DataKiosk } from './datakiosk'
import { participatingMarketplaces } from './marketplaces'
import { ReplenishmentApi } from './replenishment-api'
import { SpApiV2, US_MARKETPLACE } from './sp-api-v2'
import { ReportListApi } from './report-retrieval'
import { SettlementApi } from './settlement-api'
import { syncSettlements } from './settlement-dispatch'
import { syncSalesTax } from './tax-dispatch'
import { SupportApi } from './support-api'
import { PromotionsApi } from './promotions-api'
import { ListingsApi } from './listings-api'
import { PricingApi } from './pricing-api'
import { ProductFeesApi } from './product-fees-api'
import { runProductFeeEstimate } from './product-fees-run'
import { LISTING_JOB_TYPES, processListingWrite } from './listing-dispatch'
import { importReportDocument, reportImporterFor } from './report-import'
import { amazonStageOf, failedData, importWarnings, statsData, warningsJson, withEvent } from '../reports/job-state'
import type { RawFileOpener } from '../streaming/raw-files'
import type { ObjectStorage } from '@nova/storage'
import { ADS_WRITE_JOB_TYPES, processAdsWrite } from './ads-write-dispatch'
import { AWD_JOB_TYPES, processAwd } from './awd-dispatch'
import { INBOUND_JOB_TYPES, processInbound } from './inbound-dispatch'
import { SOLICITATION_JOB_TYPES, processSolicitation } from './solicitation-dispatch'
import { APLUS_JOB_TYPES, processAplusWrite } from './aplus-dispatch'
import { AplusApi } from './aplus-api'
import { syncAplus } from '../importers/aplus/sync'

// 连接器分发：按任务类型与提供方选择导入器。依赖由监听器注入，本文件不持有任何全局状态。
export interface ProductionDeps {
  prisma: PrismaClient
  logger: Logger
  reliability: ReturnType<typeof createReliability>
  writeWorkflows: ReturnType<typeof createWriteWorkflows>
  /** 应用层加密：解密亚马逊令牌、加密买家信息（P1-24）。 */
  secrets: WorkerSecrets
  /** 原始报告文件的去向（对象存储）：不提供时只解析不留存；生产环境必须提供。 */
  openRawFile?: RawFileOpener
  /** 对象存储：保存上游仓储货件标签；不提供时标签任务永久失败（生产环境必须提供）。 */
  storage?: ObjectStorage
}

// run：本次执行的运行信息。写亚马逊的操作走流程状态机（先记意图、再调用、再记结果），以队列任务编号为去重键，
// 同一个队列任务的多次重试沿用同一个流程；用户在界面上点“重试”会产生新的队列任务，从而开始新的流程。
export type ProductionRun = { jobId: string; priority: number; lease: LockLease | null; isLastAttempt: boolean }

/** 核对只是对照，失败（含旧接口已下线）不能让同步任务失败：记警告，同步结果里带上核对状态。 */
async function safeParity(deps: ProductionDeps, domain: string, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (error) {
    deps.logger.warn({ domain, error: error instanceof Error ? error.message : String(error) }, 'parity check failed; sync result is unaffected')
    return { ran: false, error: 'PARITY_CHECK_FAILED' }
  }
}

/** 上一次成功同步的完成时间，作为增量同步的起点。 */
export async function priorSyncCursor(deps: ProductionDeps, connectionId: string, type: string, currentJobId: string) {
  const { prisma } = deps
  const prior = await prisma.syncJob.findFirst({ where: { connectionId, type, status: 'SUCCEEDED', id: { not: currentJobId } }, orderBy: { finishedAt: 'desc' } })
  return prior?.finishedAt ?? null
}
export async function processProduction(
  deps: ProductionDeps,
  payload: SyncPayload,
  row: {
    id: string
    type: string
    tenantId: string
    context?: unknown
    checkpointJson?: unknown
    connection: { id: string; encryptedRefreshToken: string | null; sellerAccountId: string | null; adsProfileId: string | null; provider: string }
  },
  run: ProductionRun,
) {
  const { prisma, logger, reliability, writeWorkflows } = deps
  const marketplaceId = payload.marketplaceId ?? 'ATVPDKIKX0DER'
  const guard = reliability.guardFor(row.tenantId, row.connection.id)
  if (row.connection.provider === 'AMAZON_ADS_API') {
    const client = new AmazonAdsApiClient(row.connection, deps.secrets, guard)
    if (row.type === 'FBA_ADS') {
      const profiles = await syncAdsProfiles(deps, client, row.tenantId, row.connection.id)
      return { ...profiles, accounts: await discoverAccountsSafely(deps, client, row.tenantId) } // 档案同步后顺带发现统一接口的账户编号（P5-12A）
    }
    if (ADS_ENTITY_JOB_TYPES.includes(row.type)) return processAdsEntities(deps, client, row, payload) // 广告实体落库同步（P5-12A）
    if (ADS_REPORT_JOB_TYPES.includes(row.type)) return processAdsReports(deps, client, row, payload) // 新报告接口任务与迁移期核对（P3-15）
    if (row.type === 'ADS_REPORT_CREATE' || row.type === 'ADS_REPORT_POLL') {
      if (!payload.reportJobId) throw new Error('ADS_REPORT_JOB_CONTEXT_MISSING')
      const reportJob = await prisma.adsReportJob.findUnique({ where: { id: payload.reportJobId }, include: { adsProfile: true } })
      if (!reportJob) throw new Error('ADS_REPORT_JOB_NOT_FOUND')
      const profileId = reportJob.adsProfile.profileId
      if (!payload.poll) {
        const fromDate = (reportJob.fromDate ?? new Date(Date.now() - 30 * 86400000)).toISOString().slice(0, 10)
        const toDate = (reportJob.toDate ?? new Date()).toISOString().slice(0, 10)
        const response = await client.requestReport(profileId, { reportType: reportJob.reportType, fromDate, toDate, adProduct: reportJob.adProduct })
        const reportId = typeof response.reportId === 'string' ? response.reportId : typeof response.id === 'string' ? response.id : undefined
        if (!reportId) throw new Error('ADS_REPORT_ID_NOT_RETURNED')
        await prisma.adsReportJob.update({ where: { id: reportJob.id }, data: { status: 'GENERATING', externalReportId: reportId } })
        return { pending: true, reportId }
      }
      if (!reportJob.externalReportId) throw new Error('ADS_REPORT_ID_MISSING')
      const response = await client.getReport(profileId, reportJob.externalReportId)
      const status = String(response.status ?? response.reportStatus ?? 'IN_PROGRESS').toUpperCase()
      if (['COMPLETED', 'SUCCESS', 'DONE'].includes(status)) {
        const downloadUrl = typeof response.url === 'string' ? response.url : typeof response.downloadUrl === 'string' ? response.downloadUrl : undefined
        const imported = downloadUrl
          ? (
              await syncAdsReport(
                deps,
                client,
                reportJob,
                row.tenantId,
                downloadUrl,
                deps.openRawFile
                  ? {
                      open: deps.openRawFile,
                      fileName: `${reportJob.id}-${reportJob.reportType}.raw`,
                      record: {
                        storeKey: reportJob.adsProfile.sellerAccountId ?? `ads:${reportJob.adsProfileId}`,
                        sellerAccountId: reportJob.adsProfile.sellerAccountId,
                        sourceKey: `ads-report:${reportJob.id}`,
                        reportType: reportJob.reportType,
                        reportId: reportJob.externalReportId,
                        periodStart: reportJob.fromDate,
                        periodEnd: reportJob.toDate,
                      },
                    }
                  : undefined,
              )
            ).imported
          : 0
        await prisma.adsReportJob.update({ where: { id: reportJob.id }, data: { status: 'READY', downloadUrl, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } })
        return { ready: true, reportId: reportJob.externalReportId, imported }
      }
      if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(status)) {
        await prisma.adsReportJob.update({ where: { id: reportJob.id }, data: { status: 'FAILED', failureCode: status } })
        throw new Error(`ADS_REPORT_${status}`)
      }
      return { pending: true, reportId: reportJob.externalReportId }
    }
    if (ADS_WRITE_JOB_TYPES.includes(row.type)) return processAdsWrite(deps, row, payload, run) // 广告写入（P3-17）
    throw new Error('ADS_CONNECTOR_OPERATION_NOT_IMPLEMENTED')
  }

  const sellerAccountId = row.connection.sellerAccountId
  if (!sellerAccountId) throw new Error('SELLER_ACCOUNT_NOT_BOUND')
  const client = new AmazonSpApiClient(row.connection, deps.secrets, guard)
  // 上游仓储只在美国站，不需要先查参与的站点（写入任务也不该为此多调用一次亚马逊）
  if (AWD_JOB_TYPES.includes(row.type)) return processAwd(deps, client, row, sellerAccountId, payload, run, localDay(await tenantTimeZone(prisma, row.tenantId)))
  // 入仓计划（v2024-03-20）：计划自带站点，同步与操作都不需要先查参与的站点
  if (INBOUND_JOB_TYPES.includes(row.type)) return processInbound(deps, client, row, sellerAccountId, payload, run)
  // 商品目录（P2a-14，I-09）：只读、固定美国站，同样不需要先查参与的站点
  if (row.type === CATALOG_SYNC_JOB) {
    return syncCatalogItems(deps, new CatalogApi(client), { tenantId: row.tenantId, sellerAccountId }, { today: localDay(await tenantTimeZone(prisma, row.tenantId)) })
  }
  // 刊登质量（P4-10，I-10）：每日全量读取刊登问题、状态与内容变化；刊登写入与查询任务（修改、校验预览、批量任务、刊登限制）。都固定美国站，不需要先查参与的站点
  if (row.type === LISTING_SYNC_JOB) {
    const seller = await prisma.sellerAccount.findFirst({ where: { id: sellerAccountId, tenantId: row.tenantId }, select: { sellerId: true } })
    return syncListings(deps, seller?.sellerId ? new ListingsApi(client, seller.sellerId) : null, { tenantId: row.tenantId, sellerAccountId })
  }
  if (LISTING_JOB_TYPES.includes(row.type)) return processListingWrite(deps, client, row, sellerAccountId, payload, run)
  // 定价（P4-11，I-13）：我方报价、推荐报价预期价格、竞争摘要；每 2 小时一次，只读、固定美国站
  if (row.type === PRICING_SYNC_JOB) {
    const seller = await prisma.sellerAccount.findFirst({ where: { id: sellerAccountId, tenantId: row.tenantId }, select: { sellerId: true } })
    const listings = seller?.sellerId ? new ListingsApi(client, seller.sellerId) : null
    return syncPricing(deps, listings, new PricingApi(client), { tenantId: row.tenantId, sellerAccountId }, { ownSellerId: seller?.sellerId ?? '' })
  }
  // 费用预估（P6-29）：只对试算记录里的参考 ASIN 打一次，不进定时调度。403 记未授权后任务成功返回，避免反复重试。
  if (row.type === PRICING_FEE_ESTIMATE_JOB) {
    const context = (row.context ?? {}) as { recordId?: unknown; referenceAsin?: unknown; price?: unknown }
    if (typeof context.recordId !== 'string' || typeof context.referenceAsin !== 'string' || typeof context.price !== 'number') throw new Error('FEES_ESTIMATE_CONTEXT_MISSING')
    return runProductFeeEstimate(prisma, new ProductFeesApi(client), {
      tenantId: row.tenantId,
      sellerAccountId,
      recordId: context.recordId,
      referenceAsin: context.referenceAsin,
      price: context.price,
    })
  }
  // 竞品监控（P4-12）：对店铺关注的竞品 ASIN 取商品目录与竞争摘要，每 6 小时一次，只读、固定美国站；没有关注任何竞品时以“不适用”结束
  if (row.type === COMPETITOR_SYNC_JOB) return syncCompetitors(deps, new CatalogApi(client), new PricingApi(client), { tenantId: row.tenantId, sellerAccountId })
  // 客户反馈（P4-13，I-15）：每日轮转一批商品，读评论主题与类目趋势，只读、固定美国站；没有商品目录时以“不适用”结束，没有品牌分析权限以 FBK_NO_BRAND_ACCESS 结束
  if (row.type === FEEDBACK_SYNC_JOB) {
    return syncFeedback(deps, new FeedbackApi(client), { tenantId: row.tenantId, sellerAccountId }, { today: localDay(await tenantTimeZone(prisma, row.tenantId)) })
  }
  // 请求评价（P4-13，I-16）：按批向亚马逊逐单请求，走写操作流程，受写入开关控制；固定美国站
  if (SOLICITATION_JOB_TYPES.includes(row.type)) return processSolicitation(deps, row, sellerAccountId, payload, run)
  // A+ 内容（P4-14，I-18）：每日只读同步内容、关联 ASIN 与发布记录，没有品牌备案或 A+ 内容角色以 APL_ROLE_MISSING 结束（新鲜度记“未授权”）；写入任务（创建、保存、关联、提交审核、上传图片）走写操作流程，受写入开关控制。都固定美国站
  if (row.type === APLUS_SYNC_JOB) return syncAplus(deps, new AplusApi(client), { tenantId: row.tenantId, sellerAccountId })
  if (APLUS_JOB_TYPES.includes(row.type)) return processAplusWrite(deps, row, sellerAccountId, payload, run)
  // 卖家支持案件（P2b-04，I-20）：只读、固定美国站
  if (row.type === SUPPORT_SYNC_JOB) return syncSupportCases(deps, new SupportApi(client), { tenantId: row.tenantId, sellerAccountId })
  // 促销与优惠券（P4-05，I-17）：只读、固定美国站（接口没有任何写入操作）
  if (row.type === PROMOTIONS_SYNC_JOB) return syncPromotions(deps, new PromotionsApi(client), { tenantId: row.tenantId, sellerAccountId })
  // 结算交易（P2b-07，R-28）：检索亚马逊已生成的结算报告并导入，导入后核对；不需要先查参与的站点
  if (row.type === SETTLEMENT_SYNC_JOB) return syncSettlements(deps, new SettlementApi(client), client, { tenantId: row.tenantId, sellerAccountId })
  // 销售税（P2b-12，R-33）：检索税务文档库已生成的报告并导入；受限角色未批与报告未生成都以专用失败码结束
  if (row.type === SALES_TAX_SYNC_JOB) return syncSalesTax(deps, new ReportListApi(client, SALES_TAX_REPORT_TYPE), client, { tenantId: row.tenantId, sellerAccountId })
  const markets = await participatingMarketplaces(deps, client, sellerAccountId, marketplaceId)
  const since = await priorSyncCursor(deps, row.connection.id, row.type, payload.syncJobId)
  // 没有日期列的快照按企业数据口径时区的“今天”落日
  const snapshotDay = async () => localDay(await tenantTimeZone(prisma, row.tenantId))
  if (row.type === 'FBA_INVENTORY') {
    let imported = 0
    const snapshotDate = await snapshotDay()
    for (const market of markets) imported += await syncInventory(deps, client, row.tenantId, sellerAccountId, market, snapshotDate)
    return { imported, markets }
  }
  const scope = { tenantId: row.tenantId, sellerAccountId }
  if (row.type === 'FBA_REPLENISHMENT') return syncSubscribeSave(deps, new ReplenishmentApi(client), scope, { today: await snapshotDay() })
  // 订单与财务已升级到新版接口（P1-26，仅美国站）；旧接口只在核对阶段只读调用，核对通过后关闭。历史回补任务（带时间窗）不做核对。
  if (row.type === 'FBA_ORDERS') {
    const api = new SpApiV2(client)
    const result = await syncOrdersV2026(deps, api, scope, { since, window: payload.window })
    if (result.piiRestricted) logger.warn(scope, 'orders imported without buyer information: seller account lacks the buyer information role')
    const parity = payload.window
      ? null
      : await safeParity(deps, 'ORDERS', () => runOrdersParity(deps, scope, { next: api, legacy: client, marketplaceId: US_MARKETPLACE }, { syncJobId: payload.syncJobId }))
    return { ...result, parity }
  }
  if (row.type === 'FBA_FINANCE') {
    const api = new SpApiV2(client)
    const result = await syncFinanceV2024(deps, api, scope, { since, window: payload.window })
    const parity = payload.window ? null : await safeParity(deps, 'FINANCE', () => runFinanceParity(deps, scope, { next: api, legacy: client }, { syncJobId: payload.syncJobId }))
    return { ...result, parity }
  }
  if (row.type === 'DATA_KIOSK_QUERY') {
    const context = (row.context ?? {}) as { dataset?: unknown; params?: Record<string, string> }
    if (typeof context.dataset !== 'string' || !context.dataset) throw new NonRetryableError('DATA_KIOSK_DATASET_MISSING', '数据中心任务缺少数据集标识')
    const store = {
      read: () => (row.checkpointJson ?? null) as KioskCheckpoint | null,
      write: async (value: KioskCheckpoint | null) => {
        await prisma.syncJob.update({ where: { id: row.id }, data: { checkpointJson: value ? (value as unknown as Prisma.InputJsonValue) : Prisma.DbNull } })
      },
    }
    return runDataKioskQuery(deps, new DataKiosk(client), scope, { dataset: context.dataset, params: context.params ?? {}, syncJobId: payload.syncJobId }, store)
  }
  if (row.type === 'FBA_INBOUND_CREATE') {
    if (!payload.fbaPlanId) throw new Error('FBA_PLAN_CONTEXT_MISSING')
    return runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.inboundPlanCreate, {
      tenantId: row.tenantId,
      dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.INBOUND_PLAN_CREATE, payload.fbaPlanId, run.jobId),
      syncJobId: payload.syncJobId,
      priority: run.priority,
      lease: run.lease,
      isLastAttempt: run.isLastAttempt,
      owner: `${reliability.ownerId}:${run.jobId}`,
      intent: { tenantId: row.tenantId, connectionId: row.connection.id, fbaPlanId: payload.fbaPlanId },
    })
  }
  if (row.type === 'FBA_REPORT_CREATE' || row.type === 'FBA_REPORT_POLL') {
    if (!payload.reportJobId) throw new Error('REPORT_JOB_CONTEXT_MISSING')
    const reportJob = await prisma.fbaReportJob.findUnique({ where: { id: payload.reportJobId } })
    if (!reportJob) throw new Error('REPORT_JOB_NOT_FOUND')
    // 报表中心里取消了这个任务：不再申请、轮询或下载（亚马逊侧已申请的报告会照常生成，我们不取）
    if (reportJob.status === 'CANCELLED') return { cancelled: true }
    if (!payload.poll) {
      if (!payload.reportType) throw new Error('REPORT_TYPE_CONTEXT_MISSING')
      const created = (await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.reportCreate, {
        tenantId: row.tenantId,
        dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.REPORT_CREATE, payload.reportJobId, run.jobId),
        syncJobId: payload.syncJobId,
        priority: run.priority,
        lease: run.lease,
        isLastAttempt: run.isLastAttempt,
        owner: `${reliability.ownerId}:${run.jobId}`,
        intent: { tenantId: row.tenantId, connectionId: row.connection.id, reportJobId: payload.reportJobId, reportType: payload.reportType, marketplaceId: reportJob.marketplaceId || marketplaceId },
      })) as { reportId: string }
      return { pending: true, reportId: created.reportId }
    }
    if (!reportJob.externalReportId) throw new Error('REPORT_ID_MISSING')
    const report = await client.getReport(reportJob.externalReportId)
    const reportStatusBody = (report.payload ?? report) as JsonObject
    const status = String(reportStatusBody.processingStatus ?? reportStatusBody.status ?? 'IN_PROGRESS').toUpperCase()
    // 亚马逊侧状态变化记进时间线（同一状态不重复记）
    const stage = amazonStageOf(status)
    let timeline: unknown = reportJob.timelineJson
    if (stage && stage !== 'AMAZON_DONE') {
      const next = withEvent(timeline, stage)
      if (JSON.stringify(next) !== JSON.stringify(timeline)) await prisma.fbaReportJob.update({ where: { id: reportJob.id }, data: { timelineJson: next } })
      timeline = next
    }
    if (status === 'DONE' || status === 'COMPLETED') {
      const documentId =
        typeof reportStatusBody.reportDocumentId === 'string' ? reportStatusBody.reportDocumentId : typeof reportStatusBody.documentId === 'string' ? reportStatusBody.documentId : undefined
      if (!documentId) throw new Error('REPORT_DOCUMENT_ID_NOT_RETURNED')
      // 先确定导入器再下载：不支持的报告类型不浪费一次下载。下载 → 解压 → 逐行解析 → 每 1000 行一批写库，原始文件同时留存。
      const importer = reportImporterFor(reportJob, { tenantId: row.tenantId, sellerAccountId, marketplaceId, snapshotDate: await snapshotDay() })
      timeline = withEvent(withEvent(timeline, 'AMAZON_DONE'), 'DOWNLOADING')
      await prisma.fbaReportJob.update({ where: { id: reportJob.id }, data: { timelineJson: timeline as Prisma.InputJsonValue } })
      const outcome = await importReportDocument(deps, client, documentId, importer, {
        tenantId: row.tenantId,
        reportJobId: reportJob.id,
        reportType: reportJob.reportType,
        fileName: `${reportJob.id}-${reportJob.reportType}.raw`,
        record: {
          storeKey: sellerAccountId,
          sellerAccountId,
          sourceKey: `report:${reportJob.id}`,
          reportType: reportJob.reportType,
          reportId: reportJob.externalReportId,
          periodStart: reportJob.fromDate,
          periodEnd: reportJob.toDate,
        },
      })
      const warnings = await importWarnings(prisma, reportJob, outcome.columns)
      await prisma.fbaReportJob.update({
        where: { id: reportJob.id },
        data: {
          status: 'READY',
          documentId,
          downloadUrl: outcome.downloadUrl,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          ...statsData(outcome),
          warningsJson: warningsJson(warnings),
          failureCode: null,
          failureMessage: null,
          finishedAt: new Date(),
        },
      })
      return { ready: true, reportId: reportJob.externalReportId, imported: outcome.imported }
    }
    if (['FATAL', 'CANCELLED', 'CANCELED', 'FAILED'].includes(status)) {
      await prisma.fbaReportJob.update({ where: { id: reportJob.id }, data: failedData(status, `亚马逊侧报告处理状态为 ${status}`) })
      throw new Error(`REPORT_${status}`)
    }
    return { pending: true, reportId: reportJob.externalReportId }
  }
  // 同步任务类型表里没有这一种：说明任务是绕过入口写进库的，按不可重试处理
  throw new NonRetryableError('SYNC_JOB_TYPE_UNKNOWN', `同步任务类型 ${row.type} 没有对应的处理流程`)
}
