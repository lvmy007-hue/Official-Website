// 租户公平调度（12.3）：任何一个租户同时占用的并发槽位不超过上限，避免大租户的回补任务饿死其他租户。
// 槽位带租约：持有进程崩溃后槽位在租约到期时自动释放，不会永久占坑。

import { randomUUID } from 'node:crypto'
import type { RedisLike } from './rate-limit'

export interface ConcurrencyGate {
  /** 尝试占一个槽位：成功返回释放函数，已满返回 null（调用方应把任务延后，而不是失败）。 */
  tryAcquire(tenantId: string): Promise<(() => Promise<void>) | null>
}

export class MemoryConcurrencyGate implements ConcurrencyGate {
  private readonly counts = new Map<string, number>()
  constructor(private readonly limit: number) {}
  async tryAcquire(tenantId: string) {
    const current = this.counts.get(tenantId) ?? 0
    if (current >= this.limit) return null
    this.counts.set(tenantId, current + 1)
    let released = false
    return async () => {
      if (released) return
      released = true
      this.counts.set(tenantId, Math.max(0, (this.counts.get(tenantId) ?? 1) - 1))
    }
  }
  active(tenantId: string) {
    return this.counts.get(tenantId) ?? 0
  }
}

const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`

export interface RedisGateRedis extends RedisLike {
  zrem(key: string, member: string): Promise<unknown>
}

/** 租户并发槽位在 Redis 里的键前缀：键是 `tenant-slots:<租户>`（有序集合，分值是租约到期时间），同步中心据此读出当前占用。 */
export const TENANT_SLOT_PREFIX = 'tenant-slots'

export class RedisConcurrencyGate implements ConcurrencyGate {
  constructor(
    private readonly redis: RedisGateRedis,
    private readonly options: { limit: number; leaseMs?: number; prefix?: string; ownerId?: string; now?: () => number },
  ) {}

  async tryAcquire(tenantId: string) {
    const now = (this.options.now ?? Date.now)()
    const leaseMs = this.options.leaseMs ?? 15 * 60_000
    const key = `${this.options.prefix ?? TENANT_SLOT_PREFIX}:${tenantId}`
    // 成员名必须全局唯一：同一进程里的多个实例、同一毫秒的多次申请都不能互相覆盖。
    const member = `${this.options.ownerId ?? 'w'}:${process.pid}:${randomUUID()}`
    const granted = Number(await this.redis.eval(ACQUIRE_SCRIPT, 1, key, now, this.options.limit, now + leaseMs, member, leaseMs * 2))
    if (granted !== 1) return null
    let released = false
    return async () => {
      if (released) return
      released = true
      await this.redis.zrem(key, member)
    }
  }
}
