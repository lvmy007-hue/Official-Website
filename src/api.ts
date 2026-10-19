const mode = import.meta.env.VITE_API_MODE ?? 'server'
const base = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
let accessToken = localStorage.getItem('nova_access_token')
export const isServerMode = mode === 'server'
export const hasAccessToken = () => Boolean(accessToken)
export const setAccessToken = (token: string | null) => { accessToken = token; token ? localStorage.setItem('nova_access_token', token) : localStorage.removeItem('nova_access_token') }
async function refreshAccessToken() {
  const response = await fetch(`${base}/auth/refresh`, { method: 'POST', credentials: 'include' })
  if (!response.ok) throw new Error('登录已失效')
  const payload = await response.json() as { data?: { accessToken?: string } }
  if (!payload.data?.accessToken) throw new Error('刷新登录会话失败')
  setAccessToken(payload.data.accessToken)
}
export async function apiFetch<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers); headers.set('Content-Type', 'application/json'); if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(`${base}${path}`, { ...init, headers, credentials: 'include' })
  if (response.status === 401 && !retried && path !== '/auth/login' && path !== '/auth/refresh') {
    try { await refreshAccessToken(); return apiFetch<T>(path, init, true) } catch { setAccessToken(null) }
  }
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null : null
  if (!response.ok) throw new Error(payload?.error?.message ?? (response.status === 500 ? 'ERP 服务端未启动或 API 代理无法连接，请先启动 API 服务' : `服务端请求失败（${response.status}）`))
  if (!payload) throw new Error('ERP API 返回了非 JSON 内容，请检查前端 API 代理或服务端地址')
  return payload.data as T
}
export async function login(email: string, password: string) { const result = await apiFetch<{ accessToken: string; user: { displayName: string; email: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); setAccessToken(result.accessToken); return result.user }
export function logout() { setAccessToken(null); window.location.assign('/login') }
