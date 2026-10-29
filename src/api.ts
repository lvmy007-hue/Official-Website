const mode = import.meta.env.VITE_API_MODE ?? 'server'
const base = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
// 访问令牌只放在内存里（12.9 第 5 条）：页面刷新后令牌丢失，下一次请求得到 401，随即用 Cookie 里的刷新凭据静默换取新令牌。
let accessToken: string | null = null
// 清除旧版本留在浏览器里的令牌
try {
  localStorage.removeItem('nova_access_token')
} catch {
  /* 浏览器禁用存储时忽略 */
}
// 限时支持访问（P1-19）：平台页领取会话令牌后写入 sessionStorage 并打开新标签页；这里启动时读取一次并立即清除。
// 支持会话只读、15 分钟有效，不用 Cookie 刷新（否则会混入同一浏览器里的个人登录身份），到期后重新从平台页领取。
export const SUPPORT_HANDOVER_KEY = 'nova_support_handover'
let supportSession = false
try {
  const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SUPPORT_HANDOVER_KEY)
  if (raw) {
    sessionStorage.removeItem(SUPPORT_HANDOVER_KEY)
    const handover = JSON.parse(raw) as { token?: string; expiresAt?: string }
    if (handover.token && handover.expiresAt && new Date(handover.expiresAt).getTime() > Date.now()) {
      accessToken = handover.token
      supportSession = true
    }
  }
} catch {
  /* 读取失败按普通登录处理 */
}
export const isSupportSession = () => supportSession
export const isServerMode = mode === 'server'
export const hasAccessToken = () => Boolean(accessToken)
export const setAccessToken = (token: string | null) => {
  accessToken = token
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function requestRefresh(attempt = 0): Promise<void> {
  const response = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include' })
  // 另一个标签页刚刚完成了刷新：浏览器里的刷新凭据已经是新的，稍等后重试一次
  if (response.status === 409 && attempt < 1) {
    await wait(300)
    return requestRefresh(attempt + 1)
  }
  if (!response.ok) throw new Error('登录已失效')
  const payload = (await response.json()) as { data?: { accessToken?: string } }
  if (!payload.data?.accessToken) throw new Error('刷新登录会话失败')
  setAccessToken(payload.data.accessToken)
}
// 同一时刻只发一个刷新请求：多个请求同时遇到 401 时共用结果，避免用同一个旧凭据并发刷新而触发重用告警
let refreshing: Promise<void> | null = null
function refreshAccessToken() {
  if (!refreshing)
    refreshing = requestRefresh().finally(() => {
      refreshing = null
    })
  return refreshing
}
// 服务端返回的业务错误：带状态码与统一错误码，页面据此给出对应提示（例如 409 CONFLICT 提示刷新或合并）
// 服务端错误体里的排障信息：请求编号、是否可重试、字段级错误
export type ApiErrorExtra = { requestId?: string; retryable?: boolean; fieldErrors?: Record<string, string[]> }
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly details?: Record<string, string | number | boolean | null>,
    public readonly extra: ApiErrorExtra = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
// 接口耗时观察（P1-09 性能埋点）：只回传“路径与耗时”，不含请求内容；一次调用（含登录过期后的自动重试）只计一次。
let timingListener: ((path: string, durationMs: number) => void) | null = null
export const setApiTimingListener = (listener: ((path: string, durationMs: number) => void) | null) => {
  timingListener = listener
}
export async function apiFetch<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  if (retried || !timingListener) return apiFetchCore<T>(path, init, retried)
  const startedAt = performance.now()
  try {
    return await apiFetchCore<T>(path, init, retried)
  } finally {
    timingListener?.(path, performance.now() - startedAt)
  }
}
async function apiFetchCore<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  // 写操作自动带幂等键：同一次操作（含登录过期后的自动重试）共用一个键，重复点击或网络重发不会重复执行
  const writes = !['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())
  if (writes && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID())
    init = { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'Idempotency-Key': headers.get('Idempotency-Key') as string } }
  }
  // 审计中心按“所属页面”筛选：写操作带上当前页面路径（服务端只认 /app 开头的站内路径，并去掉参数、归一编号）。该头由浏览器自己声明，只用于标注
  const pathname = typeof window === 'undefined' ? undefined : window.location?.pathname
  if (writes && typeof pathname === 'string' && pathname.startsWith('/app')) headers.set('X-Nova-Page', pathname)
  const response = await fetch(`${base}${path}`, { ...init, headers, credentials: 'include' })
  if (response.status === 401 && !retried && !supportSession && path !== '/auth/login' && path !== '/auth/refresh') {
    try {
      await refreshAccessToken()
      return apiFetch<T>(path, init, true)
    } catch {
      setAccessToken(null)
    }
  }
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? ((await response.json().catch(() => null)) as {
        data?: T
        error?: { code?: string; message?: string; requestId?: string; retryable?: boolean; fieldErrors?: Record<string, string[]>; details?: Record<string, string | number | boolean | null> }
      } | null)
    : null
  // 管理员尚未启用多因素认证：除认证接口外服务端一律拒绝，带去个人账号页完成绑定
  if (response.status === 403 && payload?.error?.code === 'MFA_ENROLLMENT_REQUIRED' && !window.location.pathname.startsWith('/app/profile')) window.location.assign('/app/profile?mfa=required')
  if (!response.ok)
    throw new ApiError(
      response.status,
      payload?.error?.code,
      payload?.error?.message ?? (response.status === 500 ? 'ERP 服务端未启动或 API 代理无法连接，请先启动 API 服务' : `服务端请求失败（${response.status}）`),
      payload?.error?.details,
      { requestId: payload?.error?.requestId, retryable: payload?.error?.retryable, fieldErrors: payload?.error?.fieldErrors },
    )
  if (!payload) throw new Error('ERP API 返回了非 JSON 内容，请检查前端 API 代理或服务端地址')
  return payload.data as T
}
export async function login(email: string, password: string) {
  const result = await apiFetch<{ accessToken: string; user: { displayName: string; email: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  setAccessToken(result.accessToken)
  return result.user
}
// 退出登录：先通知服务端作废当前会话与刷新凭据（失败也要退出本地登录态）
export async function logout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' })
  } catch {
    /* 会话可能已失效，继续退出 */
  }
  setAccessToken(null)
  window.location.assign('/login')
}
