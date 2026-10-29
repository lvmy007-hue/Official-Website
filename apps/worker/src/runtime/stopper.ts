import { GracefulShutdown } from '@nova/workflow'
import type { createWorkerLogger } from '../logger'

// 优雅停机的步骤登记（从 main.ts 拆出）：先停止接新任务并等进行中的任务收尾，再关闭队列与数据库连接；超时则强制退出。步骤按注册的相反顺序执行。

type Closable = { close: () => Promise<unknown> }
type Disconnectable = { $disconnect: () => Promise<unknown> }
type Logger = Pick<ReturnType<typeof createWorkerLogger>, 'info' | 'error'>

export function createStopper(deps: { logger: Logger; redis: Closable; prisma: Disconnectable; systemDb: Disconnectable; queues: Closable; consumers: Closable[]; stopTimers: () => void }) {
  const stopper = new GracefulShutdown({
    timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0 ? Number(process.env.SHUTDOWN_TIMEOUT_MS) : 30_000,
    logger: { info: message => deps.logger.info(message), error: message => deps.logger.error(message) },
  })
  stopper.register('Redis 连接', async () => void (await deps.redis.close()))
  stopper.register('数据库连接', async () => {
    await deps.prisma.$disconnect()
    await deps.systemDb.$disconnect()
  })
  stopper.register('队列', async () => void (await deps.queues.close()))
  stopper.register('队列消费者（等待进行中的任务收尾）', async () => {
    await Promise.all(deps.consumers.map(item => item.close()))
  })
  stopper.register('定时器', async () => deps.stopTimers())
  return stopper
}
