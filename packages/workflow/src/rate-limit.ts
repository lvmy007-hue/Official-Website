// 店铺级令牌桶限速（12.3）：同一个店铺授权调用亚马逊的速率由一个桶统一约束，
// 桶的速率按亚马逊响应头 x-amzn-RateLimit-Limit 动态调整；收到 429 立刻降速并冻结一小段时间。
// Memory 版本用于单元测试与单进程；Redis 版本用 Lua 保证多个 worker 进程共享同一个桶且原子。

import { RetryableError } from './errors'

export interface RateLimiter {
  /** 申请 cost 个令牌：返回 0 表示已批准，否则返回需要等待的毫秒数（本次不扣令牌，等待后再次申请）。 */
  acquire(key: string, cost?: number): Promise<number>
  /** 汇报亚马逊的响应：用响应头里的速率修正桶；429 则降速并冻结。 */
  report(key: string, signal: RateSignal): Promise<void>
}

export interface RateSignal {
  status?: number
  /** x-amzn-RateLimit-Limit：亚马逊允许的每秒请求数。 */
  limitPerSecond?: number
  retryAfterMs?: number
}

export interface BucketDefaults {
  ratePerSecond: number
  burst: number
  /** 速率下限：被降速后不会低于它，避免任务永久饿死。 */
  minRatePerSecond: number
  /** 速率上限：即使亚马逊允许更高，也不超过我们自己的保护值。 */
  maxRatePerSecond: number
}

export const DEFAULT_BUCKET: BucketDefaults = { ratePerSecond: 1, burst: 2, minRatePerSecond: 0.05, maxRatePerSecond: 20 }

/** 从响应头里读取限速信号，大小写不敏感；同时支持 Headers 对象与普通对象。 */
export function rateSignalFromResponse(status: number | undefined, headers: unknown): RateSignal {
  const read = (name: string): string | undefined => {
    const h = headers as any
    if (!h) return undefined
    if (typeof h.get === 'function') return h.get(name) ?? undefined
    const hit = Object.keys(h).find(key => key.toLowerCase() === name)
    return hit ? String(h[hit]) : undefined
  }
  const limit = Number(read('x-amzn-ratelimit-limit'))
  const retryAfter = Number(read('retry-after'))
  return {
    status,
    limitPerSecond: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.round(retryAfter * 1000) : undefined,
  }
}

