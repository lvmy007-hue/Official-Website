import { vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { App as AntApp } from 'antd'
import { setAccessToken } from '../../api'
import { createQueryClient } from '../query/client'
import { createErpRouter, createMemoryHistory } from '../routes/router'
import type { LivePages } from '../routes/live-pages'
import type { Me } from '../session/session'
import { setActiveTenantId } from '../session/tenant-store'
import { ErpConfigProvider } from '../theme/ErpConfigProvider'
import type { ScopeOptions } from '../shell/ScopeBar'

// 整个外壳加路由的集成测试环境：假的 fetch 替代服务端，路由用内存历史。

export const defaultMe: Me = {
  user: { id: 'u1', email: 'owner@example.com', displayName: '林然' },
  tenant: { id: 't1', name: '示例企业有限公司', slug: 'demo', mode: 'PRODUCTION', timezone: 'America/Los_Angeles', defaultCurrency: 'USD' },
  activeTenantId: 't1',
  permissions: ['*'],
  accessMode: 'NORMAL',
}

export const defaultScopeOptions: ScopeOptions = {
  granted: true,
  unrestricted: true,
  entities: [
    { id: 'le1', name: '许昌鸿洛商贸有限公司' },
    { id: 'le2', name: 'Hongluo US LLC' },
  ],
  stores: [
    { id: 'st1', name: 'Northstar US', sellerId: 'A1', legalEntityId: 'le1' },
    { id: 'st2', name: 'Oak & Pine', sellerId: 'A2', legalEntityId: 'le2' },
  ],
  marketplace: { id: 'ATVPDKIKX0DER', label: '美国站 Amazon.com' },
  compareModes: [
    { id: 'none', label: '不对比' },
    { id: 'previous', label: '上一期' },
    { id: 'yoy', label: '去年同期' },
    { id: 'custom', label: '自定义' },
  ],
  currencies: [
    { id: 'USD', label: '美元' },
    { id: 'ORIGINAL', label: '原币' },
  ],
}

export type Handler = (url: URL, init?: RequestInit) => { status?: number; body: unknown }

export function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function mountApp(options: { url: string; me?: Me | null; pages: LivePages; handlers?: Record<string, Handler>; scopeOptions?: ScopeOptions }) {
  const calls: Array<{ path: string; search: string; method: string }> = []
  const me = options.me === undefined ? defaultMe : options.me
  const handlers: Record<string, Handler> = {
    '/auth/me': () => (me ? { body: { success: true, data: me } } : { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: '需要登录' } } }),
    '/auth/refresh': () => ({ status: 401, body: { error: { code: 'AUTH_REQUIRED', message: '登录已失效' } } }),
    '/scope/options': () => ({ body: { success: true, data: options.scopeOptions ?? defaultScopeOptions } }),
    ...options.handlers,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost')
      const path = url.pathname.replace(/^\/api\/v1/, '')
      calls.push({ path, search: url.search, method: (init.method ?? 'GET').toUpperCase() })
      const handler = handlers[path]
      if (!handler) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: '接口不存在' } })
      const result = handler(url, init)
      return jsonResponse(result.status ?? 200, result.body)
    }),
  )
  setAccessToken(null)
  setActiveTenantId(null)
  const queryClient = createQueryClient()
  const router = createErpRouter({ queryClient, pages: options.pages, history: createMemoryHistory({ initialEntries: [options.url] }) })
  const view = render(
    <ErpConfigProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ErpConfigProvider>,
  )
  return { ...view, router, queryClient, calls }
}
