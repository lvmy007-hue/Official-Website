import { CONNECTION_HEALTH_INTERVAL_MS, CONNECTION_HEALTH_JOB, refreshDomainOf, refreshVerdict, type RefreshPolicy } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import type { PiiSealer } from '../crypto/secrets'
import type { AlertEvaluatorRegistry } from '../platform/alert-evaluate'
import { loadRefreshPolicy } from '../platform/tenant-policy'
import type { QueueRegistry } from '../runtime/queues'

export interface ScheduleDeps {
  prisma: PrismaClient
  systemPrisma: PrismaClient
  logger: Logger
  queues: QueueRegistry
  /** 对象存储：原始报告文件到期清理用；不提供则不清理。 */
  storage?: ObjectStorage
  /** 预警评估器注册表（P1-28-5）：各业务工作包注册评估器；没有注册任何评估器时不评估。 */
  alertEvaluators?: AlertEvaluatorRegistry
  /** 应用层加密（P6-14）：退货买家备注存量加密任务用；不提供则不跑。 */
  secrets?: PiiSealer
}

/** 只刷新库存的间隔：库存接口（FBA Inventory API）近实时，每 30 分钟拉一次，不等 6 小时的全量同步。 */
export const INVENTORY_REFRESH_INTERVAL_MS = 30 * 60 * 1000
/** 上游仓储（AWD）：库存与货件每 2 小时刷新一次（新鲜度阈值 120 分钟，见 freshness.ts）。 */
export const AWD_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 支持案件（P2b-04，I-20）：案件与沟通记录每 2 小时只读同步一次（需要“卖家支持”受限角色，未获批时同步以 SUP_ROLE_PENDING 结束）。 */
export const SUPPORT_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 商品目录（P2a-14，I-09）：每日全量，不跟 6 小时的全量同步一起跑（目录接口限速低，每次要请求店铺里全部 ASIN）。 */
export const CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 结算报告（P2b-07，R-28）：每日检索一次亚马逊已生成的结算报告（周期结束后才会生成，一天一次足够）。 */
export const SETTLEMENT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 销售税报告（P2b-12，R-33）：每日检索一次税务文档库里已生成的报告（卖家后台生成后才有，没有或受限角色未批时同步以专用失败码结束）。 */
export const TAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 促销与优惠券（P4-05，I-17）：每日只读同步一次；接口限速每 10 秒 1 次，不跟 6 小时的全量同步一起跑（每次的调用量有上限，剩余的下一天继续）。 */
export const PROMOTIONS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 刊登质量（P4-10，I-10）：每日全量读取一次刊登问题、状态与内容；每页 20 个、限速较慢，单独占一个定时器，不跟 6 小时的全量同步一起跑。 */
export const LISTING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 定价（P4-11，I-13）：每 2 小时同步一次我方报价、推荐报价预期价格与竞争摘要（新鲜度阈值 120 分钟，见 freshness.ts）；批量接口限速约 30 秒一次，每次的批数有上限。 */
export const PRICING_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000
/** 竞品监控（P4-12）：每 6 小时对关注的竞品 ASIN 取商品目录与竞争摘要（新鲜度阈值 360 分钟，见 freshness.ts）；竞争摘要官方限速约 30 秒一次，每次的批数有上限。 */
export const COMPETITOR_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 客户反馈（P4-13，I-15）：每日一次，每次轮转一批商品（最多 40 个，距上次快照不足 6 天的跳过，所以每个商品大约每周刷新一次）；接口限速慢、需要品牌分析权限，没有权限时同步以 FBK_NO_BRAND_ACCESS 结束（新鲜度记“未授权”）。 */
export const FEEDBACK_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A+ 内容（P4-14，I-18）：每日一次只读同步内容、关联 ASIN 与发布记录（每次最多 100 份内容、30 个 ASIN 的发布记录）；需要品牌备案与 A+ 内容角色，没有时同步以 APL_ROLE_MISSING 结束（新鲜度记“未授权”，不触发同步失败预警）。 */
export const APLUS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 连接健康检查（P5-04）：每个已授权连接每天检查一次（后台任务解密令牌后调用一个只读接口），结果写入连接的健康记录。 */
export const CONNECTION_HEALTH_REFRESH_INTERVAL_MS = CONNECTION_HEALTH_INTERVAL_MS

/** 只在专属定时器里跑的任务类型：6 小时全量同步（不传 only）时排除。 */
const DEDICATED_TIMER_TYPES: readonly string[] = [
  'CATALOG_SYNC',
  'SETTLEMENT_SYNC',
  'TAX_SYNC',
  'PROMOTIONS_SYNC',
  'LISTING_SYNC',
  'PRICING_SYNC',
  'COMPETITOR_SYNC',
  'FEEDBACK_SYNC',
  'APLUS_SYNC',
  CONNECTION_HEALTH_JOB,
]

