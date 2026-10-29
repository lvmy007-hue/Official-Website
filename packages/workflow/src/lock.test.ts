import { describe, expect, it } from 'vitest'
import { DistributedLockManager, LockLostError, MemoryLockStore, syncLockKey } from './index'

function setup() {
  let now = new Date('2026-10-21T00:00:00Z')
  const store = new MemoryLockStore()
  const lost: string[] = []
  const manager = new DistributedLockManager(store, { leaseMs: 60_000, renewEveryMs: 3_600_000, now: () => now, onLost: key => lost.push(key) })
  return {
    store,
    manager,
    lost,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

describe('带租约的分布式锁', () => {
  it('同一时刻只有一个持有者', async () => {
    const { manager } = setup()
    const first = await manager.tryAcquire('t1', 'k', 'w1')
    expect(first?.fence).toBe(1)
    expect(await manager.tryAcquire('t1', 'k', 'w2')).toBeNull()
    expect(await manager.tryAcquire('t2', 'k', 'w2')).not.toBeNull() // 不同租户互不影响
    await first!.release()
  })

  it('租约到期后别人可接管，围栏令牌递增，旧持有者随后被判定丢锁', async () => {
    const { manager, advance, lost } = setup()
    const old = await manager.tryAcquire('t1', 'k', 'w1')
    advance(61_000)
    const next = await manager.tryAcquire('t1', 'k', 'w2')
    expect(next?.fence).toBe(2)
    expect(await old!.renewNow()).toBe(false)
    expect(old!.isLost).toBe(true)
    expect(lost).toEqual(['k'])
    expect(() => old!.assertHeld()).toThrow(LockLostError)
    await old!.release() // 已丢锁的释放不得误删接管者
    expect(await manager.tryAcquire('t1', 'k', 'w3')).toBeNull()
  })

  it('续约延长租约，续约后不会被接管', async () => {
    const { manager, advance } = setup()
    const lease = await manager.tryAcquire('t1', 'k', 'w1')
    advance(50_000)
    expect(await lease!.renewNow()).toBe(true)
    advance(50_000)
    expect(await manager.tryAcquire('t1', 'k', 'w2')).toBeNull()
  })

  it('持锁执行：抢不到返回未获取；执行完（含失败）都释放', async () => {
    const { manager } = setup()
    const held = await manager.tryAcquire('t1', 'k', 'w1')
    expect(await manager.withLock('t1', 'k', 'w2', async () => 1)).toEqual({ acquired: false })
    await held!.release()
    expect(await manager.withLock('t1', 'k', 'w2', async () => 7)).toEqual({ acquired: true, value: 7 })
    await expect(
      manager.withLock('t1', 'k', 'w3', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await manager.tryAcquire('t1', 'k', 'w4')).not.toBeNull()
  })

  it('同步任务锁键由店铺授权与数据域组成', () => {
    expect(syncLockKey('conn1', 'orders')).toBe('sync:conn1:orders')
  })
})
