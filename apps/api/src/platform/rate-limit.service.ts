import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { RATE_BUCKET_PREFIX, TENANT_SLOT_PREFIX, redisClientOptions, redisUrls } from '@nova/workflow'
import IORedis from 'ioredis'
import { AppError } from './http'
const failureNoun = (scope: string) => (scope === 'login' ? '登录' : '验证')

/** 令牌桶在 Redis 里的原始记录（时间为毫秒时间戳）。 */
export interface RawBucket {
  connectionId: string
  family: string
  tokens: number
  updatedAt: number
  rate: number
  burst: number
  blockedUntil: number
  limitedAt: number | null
}

@Injectable()
export class RateLimitService {
  private readonly redis: IORedis
  constructor(config: ConfigService) {
    const url = redisUrls({ REDIS_URL: config.get<string>('REDIS_URL'), CACHE_REDIS_URL: config.get<string>('CACHE_REDIS_URL') }).cache
    this.redis = new IORedis(url, redisClientOptions(url, process.env))
  }
  async check(scope: string, key: string, limit: number, seconds: number) {
    const id = `rl:${scope}:${key}`
    const count = await this.redis.incr(id)
    if (count === 1) await this.redis.expire(id, seconds)
    if (count > limit) throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', true)
  }
  async assertUnlocked(scope: string, key: string) {
    const locked = await this.redis.ttl(`lock:${scope}:${key}`)
    if (locked > 0) throw new AppError(429, 'LOGIN_LOCKED', `${failureNoun(scope)}失败次数过多，请 ${Math.max(1, Math.ceil(locked / 60))} 分钟后再试`, true)
  }
  async recordFailure(scope: string, key: string, limit: number, lockSeconds: number) {
    const id = `fail:${scope}:${key}`
    const count = await this.redis.incr(id)
    if (count === 1) await this.redis.expire(id, lockSeconds)
    if (count >= limit) {
      await this.redis.set(`lock:${scope}:${key}`, '1', 'EX', lockSeconds)
      await this.redis.del(id)
      throw new AppError(429, 'LOGIN_LOCKED', `连续${failureNoun(scope)}失败已达 ${limit} 次，暂时锁定 ${Math.ceil(lockSeconds / 60)} 分钟`, true)
    }
  }
  async clearFailures(scope: string, key: string) {
    await this.redis.del(`fail:${scope}:${key}`, `lock:${scope}:${key}`)
  }

  /** 同步中心的限速状态：读出某企业所有店铺授权的令牌桶（后台任务按“企业:连接:接口族”记在缓存 Redis 里，一小时没人用就过期）。只读，最多 limit 个。 */
  async buckets(tenantId: string, limit = 200): Promise<{ items: RawBucket[]; truncated: boolean }> {
    const prefix = `${RATE_BUCKET_PREFIX}:${tenantId}:`
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200)
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0' && keys.length <= limit)
    const unique = [...new Set(keys)].sort()
    const picked = unique.slice(0, limit)
    const rows = await Promise.all(picked.map(key => this.redis.hgetall(key)))
    const items = picked.flatMap((key, index): RawBucket[] => {
      const [connectionId, ...family] = key.slice(prefix.length).split(':')
      const hash = rows[index] ?? {}
      const rate = Number(hash.rate)
      if (!connectionId || family.length === 0 || !Number.isFinite(rate) || hash.ts === undefined) return []
      const num = (value: string | undefined) => (value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null)
      return [
        {
          connectionId,
          family: family.join(':'),
          tokens: num(hash.tokens) ?? 0,
          updatedAt: num(hash.ts) ?? 0,
          rate,
          burst: num(hash.burst) ?? 1,
          blockedUntil: num(hash.blocked) ?? 0,
          limitedAt: num(hash.limitedAt),
        },
      ]
    })
    return { items, truncated: unique.length > limit || cursor !== '0' }
  }

  /** 企业此刻占用的并发槽位（租约未到期的）。 */
  async tenantSlots(tenantId: string, now: number = Date.now()): Promise<number> {
    return this.redis.zcount(`${TENANT_SLOT_PREFIX}:${tenantId}`, now, '+inf')
  }
}
