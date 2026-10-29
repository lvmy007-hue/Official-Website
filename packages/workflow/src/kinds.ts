// 写亚马逊对象的流程类型与去重键：接口服务（受理用户操作时先登记流程）与后台任务（真正调用亚马逊）共用，
// 两边用同一个去重键，后台任务续上接口服务登记的流程，审计里的 writeRunId 才能指向真正执行的流程。

export const WORKFLOW_KINDS = {
  INBOUND_PLAN_CREATE: 'inbound.plan.create',
  REPORT_CREATE: 'report.create',
  AWD_ORDER_WRITE: 'awd.order.write',
  INBOUND_PLAN_OP: 'inbound.plan.op',
  ADS_WRITE: 'ads.write',
  LISTING_WRITE: 'listing.write',
  SOLICITATION_SEND: 'solicitation.send',
  APLUS_WRITE: 'aplus.write',
} as const

export type WorkflowKind = (typeof WORKFLOW_KINDS)[keyof typeof WORKFLOW_KINDS]

/** 流程意图（持久化到 WorkflowRun.intentJson）：只含内部编号，不含令牌与个人信息。 */
export interface WriteRunIntent {
  tenantId: string
  connectionId: string
  fbaPlanId?: string
  reportJobId?: string
  reportType?: string
  marketplaceId?: string
  /** 上游仓储入库订单（AwdInboundOrder.id）与要执行的动作（P2a-08）。 */
  awdOrderId?: string
  awdAction?: 'CREATE' | 'UPDATE' | 'CONFIRM' | 'CANCEL' | 'TRANSPORT'
  /** 入仓计划操作（InboundOperation.id，P2a-12）。 */
  inboundOpId?: string
  /** 广告写入记录（AdsWriteRun.id，P3-17）。 */
  adsWriteRunId?: string
  /** 刊登写入记录（ListingWriteRun.id，P4-10）。 */
  listingRunId?: string
  /** 请求评价的批次（SolicitationRequest.batchId，P4-13）：同一批订单一个流程。 */
  solicitationBatchId?: string
  /** A+ 写入记录（AplusWriteRun.id，P4-14）。 */
  aplusRunId?: string
}

/**
 * 去重键 = 流程类型 + 业务对象编号 + 队列任务编号。
 * 同一个队列任务的多次重试沿用同一个流程；用户在界面上点“重试”会产生新的队列任务，从而开始新的流程。
 */
export const writeRunDedupeKey = (kind: WorkflowKind, objectId: string, queueJobId: string) => `${kind}:${objectId}:${queueJobId}`