export interface BucketState {
  tokens: number
  updatedAt: number
  rate: number
  burst: number
  blockedUntil: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 按信号计算新的速率与突发量：遵守亚马逊给的速率；429 时降速一半并冻结。 */
export function adjustBucket(state: BucketState, signal: RateSignal, defaults: BucketDefaults, now: number): BucketState {
  let { rate, burst, blockedUntil, tokens } = state
  if (signal.limitPerSecond) {
    rate = clamp(signal.limitPerSecond, defaults.minRatePerSecond, defaults.maxRatePerSecond)
    burst = Math.max(1, Math.ceil(rate))
    tokens = Math.min(tokens, burst)
  }
  if (signal.status === 429) {
    rate = clamp(rate / 2, defaults.minRatePerSecond, defaults.maxRatePerSecond)
    tokens = 0
    blockedUntil = Math.max(blockedUntil, now + (signal.retryAfterMs ?? Math.ceil(1000 / rate)))
  }
  return { tokens, updatedAt: now, rate, burst, blockedUntil }
}

export function takeFromBucket(state: BucketState, cost: number, now: number): { state: BucketState; waitMs: number } {
  let { tokens, updatedAt } = state
  if (now > updatedAt) {
    tokens = Math.min(state.burst, tokens + ((now - updatedAt) / 1000) * state.rate)
    updatedAt = now
  }
  if (state.blockedUntil > now) return { state: { ...state, tokens, updatedAt }, waitMs: state.blockedUntil - now }
  if (tokens >= cost) return { state: { ...state, tokens: tokens - cost, updatedAt }, waitMs: 0 }
  return { state: { ...state, tokens, updatedAt }, waitMs: Math.ceil(((cost - tokens) / state.rate) * 1000) }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, BucketState>()
  constructor(
    private readonly defaults: BucketDefaults = DEFAULT_BUCKET,
    private readonly now: () => number = Date.now,
  ) {}

  private bucket(key: string): BucketState {
    return this.buckets.get(key) ?? { tokens: this.defaults.burst, updatedAt: this.now(), rate: this.defaults.ratePerSecond, burst: this.defaults.burst, blockedUntil: 0 }
  }

  async acquire(key: string, cost = 1): Promise<number> {
    const { state, waitMs } = takeFromBucket(this.bucket(key), cost, this.now())
    this.buckets.set(key, state)
    return waitMs
  }

  async report(key: string, signal: RateSignal): Promise<void> {
    this.buckets.set(key, adjustBucket(this.bucket(key), signal, this.defaults, this.now()))
  }

  snapshot(key: string): BucketState {
    return this.bucket(key)
  }
}

/** 阻塞直到拿到令牌：循环申请并按返回的等待时间睡眠，等待总时长超过 maxWaitMs 时抛出，让上层按可重试错误延后。 */
export async function waitForToken(limiter: RateLimiter, key: string, options: { cost?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const maxWaitMs = options.maxWaitMs ?? 60_000
  let waited = 0
  for (;;) {
    const wait = await limiter.acquire(key, options.cost ?? 1)
    if (wait <= 0) return
    if (waited + wait > maxWaitMs) throw new RateLimitWaitExceeded(key, waited + wait)
    await sleep(wait)
    waited += wait
  }
}

/** 限速桶等待过久：可重试，并把需要等待的时间作为最短重试间隔。 */
export class RateLimitWaitExceeded extends RetryableError {
  constructor(key: string, waitMs: number) {
    super('RATE_LIMIT_WAIT_EXCEEDED', `店铺限速桶 ${key} 需要等待 ${waitMs} 毫秒，超过上限，稍后重试`, waitMs)
  }
}

// ---- Redis 版本（多进程共享） ----

/** 只依赖 ioredis 的 eval/hset/pexpire 子集，包内不引入 ioredis。 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
  hset(key: string, ...fieldsAndValues: Array<string | number>): Promise<unknown>
  pexpire(key: string, ms: number): Promise<unknown>
}

const TAKE_SCRIPT = `
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts', 'rate', 'burst', 'blocked')
local now = tonumber(ARGV[1]); local cost = tonumber(ARGV[2])
local rate = tonumber(d[3]) or tonumber(ARGV[3]); local burst = tonumber(d[4]) or tonumber(ARGV[4])
local tokens = tonumber(d[1]); local ts = tonumber(d[2]); local blocked = tonumber(d[5]) or 0
if tokens == nil then tokens = burst; ts = now end
if now > ts then tokens = math.min(burst, tokens + (now - ts) / 1000 * rate); ts = now end
local wait = 0
if blocked > now then wait = blocked - now
elseif tokens >= cost then tokens = tokens - cost
else wait = math.ceil((cost - tokens) / rate * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(ts), 'rate', tostring(rate), 'burst', tostring(burst))
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return wait
`

/** 令牌桶在 Redis 里的键前缀：键是 `ratelimit:<租户>:<连接>:<接口族>`，接口服务的同步中心按租户前缀读取。 */
export const RATE_BUCKET_PREFIX = 'ratelimit'

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly options: { prefix?: string; defaults?: BucketDefaults; ttlMs?: number; now?: () => number } = {},
  ) {}

  private get defaults() {
    return this.options.defaults ?? DEFAULT_BUCKET
  }
  private now() {
    return (this.options.now ?? Date.now)()
  }
  private redisKey(key: string) {
    return `${this.options.prefix ?? RATE_BUCKET_PREFIX}:${key}`
  }

  async acquire(key: string, cost = 1): Promise<number> {
    const result = await this.redis.eval(TAKE_SCRIPT, 1, this.redisKey(key), this.now(), cost, this.defaults.ratePerSecond, this.defaults.burst, this.options.ttlMs ?? 3_600_000)
    return Number(result)
  }

  async report(key: string, signal: RateSignal): Promise<void> {
    const redisKey = this.redisKey(key)
    const now = this.now()
    const [tokens, ts, rate, burst, blocked] = await this.redis.hmget(redisKey, 'tokens', 'ts', 'rate', 'burst', 'blocked')
    const current: BucketState = {
      tokens: tokens === null ? this.defaults.burst : Number(tokens),
      updatedAt: ts === null ? now : Number(ts),
      rate: rate === null ? this.defaults.ratePerSecond : Number(rate),
      burst: burst === null ? this.defaults.burst : Number(burst),
      blockedUntil: blocked === null ? 0 : Number(blocked),
    }
    const next = adjustBucket(current, signal, this.defaults, now)
    // 429 时多记一笔“最近一次限速”的时间，同步中心的限速状态页显示它（桶一小时没人用就过期，这个时间随之消失）
    await this.redis.hset(
      redisKey,
      'tokens',
      String(next.tokens),
      'ts',
      String(next.updatedAt),
      'rate',
      String(next.rate),
      'burst',
      String(next.burst),
      'blocked',
      String(next.blockedUntil),
      ...(signal.status === 429 ? ['limitedAt', String(now)] : []),
    )
    await this.redis.pexpire(redisKey, this.options.ttlMs ?? 3_600_000)
  }
}
