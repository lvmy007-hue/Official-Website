import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { POLL_INTERVAL_MS, POLL_MAX_MS, useBoundedPolling } from './aplus-polling'

// 有限轮询（P4-14）：5 秒一次、最多 2 分钟；写入结束、页面卸载立即停；手动刷新重新计时。

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

describe('useBoundedPolling', () => {
  it('不在处理中时不轮询', () => {
    const tick = vi.fn()
    renderHook(() => useBoundedPolling(false, tick))
    advance(POLL_MAX_MS)
    expect(tick).not.toHaveBeenCalled()
  })

  it('处理中每 5 秒刷新一次，满 2 分钟停止并标记已过期', () => {
    const tick = vi.fn()
    const { result } = renderHook(() => useBoundedPolling(true, tick))
    advance(POLL_INTERVAL_MS - 1)
    expect(tick).not.toHaveBeenCalled()
    advance(1)
    expect(tick).toHaveBeenCalledTimes(1)
    advance(POLL_MAX_MS)
    expect(result.current.expired).toBe(true)
    const calls = tick.mock.calls.length
    expect(calls).toBe(POLL_MAX_MS / POLL_INTERVAL_MS - 1)
    advance(POLL_MAX_MS)
    expect(tick).toHaveBeenCalledTimes(calls)
  })

  it('写入结束（active 变 false）立即停止', () => {
    const tick = vi.fn()
    const { rerender } = renderHook(({ active }) => useBoundedPolling(active, tick), { initialProps: { active: true } })
    advance(POLL_INTERVAL_MS * 2)
    expect(tick).toHaveBeenCalledTimes(2)
    rerender({ active: false })
    advance(POLL_MAX_MS)
    expect(tick).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('页面卸载后不再有定时器，也不再调用', () => {
    const tick = vi.fn()
    const { unmount } = renderHook(() => useBoundedPolling(true, tick))
    advance(POLL_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    advance(POLL_MAX_MS)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('过期后手动刷新（restart）重新开始计时', () => {
    const tick = vi.fn()
    const { result } = renderHook(() => useBoundedPolling(true, tick))
    advance(POLL_MAX_MS)
    expect(result.current.expired).toBe(true)
    const before = tick.mock.calls.length
    act(() => result.current.restart())
    expect(result.current.expired).toBe(false)
    advance(POLL_INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(before + 1)
  })
})
