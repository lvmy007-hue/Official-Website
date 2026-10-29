import { SETTLEMENT_LOOKBACK_DAYS, SETTLEMENT_REPORT_TYPE } from '@nova/api-contracts'
import { reconcileTenant, type TenantReconcile } from '../settlements/run'
import type { RawFileOpener } from '../streaming/raw-files'
import type { ImportContext } from '../types'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { syncRetrievedReports, type RetrievalResult } from './report-retrieval'
import type { SettlementApi } from './settlement-api'

// 结算报告同步任务（SETTLEMENT_SYNC，P2b-07，R-28）：列出亚马逊已生成的结算报告（最近 90 天），没导入过的逐份下载导入，导入后立即核对一遍。
// 列出、去重、逐份导入与失败处理在 report-retrieval.ts（与销售税报告共用）；这里只负责导入后的三方核对。

export interface SettlementSyncScope {
  tenantId: string
  sellerAccountId: string
}
export interface SettlementSyncResult extends RetrievalResult {
  reconcile: TenantReconcile | null
}

export async function syncSettlements(
  ctx: ImportContext & { openRawFile?: RawFileOpener },
  api: Pick<SettlementApi, 'listDone'>,
  client: Pick<AmazonSpApiClient, 'openReportDocument'>,
  scope: SettlementSyncScope,
  options: { now?: Date } = {},
): Promise<SettlementSyncResult> {
  const now = options.now ?? new Date()
  const result = await syncRetrievedReports(ctx, api, client, scope, { reportType: SETTLEMENT_REPORT_TYPE, lookbackDays: SETTLEMENT_LOOKBACK_DAYS, requestId: 'settlement-sync', now })
  const reconcile = result.imported > 0 ? await reconcileTenant(ctx.prisma, scope.tenantId, now, scope.sellerAccountId) : null
  return { ...result, reconcile }
}
