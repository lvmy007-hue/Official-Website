import { secretConfigProblems } from '@nova/crypto'
import { createObjectStorage } from '@nova/storage'
import { databaseDeploymentProblems } from '@nova/tenancy'
import { redisProductionProblems } from '@nova/workflow'
import { createStopper } from './runtime/stopper'
import type { Job } from 'bullmq'
import { createWorkerKeyring, WorkerSecrets } from './crypto/secrets'
import { createWorkerLogger } from './logger'
import { registerExportHandlers } from './exports/register'
import { registerLifecycleHandlers } from './lifecycle/register'
import { registerDataKioskDatasets } from './datakiosk/register'
import { startDeriveListener } from './listeners/derive-listener'
import { registerNotificationProcessors } from './importers/notifications/register'
import { createAlertEvaluators } from './alerts/register'
import { NotificationProcessorRegistry } from './platform/notification-events'
import { registerPlatformHandlers } from './platform/register'
import { spApiNotificationsFactory } from './platform/subscriptions'
import { startSchedules } from './listeners/schedules'
import { processSync, type SyncListenerDeps } from './listeners/sync-listener'
import { AuxHandlerRegistry, requestedConcurrency, startConsumers } from './runtime/consumers'
import { DERIVE_QUEUE_NAME } from './derivers/derive'
import { MEMORY_EXIT_CODE, MemoryGuard, budgetedConcurrency, memoryBudget, memoryGuardOptionsFromEnv } from './runtime/memory-guard'
import { QueueRegistry } from './runtime/queues'
import { recoverOnce, startRecovery } from './runtime/recovery'
import { createRedisConnections } from './runtime/redis'
import { createReliability } from './runtime/reliability'
import { registerSlowQueryLog } from './runtime/slow-query'
import { createWriteWorkflows } from './runtime/workflows'
import { createRawFileOpener, rawFileRetentionDays } from './streaming/raw-files'
import { createTenantDatabases } from './tenant-db'
import { runInJobTrace } from './tracing'
import type { SyncPayload } from './types'

// 后台任务进程入口：只负责装配依赖、启动监听器与定时任务、处理停机。业务代码分布在：connectors/（接口客户端与按任务类型分发）、
// importers/（导入器）、derivers/（日汇总刷新）、listeners/（队列消费者与定时任务）、runtime/（可靠性：锁、限速、重试、死信、恢复）。

const logger = createWorkerLogger()

// 生产环境启动前的部署配置检查（P1-25）：队列与缓存分两个带密码的 Redis、数据库系统连接单独配置、加密连接与证书校验不得被关闭
if (process.env.APP_MODE === 'production') {
  const problems = [...redisProductionProblems(), ...databaseDeploymentProblems(), ...secretConfigProblems()]
  if (problems.length) {
    logger.fatal({ problems }, '部署配置不合格，后台任务拒绝启动')
    process.exit(1)
  }
}
const mock = process.env.MOCK_CONNECTOR === 'true' && process.env.APP_MODE !== 'production'
// prisma：租户连接（任务必须在 runWithTenant 内使用）；systemPrisma：系统连接（跨租户扫描、反查归属、分区维护、到期清理）
const { prisma, systemPrisma, tenantBase } = createTenantDatabases()
// 慢查询告警：超过 SLOW_QUERY_MS（默认 1000 毫秒）记录语句文本与耗时；不记录参数（可能含个人信息）。
registerSlowQueryLog(tenantBase, logger)

// 队列与缓存分两个 Redis 实例（见 runtime/redis.ts）；可靠性工具箱：租约锁、租户公平并发、店铺限速、死信、流程状态机。
const redis = createRedisConnections()
const queues = new QueueRegistry(redis)
const reliability = createReliability({ prisma, systemPrisma, redis })
// 应用层加密：启动前确保数据密钥齐全、主密钥配置正确（配置错误在这里暴露，而不是等到第一个任务失败）
const secrets = new WorkerSecrets(createWorkerKeyring(systemPrisma))
void secrets.prepare().catch(error => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'encryption keys are not usable; worker refuses to run')
  process.exit(1)
})
// 对象存储：原始报告文件一边下载一边写入；本进程只写入，不签发链接（signs: false）。写流程也要读文件（A+ 上传图片，P4-14），所以先于写流程创建
const storage = createObjectStorage(process.env, { signs: false })
const writeWorkflows = createWriteWorkflows({ prisma, guardFor: reliability.guardFor, secrets, storage })
// 写流程全部登记：崩溃后的恢复扫描靠这里认出每一种 kind（新增写流程不用再改这里）
for (const flow of Object.values(writeWorkflows)) reliability.engine.register(flow)

