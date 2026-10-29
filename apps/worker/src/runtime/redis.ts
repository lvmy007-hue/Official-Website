import { redisClientOptions, redisUrls } from '@nova/workflow'
import IORedis from 'ioredis'

// 两个 Redis 实例（12.3）：
// - 队列实例（QUEUE_REDIS_URL）：存任务，不允许淘汰任何键，开持久化，设密码；
// - 缓存实例（CACHE_REDIS_URL）：存限流桶、并发槽位等可重建的数据，内存满时淘汰最久未用的键。
// 两个变量都没配置时都退回 REDIS_URL（仅开发与测试；生产启动检查要求分开配置并设密码，见 @nova/workflow 的 redis-config）。
// 连接串写 rediss:// 即启用加密连接（证书始终校验）。

export interface RedisConnections {
  queue: IORedis
  cache: IORedis
  close(): Promise<void>
}

export { redisUrls }

export function createRedisConnections(env: NodeJS.ProcessEnv = process.env): RedisConnections {
  const urls = redisUrls(env)
  const queue = new IORedis(urls.queue, redisClientOptions(urls.queue, env))
  const cache = urls.separated ? new IORedis(urls.cache, redisClientOptions(urls.cache, env)) : queue
  return {
    queue,
    cache,
    async close() {
      await queue.quit()
      if (cache !== queue) await cache.quit()
    },
  }
}
