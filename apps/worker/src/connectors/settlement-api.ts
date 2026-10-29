import { SETTLEMENT_REPORT_TYPE } from '@nova/api-contracts'
import type { AmazonSpApiClient } from './amazon-sp-api'
import { REPORTS_PATH, RETRIEVAL_LIST_PAGE_SIZE, ReportListApi, parseReportRefs, type RetrievedReportRef } from './report-retrieval'

// 结算报告的检索（Reports API 2021-06-30，importers.md R-28）。结算报告由亚马逊按结算周期自动生成，不能用 createReport 申请，
// 只能列出已经生成的（processingStatuses=DONE）再下载；列出与翻页的共用部分在 report-retrieval.ts（销售税报告同理）。

export { REPORTS_PATH }
export const SETTLEMENT_LIST_PAGE_SIZE = RETRIEVAL_LIST_PAGE_SIZE
export type SettlementReportRef = RetrievedReportRef

export class SettlementApi extends ReportListApi {
  constructor(client: Pick<AmazonSpApiClient, 'request'>) {
    super(client, SETTLEMENT_REPORT_TYPE)
  }
}

/** 解析一页结算报告列表：不是结算报告类型、没有报告编号或文档编号的条目跳过（计数）。 */
export const parseReportList = (body: unknown) => parseReportRefs(body, SETTLEMENT_REPORT_TYPE)
