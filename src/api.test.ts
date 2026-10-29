import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 请求层的登录态处理（P1-17）：令牌只在内存、过期后静默刷新且同一时刻只刷新一次、刷新冲突重试一次、退出时通知服务端。
type Call = { url: string; init: RequestInit }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('请求层登录态', () => {
  let calls: Call[]
  let responder: (call: Call) => Response | Promise<Response>
  const assign = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    calls = []
    assign.mockClear()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const call = { url, init }
        calls.push(call)
        return responder(call)
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const load = () => import('./api')

  it('访问令牌只在内存里：不读写浏览器存储，并清除旧版本留下的令牌', async () => {
    const removed: string[] = []
    const store = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn((key: string) => {
        removed.push(key)
      }),
    }
    vi.stubGlobal('localStorage', store)
    responder = () => json(200, { data: { accessToken: 'token-1', user: { displayName: 'A', email: 'a@example.com' } } })
    const api = await load()
    expect(removed).toContain('nova_access_token')
    await api.login('a@example.com', 'password')
    expect(api.hasAccessToken()).toBe(true)
    expect(store.setItem).not.toHaveBeenCalled()
    expect(store.getItem).not.toHaveBeenCalled()
  })

  it('请求带上访问令牌；令牌过期（401）后用 Cookie 静默刷新并重试原请求', async () => {
    const api = await load()
    api.setAccessToken('old-token')
    responder = ({ url, init }) => {
      if (url.endsWith('/auth/refresh')) return json(201, { data: { accessToken: 'new-token' } })
      const auth = new Headers(init.headers).get('Authorization')
      return auth === 'Bearer new-token' ? json(200, { data: { ok: true } }) : json(401, { error: { code: 'AUTH_REQUIRED', message: '登录已失效' } })
    }
    expect(await api.apiFetch('/things')).toEqual({ ok: true })
    expect(calls.map(call => call.url)).toEqual(['/api/v1/things', '/api/v1/auth/refresh', '/api/v1/things'])
    expect(calls[1].init.credentials).toBe('include')
  })

  it('多个请求同时遇到 401：只发一次刷新，共用结果', async () => {
    const api = await load()
    api.setAccessToken('old-token')
    responder = ({ url, init }) => {
      if (url.endsWith('/auth/refresh')) return new Promise<Response>(resolve => setTimeout(() => resolve(json(201, { data: { accessToken: 'new-token' } })), 20))
      return new Headers(init.headers).get('Authorization') === 'Bearer new-token' ? json(200, { data: { ok: true } }) : json(401, { error: { code: 'AUTH_REQUIRED', message: 'x' } })
    }
    await Promise.all([api.apiFetch('/a'), api.apiFetch('/b'), api.apiFetch('/c')])
    expect(calls.filter(call => call.url.endsWith('/auth/refresh')).length).toBe(1)
  })

  it('刷新遇到并发冲突（409）：稍等后用更新后的凭据重试一次', async () => {
    const api = await load()
    api.setAccessToken('old-token')
    let refreshCalls = 0
    responder = ({ url, init }) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1
        return refreshCalls === 1 ? json(409, { error: { code: 'REFRESH_CONFLICT', message: 'x' } }) : json(201, { data: { accessToken: 'new-token' } })
      }
      return new Headers(init.headers).get('Authorization') === 'Bearer new-token' ? json(200, { data: { ok: true } }) : json(401, { error: { code: 'AUTH_REQUIRED', message: 'x' } })
    }
    expect(await api.apiFetch('/things')).toEqual({ ok: true })
    expect(refreshCalls).toBe(2)
  })

  it('刷新失败（登录已失效）：清掉令牌，抛出带状态码与错误码的错误，不会反复刷新', async () => {
    const api = await load()
    api.setAccessToken('old-token')
    responder = ({ url }) =>
      url.endsWith('/auth/refresh')
        ? json(401, { error: { code: 'AUTH_REQUIRED', message: '登录已失效，请重新登录' } })
        : json(401, { error: { code: 'AUTH_REQUIRED', message: '登录已失效，请重新登录' } })
    await expect(api.apiFetch('/things')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
    expect(api.hasAccessToken()).toBe(false)
    expect(calls.filter(call => call.url.endsWith('/auth/refresh')).length).toBe(1)
  })

  it('写请求自动带幂等键，登录过期后的自动重试沿用同一个键', async () => {
    const api = await load()
    api.setAccessToken('old-token')
    responder = ({ url, init }) => {
      if (url.endsWith('/auth/refresh')) return json(201, { data: { accessToken: 'new-token' } })
      return new Headers(init.headers).get('Authorization') === 'Bearer new-token' ? json(200, { data: { ok: true } }) : json(401, { error: { code: 'AUTH_REQUIRED', message: 'x' } })
    }
    await api.apiFetch('/things', { method: 'POST', body: '{}' })
    const keys = calls.filter(call => call.url.endsWith('/things')).map(call => new Headers(call.init.headers).get('Idempotency-Key'))
    expect(keys.length).toBe(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
  })

  it('写请求带上当前页面路径（审计中心按所属页面筛选）；读请求、站外路径与取不到路径时不带', async () => {
    responder = () => json(200, { data: { ok: true } })
    const api = await load()
    const pageOf = (index: number) => new Headers(calls[index].init.headers).get('X-Nova-Page')
    vi.stubGlobal('window', { location: { assign, pathname: '/app/orders/o1' } })
    await api.apiFetch('/things', { method: 'POST', body: '{}' })
    await api.apiFetch('/things')
    vi.stubGlobal('window', { location: { assign, pathname: '/login' } })
    await api.apiFetch('/things', { method: 'POST', body: '{}' })
    vi.stubGlobal('window', { location: { assign } })
    await api.apiFetch('/things', { method: 'POST', body: '{}' })
    expect([0, 1, 2, 3].map(pageOf)).toEqual(['/app/orders/o1', null, null, null])
  })

  it('管理员尚未启用多因素认证：被服务端拒绝时带去个人账号页绑定；已在该页面则不重复跳转', async () => {
    const api = await load()
    api.setAccessToken('token')
    responder = () => json(403, { error: { code: 'MFA_ENROLLMENT_REQUIRED', message: '管理员必须先绑定多因素认证后才能继续使用' } })
    vi.stubGlobal('window', { location: { assign, pathname: '/app/orders' } })
    await expect(api.apiFetch('/orders')).rejects.toMatchObject({ status: 403, code: 'MFA_ENROLLMENT_REQUIRED' })
    expect(assign).toHaveBeenCalledWith('/app/profile?mfa=required')

    assign.mockClear()
    vi.stubGlobal('window', { location: { assign, pathname: '/app/profile' } })
    await expect(api.apiFetch('/orders')).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' })
    expect(assign).not.toHaveBeenCalled()
  })

  it('退出登录：先通知服务端作废会话，再清除令牌并回到登录页；服务端失败也照样退出', async () => {
    const api = await load()
    api.setAccessToken('token')
    responder = () => json(200, { data: { loggedOut: true } })
    await api.logout()
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual(['POST /api/v1/auth/logout'])
    expect(api.hasAccessToken()).toBe(false)
    expect(assign).toHaveBeenCalledWith('/login')

    assign.mockClear()
    api.setAccessToken('token')
    responder = () => json(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } })
    await api.logout()
    expect(api.hasAccessToken()).toBe(false)
    expect(assign).toHaveBeenCalledWith('/login')
  })
})
