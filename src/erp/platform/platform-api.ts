import { ApiError } from '../../api'

// 平台运营后台的请求层（P1-19）：与企业工作区完全分开——独立令牌、独立会话，不共用刷新凭据。
// 平台令牌只放在内存里：刷新页面或超过有效期后需要重新登录（密码 + 动态验证码），不落盘、不写 Cookie。

const base = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
let platformToken: string | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let onExpired: (() => void) | null = null

export const hasPlatformToken = () => Boolean(platformToken)

export function setPlatformToken(token: string | null, expiresInSeconds?: number) {
  platformToken = token
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = null
  // 到期前不会主动续期，到期时回到登录页，避免操作到一半才发现失效
  if (token && expiresInSeconds) {
    expiryTimer = setTimeout(() => {
      platformToken = null
      onExpired?.()
    }, expiresInSeconds * 1000)
  }
}

/** 登录失效（令牌到期或被服务端拒绝）时的回调：由路由层设置为“回到平台登录页”。 */
export const setPlatformExpiredHandler = (handler: (() => void) | null) => {
  onExpired = handler
}

type Envelope<T> = { data?: T; error?: { code?: string; message?: string; requestId?: string; retryable?: boolean; fieldErrors?: Record<string, string[]> } }

export async function platformFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const authenticated = !path.startsWith('/platform/auth/login') && !path.startsWith('/platform/auth/mfa/verify')
  if (authenticated && !platformToken) throw new ApiError(401, 'PLATFORM_AUTH_REQUIRED', '需要平台账号登录')
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  if (authenticated && platformToken) headers.set('Authorization', `Bearer ${platformToken}`)
  const response = await fetch(`${base}${path}`, { ...init, headers, credentials: 'omit' })
  const payload = response.headers.get('content-type')?.includes('application/json') ? ((await response.json().catch(() => null)) as Envelope<T> | null) : null
  if (response.status === 401 && authenticated) {
    platformToken = null
    onExpired?.()
  }
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.code, payload?.error?.message ?? `服务端请求失败（${response.status}）`, undefined, {
      requestId: payload?.error?.requestId,
      retryable: payload?.error?.retryable,
      fieldErrors: payload?.error?.fieldErrors,
    })
  }
  if (!payload) throw new Error('接口返回了非 JSON 内容，请检查服务端地址')
  return payload.data as T
}

export const platformPost = <T>(path: string, body?: unknown) => platformFetch<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export const platformPut = <T>(path: string, body: unknown) => platformFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) })
