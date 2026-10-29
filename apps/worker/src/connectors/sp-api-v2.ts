import type { AmazonSpApiClient } from './amazon-sp-api'
import { UpstreamHttpError } from './http-error'

// 订单、财务新版接口（P1-26）。路径、参数、枚举均于 2026 年 10 月对照亚马逊官方当期模型文件复核：
//   Orders API v2026-01-01   searchOrders：GET /orders/2026-01-01/orders      getOrder：GET /orders/2026-01-01/orders/{orderId}
//   Finances API v2024-06-19 只有一个操作 listTransactions：GET /finances/2024-06-19/transactions
// 复核发现：执行计划里写的 listBalances、listSummary 在官方该版本中不存在（官方余额接口属于另一个“卖家钱包”接口，需要钱包账户与证书）。
// 处理方式见 CR-021：余额以“递延余额”从 listTransactions（transactionStatus=DEFERRED）推导，结算汇总用结算报告。
// 所有请求固定美国站，不接受其他站点参数。

export const US_MARKETPLACE = 'ATVPDKIKX0DER'

/** includedData 全部数据集。BUYER、RECIPIENT 含买家个人信息，需要“买家个人信息”类角色；没有该角色时去掉这两项重试。 */
export const ORDERS_DATASETS = ['BUYER', 'RECIPIENT', 'FULFILLMENT', 'PROCEEDS', 'EXPENSE', 'PROMOTION', 'CANCELLATION', 'PACKAGES', 'TAX', 'PAYMENT'] as const
export const ORDERS_DATASETS_WITHOUT_PII = ORDERS_DATASETS.filter(name => name !== 'BUYER' && name !== 'RECIPIENT')

/** 订单分页令牌 24 小时有效；单页最多 100 单。 */
export const ORDERS_PAGE_SIZE = 100
/** 交易列表：起止时间相隔超过 180 天时接口返回空，窗口必须不超过该值；结束时间必须早于请求时刻两分钟以上。 */
export const FINANCE_MAX_WINDOW_DAYS = 180

export type TransactionStatus = 'DEFERRED' | 'RELEASED' | 'DEFERRED_RELEASED'

export type SearchOrdersInput = {
  /** 与 lastUpdated* 二选一：官方要求两者只能给一个。 */
  createdAfter?: string
  createdBefore?: string
  lastUpdatedAfter?: string
  lastUpdatedBefore?: string
  paginationToken?: string
  includedData: readonly string[]
}

export type ListTransactionsInput = { postedAfter: string; postedBefore?: string; nextToken?: string; transactionStatus?: TransactionStatus }

/** 没有买家个人信息角色：接口返回 403。上层据此降级为不含买家信息并标注“无权限”。 */
export const isRoleDenied = (error: unknown) => error instanceof UpstreamHttpError && error.source === 'api' && error.status === 403

export class SpApiV2 {
  constructor(private readonly client: AmazonSpApiClient) {}

  searchOrders(input: SearchOrdersInput) {
    const timeWindow = input.createdAfter
      ? { createdAfter: input.createdAfter, ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}) }
      : { lastUpdatedAfter: input.lastUpdatedAfter ?? '', ...(input.lastUpdatedBefore ? { lastUpdatedBefore: input.lastUpdatedBefore } : {}) }
    // 翻页时除 maxResultsPerPage、includedData 外所有参数必须与首次请求一致，所以翻页也带上同样的时间窗
    return this.client.request({
      path: '/orders/2026-01-01/orders',
      query: {
        marketplaceIds: US_MARKETPLACE,
        ...timeWindow,
        maxResultsPerPage: String(ORDERS_PAGE_SIZE),
        includedData: input.includedData.join(','),
        ...(input.paginationToken ? { paginationToken: input.paginationToken } : {}),
      },
    })
  }

  getOrder(orderId: string, includedData: readonly string[]) {
    return this.client.request({ path: `/orders/2026-01-01/orders/${encodeURIComponent(orderId)}`, query: { includedData: includedData.join(',') } })
  }

  /** 翻页时必须带与首次相同的全部参数（官方要求），所以时间窗、状态每页都传。 */
  listTransactions(input: ListTransactionsInput) {
    return this.client.request({
      path: '/finances/2024-06-19/transactions',
      query: {
        postedAfter: input.postedAfter,
        ...(input.postedBefore ? { postedBefore: input.postedBefore } : {}),
        marketplaceId: US_MARKETPLACE,
        ...(input.transactionStatus ? { transactionStatus: input.transactionStatus } : {}),
        ...(input.nextToken ? { nextToken: input.nextToken } : {}),
      },
    })
  }
}