const openRawFile = createRawFileOpener({ storage, prisma, logger, retentionDays: rawFileRetentionDays() })

const syncDeps: SyncListenerDeps = { prisma, systemPrisma, logger, reliability, queues, writeWorkflows, mock, openRawFile, secrets, storage }
const auxHandlers = new AuxHandlerRegistry()
registerLifecycleHandlers(auxHandlers, { db: systemPrisma, storage, logger }) // 租户注销流程（P1-19）：用系统连接跨表导出与删除
registerExportHandlers(auxHandlers, { db: prisma, storage }) // 导出中心（P1-28）：在发起人所属租户的上下文里流式生成文件
// 通知队列（P1-28）：汇率立即获取、亚马逊通知订阅的创建与取消、事件重放；评估器与事件处理器由各业务工作包向下面两个注册表登记
const alertEvaluators = createAlertEvaluators() // P2a-15：库存、入仓差异、同步失败、授权失效
const notificationProcessors = new NotificationProcessorRegistry()
registerNotificationProcessors(notificationProcessors, { db: prisma, storage, queues }) // 小时销售/流量/库存（P2a-03）、物流库存变化（P2a-05）、交易更新（P2b-05）
registerDataKioskDatasets() // 数据中心数据集：经济模拟（P2a-07）、官方单品经济与费用预览（P2b-11）
registerPlatformHandlers(auxHandlers, { db: prisma, api: spApiNotificationsFactory({ secrets, guardFor: reliability.guardFor }), processors: notificationProcessors })
// 并发按内存预算设定（12.5）：流式处理后单个任务的内存与文件大小无关，预算 / 单任务估算 = 可同时处理的任务数。
const concurrency = budgetedConcurrency({ ...requestedConcurrency(), [DERIVE_QUEUE_NAME]: 2 })
logger.info({ ...memoryBudget(), concurrency }, 'worker concurrency by memory budget')

// 同步任务按数据域拆分队列（并保留旧的 sync 队列消费升级前的消息）；报表、导出、通知各有消费者（处理器由对应工作包注册）。
const consumers = startConsumers({
  redis,
  reliability,
  logger,
  aux: auxHandlers,
  concurrency,
  processSync: (job, token) =>
    runInJobTrace('sync', (job.data as SyncPayload).traceparent, { 'nova.request_id': (job.data as SyncPayload).requestId, 'nova.sync_job_id': (job.data as SyncPayload).syncJobId }, () =>
      processSync(syncDeps, job as Job<SyncPayload>, token),
    ),
})
const derive = startDeriveListener({ connection: redis.queue, logger, concurrency: concurrency[DERIVE_QUEUE_NAME], db: prisma })
const stopSchedules = startSchedules({ prisma, systemPrisma, logger, queues, storage, alertEvaluators, secrets })

// 崩溃恢复：启动时立即扫描一次，之后定时扫描——接管心跳过期的流程，并兜底队列数据丢失的同步任务。
const recoveryDeps = { reliability, systemPrisma, redis, queues: queues.get, logger }
void recoverOnce(recoveryDeps).catch(error => logger.error({ error: error instanceof Error ? error.message : String(error) }, 'startup recovery failed'))
const stopRecovery = startRecovery(recoveryDeps)
logger.info({ mock, mode: process.env.APP_MODE ?? 'development', consumers: consumers.map(item => item.name) }, 'NOVA worker started')

// 优雅停机（步骤见 runtime/stopper.ts）
const stopper = createStopper({ logger, redis, prisma, systemDb: systemPrisma, queues, consumers: [...consumers, derive.worker], stopTimers: () => (stopSchedules(), stopRecovery()) })
const shutdown = (exitCode = 0) => {
  void stopper.run().then(done => process.exit(done ? exitCode : 1))
}
process.on('SIGTERM', () => shutdown())
process.on('SIGINT', () => shutdown())

// 内存守卫：常驻内存或堆占用连续超限（泄漏或异常任务）→ 不再领取新任务、等在途任务收尾后以重启码退出，由守护进程拉起新进程。
const memoryGuard = new MemoryGuard({ ...memoryGuardOptionsFromEnv(), logger, onExceeded: () => shutdown(MEMORY_EXIT_CODE) }).start()
stopper.register('内存守卫', async () => {
  memoryGuard.stop()
})
