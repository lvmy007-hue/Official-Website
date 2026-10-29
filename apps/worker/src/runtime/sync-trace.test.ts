import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { recordSyncEvent, resultJsonOf, timelineOf } from './sync-trace'

// 同步任务过程记录（P5-06）：追加事件、数字统计、记录失败不影响同步任务。

const stub = (timelineJson: unknown, row = true) => ({
  syncJob: {
    findUnique: vi.fn().mockResolvedValue(row ? { timelineJson } : null),
    update: vi.fn().mockResolvedValue({}),
  },
})

describe('recordSyncEvent', () => {
  it('在已有时间线后面追加一条，写回同一任务', async () => {
    const prisma = stub([{ at: '2026-10-25T00:00:00.000Z', stage: 'STARTED', text: '第 1 次尝试' }])
    await recordSyncEvent(prisma as never, 'job-1', 'FAILED', 'AUTH_EXPIRED', new Date('2026-10-25T00:01:00.000Z'))
    expect(prisma.syncJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        timelineJson: [
          { at: '2026-10-25T00:00:00.000Z', stage: 'STARTED', text: '第 1 次尝试' },
          { at: '2026-10-25T00:01:00.000Z', stage: 'FAILED', text: 'AUTH_EXPIRED' },
        ],
      },
    })
  })

  it('任务不存在时什么也不写；读写出错时不抛错', async () => {
    const missing = stub(null, false)
    await recordSyncEvent(missing as never, 'job-x', 'FAILED')
    expect(missing.syncJob.update).not.toHaveBeenCalled()
    const broken = { syncJob: { findUnique: vi.fn().mockRejectedValue(new Error('连接中断')), update: vi.fn() } }
    await expect(recordSyncEvent(broken as never, 'job-1', 'FAILED')).resolves.toBeUndefined()
    await expect(recordSyncEvent({} as never, 'job-1', 'FAILED')).resolves.toBeUndefined()
  })
})

describe('timelineOf 与 resultJsonOf', () => {
  it('相同阶段与文字连续出现只记一次', () => {
    const first = timelineOf(null, 'POLL_WAIT', undefined, new Date('2026-10-25T00:00:00.000Z'))
    const again = timelineOf(first, 'POLL_WAIT', undefined, new Date('2026-10-25T00:00:30.000Z'))
    expect(again).toHaveLength(1)
  })

  it('统计只留数字；没有数字写 DbNull，不写空对象', () => {
    expect(resultJsonOf({ imported: 12, markets: ['US'], note: 'x' })).toEqual({ imported: 12 })
    expect(resultJsonOf({ ready: true })).toBe(Prisma.DbNull)
    expect(resultJsonOf(undefined)).toBe(Prisma.DbNull)
  })
})
