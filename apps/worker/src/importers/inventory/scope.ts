// 库存类报告导入器共用的作用域：由分发层在下载之前确定（企业、店铺、数据口径日期、报告任务）。

export interface InventoryReportScope {
  tenantId: string
  sellerAccountId: string
  /** 报告没有日期列时使用的快照日期（企业数据口径时区的“今天”）。 */
  snapshotDate: Date
  /** 来源报告任务编号，写入各表的 sourceReportJobId。 */
  reportJobId?: string | null
  /** 测试用：固定“现在”。 */
  now?: Date
}

/** 同步表的来源字段（10.1）：来源更新时间与来源报告任务。 */
export const sourceFields = (scope: InventoryReportScope) => ({ sourceUpdatedAt: scope.now ?? new Date(), sourceReportJobId: scope.reportJobId ?? undefined })
