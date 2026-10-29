import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import type { PiiSealer } from './crypto/secrets'

// 后台任务共用的类型。

export type JsonObject = Record<string, unknown>

/** 同步队列任务载荷。tenantId：入队时写入的租户编号（P1-16）；升级前入队的旧消息没有这个字段，按任务记录的归属处理。 */
export type SyncPayload = {
  tenantId?: string
  syncJobId: string
  requestId: string
  marketplaceId?: string
  fbaPlanId?: string
  /** 上游仓储：入库订单（AwdInboundOrder.id）、要执行的动作、要取标签的货件编号（P2a-08） */
  awdOrderId?: string
  awdAction?: 'CREATE' | 'UPDATE' | 'CONFIRM' | 'CANCEL' | 'TRANSPORT'
  awdShipmentId?: string
  /** 入仓计划操作（InboundOperation.id，P2a-12） */
  inboundOpId?: string
  /** 广告写入记录（AdsWriteRun.id，P3-17） */
  adsWriteRunId?: string
  /** 刊登写入与查询记录（ListingWriteRun.id，P4-10） */
  listingRunId?: string
  /** 请求评价的批次（SolicitationRequest.batchId，P4-13） */
  solicitationBatchId?: string
  /** A+ 写入记录（AplusWriteRun.id，P4-14） */
  aplusRunId?: string
  reportJobId?: string
  reportType?: string
  adsProfileId?: string
  poll?: boolean
  /** 历史回补分段（P1-19）：只处理这一段时间窗，不做默认的整段历史扫描 */
  window?: { after: string; before: string }
  retry?: boolean
  traceparent?: string
}

/** 导入器的依赖：租户连接（必须在 runWithTenant 内使用）与日志。导入器不持有任何全局状态，便于用样例文件单独测试。 */
export interface ImportContext {
  prisma: PrismaClient
  logger: Logger
  /** 加密买家个人信息的能力（订单、退货买家备注）：没有时这些列一律不写，绝不退回成明文保存。 */
  secrets?: PiiSealer
}
