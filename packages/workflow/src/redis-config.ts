// Redis 连接配置（P1-25，12 章 12.3 / 12.9 第 2 条）：接口服务与后台任务共用，保证两边解析与加密选项一致。
//   - 队列实例（QUEUE_REDIS_URL）：存任务，不淘汰、开持久化、设密码；
//   - 缓存实例（CACHE_REDIS_URL）：存限流桶、并发槽位等可重建数据，内存满淘汰最久未用的键；
//   - 两个变量都没配置时退回 REDIS_URL（仅开发与测试，生产启动检查拒绝）；
//   - 加密连接：连接串写 rediss:// 即启用，可选 REDIS_TLS_CA_FILE（私有 CA）与 REDIS_TLS_SERVERNAME；永远校验证书，不提供关闭选项。

import { readFileSync } from 'node:fs'

type Env = Record<string, string | undefined>

export interface RedisUrls {
  queue: string
  cache: string
  /** 队列与缓存是否是两个不同的实例。 */
  separated: boolean
}

export function redisUrls(env: Env = process.env): RedisUrls {
  const fallback = env.REDIS_URL ?? 'redis://localhost:6379'
  const queue = env.QUEUE_REDIS_URL ?? fallback
  const cache = env.CACHE_REDIS_URL ?? fallback
  return { queue, cache, separated: queue !== cache }
}

export interface RedisClientOptions {
  maxRetriesPerRequest: null
  tls?: { minVersion: 'TLSv1.2'; rejectUnauthorized: true; ca?: Buffer; servername?: string }
}

/** 创建 ioredis 客户端用的选项：BullMQ 要求 maxRetriesPerRequest 为 null；rediss:// 时附带严格的 TLS 选项。 */
export function redisClientOptions(url: string, env: Env = process.env): RedisClientOptions {
  if (!url.startsWith('rediss://')) return { maxRetriesPerRequest: null }
  const caFile = env.REDIS_TLS_CA_FILE
  return {
    maxRetriesPerRequest: null,
    tls: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(caFile ? { ca: readFileSync(caFile) } : {}),
      ...(env.REDIS_TLS_SERVERNAME ? { servername: env.REDIS_TLS_SERVERNAME } : {}),
    },
  }
}

const hasPassword = (url: string) => {
  try {
    return new URL(url).password.length > 0
  } catch {
    return false
  }
}

/**
 * 生产环境 Redis 配置检查（返回问题列表，空数组表示通过）：
 *   - 队列与缓存必须分别配置、指向两个不同的实例（队列不淘汰，缓存要淘汰，不能共用一个淘汰策略）；
 *   - 两个实例都必须带密码；
 *   - REDIS_REQUIRE_TLS=true（跨机部署、托管 Redis）时两个连接串都必须是 rediss://。
 */
export function redisProductionProblems(env: Env = process.env): string[] {
  const problems: string[] = []
  const queueUrl = env.QUEUE_REDIS_URL
  const cacheUrl = env.CACHE_REDIS_URL
  if (!queueUrl || !cacheUrl) {
    problems.push('生产环境必须分别配置 QUEUE_REDIS_URL（队列实例，不淘汰、开持久化）与 CACHE_REDIS_URL（缓存实例，内存满时淘汰），不得共用 REDIS_URL')
    return problems
  }
  if (queueUrl === cacheUrl) problems.push('QUEUE_REDIS_URL 与 CACHE_REDIS_URL 不能指向同一个实例：队列不允许淘汰任何键，缓存需要淘汰，两者淘汰策略冲突')
  for (const [name, url] of [
    ['QUEUE_REDIS_URL', queueUrl],
    ['CACHE_REDIS_URL', cacheUrl],
  ] as const) {
    if (!hasPassword(url)) problems.push(`${name}：Redis 必须设置密码，连接串写成 redis://:密码@主机:端口`)
    if (env.REDIS_REQUIRE_TLS === 'true' && !url.startsWith('rediss://')) problems.push(`${name}：REDIS_REQUIRE_TLS=true 时必须使用 rediss:// 加密连接`)
  }
  if (env.REDIS_REQUIRE_TLS === 'true' && env.REDIS_TLS_CA_FILE) {
    try {
      readFileSync(env.REDIS_TLS_CA_FILE)
    } catch {
      problems.push(`REDIS_TLS_CA_FILE：无法读取 ${env.REDIS_TLS_CA_FILE}`)
    }
  }
  return problems
}
