import { SALES_TAX_LOOKBACK_DAYS, SALES_TAX_REPORT_TYPE, TAX_NOT_GENERATED, TAX_ROLE_PENDING } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { RawFileOpener } from '../streaming/raw-files'
import type { ImportContext } from '../types'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { syncRetrievedReports, type ReportListApi, type RetrievalResult } from './report-retrieval'
import { isRoleMissing } from './support-api'

// 销售税报告同步任务（TAX_SYNC，P2b-12，R-33）：GET_FLAT_FILE_SALES_TAX_DATA 不能 createReport、不能排程，只能卖家先在卖家后台“税务文档库”生成，
// 这里每天列出一次最近 90 天已生成的报告，没导入过的逐份下载导入（列出、去重、逐份导入在 report-retrieval.ts，与结算报告共用）。
// 两种“没有数据”不是普通失败，用不可重试的专用失败码结束，页面据此写明原因（不伪造数据）：
//   - 403（受限角色“税务汇缴”未获批）→ TAX_ROLE_PENDING（新鲜度记“未授权”，不触发同步失败预警）；
//   - 最近 90 天一份报告都没有 → TAX_NOT_GENERATED（新鲜度记“等待依赖”）。

export interface TaxSyncScope {
  tenantId: string
  sellerAccountId: string
}

export async function syncSalesTax(
  ctx: ImportContext & { openRawFile?: RawFileOpener },
  api: Pick<ReportListApi, 'listDone'>,
  client: Pick<AmazonSpApiClient, 'openReportDocument'>,
  scope: TaxSyncScope,
  options: { now?: Date } = {},
): Promise<RetrievalResult> {
  let result: RetrievalResult
  try {
    result = await syncRetrievedReports(ctx, api, client, scope, { reportType: SALES_TAX_REPORT_TYPE, lookbackDays: SALES_TAX_LOOKBACK_DAYS, requestId: 'tax-sync', now: options.now })
  } catch (error) {
    if (isRoleMissing(error)) throw new NonRetryableError(TAX_ROLE_PENDING, '亚马逊“税务汇缴”受限角色尚未获批，销售税报告无法获取')
    throw error
  }
  if (result.listed === 0) throw new NonRetryableError(TAX_NOT_GENERATED, '最近 90 天税务文档库里没有已生成的销售税报告，需先在卖家后台生成')
  return result
}
