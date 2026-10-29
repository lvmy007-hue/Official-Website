// 带租约的分布式锁（12.3）：同一个店铺同一个数据域同一时刻只允许一个进程在拉取，防止重复拉取与重复写入。
// 租约：持有者必须持续续约；进程崩溃后租约到期，别的进程可接管，并拿到更大的 fence（围栏令牌）。
// 丢锁检测：续约失败即视为丢锁，之后 assertHeld() 抛 LockLostError，处理循环必须立刻停止写入。

import { LockLostError } from './errors'

export interface LockStore {
  /** 抢锁：成功返回围栏令牌；锁被他人持有且未过期返回 null。同一 owner 重复抢锁视为续约。 */
  acquire(tenantId: string, lockKey: string, owner: string, leaseMs: number, now: Date): Promise<number | null>
  /** 续约：owner 与 fence 都匹配才成功。 */
  renew(tenantId: string, lockKey: string, owner: string, fence: number, leaseMs: number, now: Date): Promise<boolean>
  /** 释放：owner 与 fence 都匹配才删除，避免误删接管者的锁。 */
  release(tenantId: string, lockKey: string, owner: string, fence: number): Promise<void>
}

export class MemoryLockStore implements LockStore {
  private readonly rows = new Map<string, { owner: string; fence: number; leaseUntil: number }>()
  private k(tenantId: string, lockKey: string) {
    return `${tenantId}\u0000${lockKey}`
  }

  async acquire(tenantId: string, lockKey: string, owner: string, leaseMs: number, now: Date) {
    const key = this.k(tenantId, lockKey)
    const row = this.rows.get(key)
    const leaseUntil = now.getTime() + leaseMs
    if (!row) {
      this.rows.set(key, { owner, fence: 1, leaseUntil })
      return 1
    }
    if (row.owner === owner) {
      row.leaseUntil = leaseUntil
      return row.fence
    }
    if (row.leaseUntil < now.getTime()) {
      this.rows.set(key, { owner, fence: row.fence + 1, leaseUntil })
      return row.fence + 1
    }
    return null
  }

  async renew(tenantId: string, lockKey: string, owner: string, fence: number, leaseMs: number, now: Date) {
    const row = this.rows.get(this.k(tenantId, lockKey))
    if (!row || row.owner !== owner || row.fence !== fence) return false
    row.leaseUntil = now.getTime() + leaseMs
    return true
  }

  async release(tenantId: string, lockKey: string, owner: string, fence: number) {
    const key = this.k(tenantId, lockKey)
    const row = this.rows.get(key)
    if (row && row.owner === owner && row.fence === fence) this.rows.delete(key)
  }
}

export interface LockOptions {
  leaseMs?: number
  /** 续约间隔，默认租约的三分之一。 */
  renewEveryMs?: number
  now?: () => Date
  onLost?: (lockKey: string) => void
}

/** 已持有的锁：自动续约；续约失败或到期未续上即标记丢失。 */
export class LockLease {
  private lost = false
  private timer: ReturnType<typeof setInterval> | null = null
  private released = false

  constructor(
    private readonly store: LockStore,
    readonly tenantId: string,
    readonly lockKey: string,
    readonly owner: string,
    readonly fence: number,
    private readonly options: Required<Pick<LockOptions, 'leaseMs' | 'renewEveryMs' | 'now'>> & Pick<LockOptions, 'onLost'>,
  ) {
    this.timer = setInterval(() => {
      void this.renewNow()
    }, options.renewEveryMs)
    this.timer.unref?.()
  }

  get isLost() {
    return this.lost
  }

  /** 立即续约一次（定时器也调用它）。失败则标记丢锁并停止续约。 */
  async renewNow(): Promise<boolean> {
    if (this.lost || this.released) return !this.lost
    let ok: boolean
    try {
      ok = await this.store.renew(this.tenantId, this.lockKey, this.owner, this.fence, this.options.leaseMs, this.options.now())
    } catch {
      ok = false
    }
    if (!ok) this.markLost()
    return ok
  }

  private markLost() {
    if (this.lost) return
    this.lost = true
    this.stopTimer()
    this.options.onLost?.(this.lockKey)
  }

  private stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 在每个写入步骤之前调用：丢锁就抛错，调用方停止处理。 */
  assertHeld() {
    if (this.lost) throw new LockLostError(this.lockKey)
  }

  async release() {
    if (this.released) return
    this.released = true
    this.stopTimer()
    if (!this.lost) await this.store.release(this.tenantId, this.lockKey, this.owner, this.fence)
  }
}

export class DistributedLockManager {
  constructor(
    private readonly store: LockStore,
    private readonly defaults: LockOptions = {},
  ) {}

  /** 抢不到返回 null（调用方应把任务延后，而不是失败）。 */
  async tryAcquire(tenantId: string, lockKey: string, owner: string, options: LockOptions = {}): Promise<LockLease | null> {
    const merged = { ...this.defaults, ...options }
    const leaseMs = merged.leaseMs ?? 60_000
    const now = merged.now ?? (() => new Date())
    const fence = await this.store.acquire(tenantId, lockKey, owner, leaseMs, now())
    if (fence === null) return null
    return new LockLease(this.store, tenantId, lockKey, owner, fence, { leaseMs, renewEveryMs: merged.renewEveryMs ?? Math.max(1, Math.floor(leaseMs / 3)), now, onLost: merged.onLost })
  }

  /** 持锁执行：执行完无论成败都释放；抢不到锁返回 { acquired: false }。 */
  async withLock<T>(tenantId: string, lockKey: string, owner: string, fn: (lease: LockLease) => Promise<T>, options: LockOptions = {}): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const lease = await this.tryAcquire(tenantId, lockKey, owner, options)
    if (!lease) return { acquired: false }
    try {
      return { acquired: true, value: await fn(lease) }
    } finally {
      await lease.release()
    }
  }
}

/** 同步任务的锁键：店铺授权 + 数据域。 */
export const syncLockKey = (connectionId: string, domain: string) => `sync:${connectionId}:${domain}`
