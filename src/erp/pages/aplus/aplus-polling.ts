import { useEffect, useRef, useState } from 'react'

// 有写入在处理时的有限轮询（P4-14）：每 5 秒刷新一次，最多 2 分钟；页面卸载或写入结束（active 变 false）立即停。
// 手动点“刷新”后调用 restart，重新开始计时。用 setTimeout 自己写，清理逻辑见 aplus-polling.test.ts。

export const POLL_INTERVAL_MS = 5000
export const POLL_MAX_MS = 120_000

export function useBoundedPolling(active: boolean, tick: () => void, options: { intervalMs?: number; maxMs?: number } = {}) {
  const { intervalMs = POLL_INTERVAL_MS, maxMs = POLL_MAX_MS } = options
  const latest = useRef(tick)
  latest.current = tick
  const [round, setRound] = useState(0)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    setExpired(false)
    if (!active) return undefined
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      timer = setTimeout(() => {
        if (Date.now() - startedAt >= maxMs) {
          setExpired(true)
          return
        }
        latest.current()
        schedule()
      }, intervalMs)
    }
    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active, intervalMs, maxMs, round])

  return { expired, restart: () => setRound(value => value + 1) }
}
