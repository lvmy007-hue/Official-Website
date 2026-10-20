import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import IORedis from 'ioredis'
import { AppError } from './http'
@Injectable()
export class RateLimitService {
  private readonly redis: IORedis
  constructor(config: ConfigService) { this.redis = new IORedis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', { maxRetriesPerRequest: null }) }
  async check(scope: string, key: string, limit: number, seconds: number) {
    const id = `rl:${scope}:${key}`
    const count = await this.redis.incr(id)
    if (count === 1) await this.redis.expire(id, seconds)
    if (count > limit) throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', true)
  }
  async assertUnlocked(scope: string, key: string) {
    const locked = await this.redis.ttl(`lock:${scope}:${key}`)
    if (locked > 0) throw new AppError(429, 'LOGIN_LOCKED', `连续登录失败已达 10 次，请 ${Math.max(1, Math.ceil(locked / 60))} 分钟后再试`, true)
  }
  async recordFailure(scope: string, key: string, limit: number, lockSeconds: number) {
    const id = `fail:${scope}:${key}`
    const count = await this.redis.incr(id)
    if (count === 1) await this.redis.expire(id, lockSeconds)
    if (count >= limit) {
      await this.redis.set(`lock:${scope}:${key}`, '1', 'EX', lockSeconds)
      await this.redis.del(id)
      throw new AppError(429, 'LOGIN_LOCKED', '连续登录失败已达 10 次，账号锁定 30 分钟', true)
    }
  }
  async clearFailures(scope: string, key: string) {
    await this.redis.del(`fail:${scope}:${key}`, `lock:${scope}:${key}`)
  }
}
