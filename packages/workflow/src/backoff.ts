// 指数退避 + 随机抖动：避免一批任务同一时刻一起重试把亚马逊再次打满。

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  factor?: number
  /** 抖动比例，0 表示不抖动；0.5 表示延迟落在 [50%, 100%] 之间。 */
  jitter?: number
  rng?: () => number
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'rng'>> = { baseMs: 5_000, maxMs: 15 * 60_000, factor: 2, jitter: 0.5 }

/** attempt 从 1 开始：第 1 次失败后的等待时长。retryAfterMs 为亚马逊要求的最短等待，取两者较大值。 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}, retryAfterMs?: number): number {
  const { baseMs, maxMs, factor, jitter } = { ...DEFAULT_BACKOFF, ...options }
  const rng = options.rng ?? Math.random
  const exp = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1))
  const delay = Math.round(exp * (1 - jitter) + rng() * exp * jitter)
  return Math.max(delay, retryAfterMs ?? 0)
}