/**
 * 企业在设置里放慢或暂停了这个数据域（P5-10）：暂停就不排；放慢就看距上一次定时同步够不够久。
 * 只管定时同步（requestId 为 schedule）；手动同步、回补、写入后的刷新不受影响。没有设置过的数据域不额外查询。
 */
export async function refreshAllowed(prisma: Pick<PrismaClient, 'syncJob'>, policy: RefreshPolicy, connectionId: string, type: string, now = new Date()): Promise<boolean> {
  const domain = refreshDomainOf(type)
  const override = policy[type]
  if (!domain || !override) return true
  const last = override.mode === 'EVERY' ? await prisma.syncJob.findFirst({ where: { connectionId, type, requestId: 'schedule' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }) : null
  return refreshVerdict(override, domain.builtInMinutes, last?.createdAt ?? null, now).due
}

export async function scheduleProductionSync(deps: ScheduleDeps, only?: readonly string[]) {
  const { prisma, systemPrisma, queues } = deps
  if (process.env.APP_MODE !== 'production' || process.env.MOCK_CONNECTOR === 'true') return
  // 跨租户扫描只用系统连接，且只取出连接编号与归属；建任务与入队在各自租户的上下文里完成。暂停、停用、注销中与已注销的企业不再定时同步（P1-19）。
  const active = { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } } // 暂停、停用、注销中的企业不再定时同步
  const connections = await systemPrisma.platformConnection.findMany({
    where: { state: 'AUTHORIZED', encryptedRefreshToken: { not: null }, tenant: active },
    select: { id: true, tenantId: true, provider: true },
  })
  for (const connection of connections) {
    await runWithTenant(connection.tenantId, async () => {
      // 数据中心查询（P2b-11 起每天定时排）可能排队几个小时，不算“进行中的同步”，否则会把这个店铺的所有常规同步一直挡住
      const active = await prisma.syncJob.count({
        where: { connectionId: connection.id, status: { in: ['PENDING', 'RUNNING'] }, type: { notIn: ['DATA_KIOSK_QUERY', 'ADS_REPORT_V1', 'ADS_ENTITY_SYNC', 'ADS_PARITY', CONNECTION_HEALTH_JOB] } },
      })
      if (active > 0) return
      const all =
        connection.provider === 'AMAZON_ADS_API'
          ? ['FBA_ADS', CONNECTION_HEALTH_JOB]
          : connection.provider === 'AMAZON_SP_API'
            ? [
                'FBA_ORDERS',
                'FBA_INVENTORY',
                'FBA_FINANCE',
                'FBA_INBOUND_SYNC',
                'FBA_REPLENISHMENT',
                'AWD_SYNC',
                'CATALOG_SYNC',
                'SUPPORT_SYNC',
                'SETTLEMENT_SYNC',
                'TAX_SYNC',
                'PROMOTIONS_SYNC',
                'LISTING_SYNC',
                'PRICING_SYNC',
                'COMPETITOR_SYNC',
                'FEEDBACK_SYNC',
                'APLUS_SYNC',
                CONNECTION_HEALTH_JOB,
              ]
            : []
      const types = only ? all.filter(type => only.includes(type)) : all.filter(type => !DEDICATED_TIMER_TYPES.includes(type))
      const policy = await loadRefreshPolicy(prisma, connection.tenantId)
      for (const type of types) {
        if (!(await refreshAllowed(prisma, policy, connection.id, type))) continue
        const job = await prisma.syncJob.create({
          data: {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            type,
            status: 'PENDING',
            requestId: 'schedule',
            domain: syncDomainOf(type),
            priority: PRIORITY.SCHEDULED,
            sourceKey: syncSourceKey(connection.id, type, 'ATVPDKIKX0DER'),
          },
        })
        await queues.addSync(type, { tenantId: connection.tenantId, syncJobId: job.id, requestId: 'schedule', marketplaceId: 'ATVPDKIKX0DER' }, { jobId: job.id, priority: PRIORITY.SCHEDULED })
      }
    })
  }
}
export async function purgeExpiredBuyerInformation(deps: ScheduleDeps) {
  const { systemPrisma, logger } = deps
  // 到期清理对全部租户一视同仁，用系统连接一次完成
  const result = await systemPrisma.order.updateMany({ where: { piiExpiresAt: { lte: new Date() }, piiCiphertext: { not: null } }, data: { piiCiphertext: null } })
  if (result.count) logger.info({ count: result.count }, 'expired buyer information deleted')
  // 退货买家备注（P6-14）与订单买家信息同一套保留规则：到期清除密文与类别，保留期截止一并置空
  const comments = await systemPrisma.fbaReturnCase.updateMany({
    where: { customerCommentsCipher: { not: null }, customerCommentsExpiresAt: { lte: new Date() } },
    data: { customerCommentsCipher: null, customerCommentsExpiresAt: null, customerCommentsKinds: null },
  })
  if (comments.count) logger.info({ count: comments.count }, 'expired return comments deleted')
}
