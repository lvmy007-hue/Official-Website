import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import IORedis from 'ioredis'
import { AppError } from './http'
@Injectable()
export class RateLimitService { private readonly redis: IORedis; constructor(config: ConfigService) { this.redis = new IORedis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', { maxRetriesPerRequest: null }) } async check(scope: string, key: string, limit: number, seconds: number) { const id = `rl:${scope}:${key}`; const count = await this.redis.incr(id); if (count === 1) await this.redis.expire(id, seconds); if (count > limit) throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', true) } }
