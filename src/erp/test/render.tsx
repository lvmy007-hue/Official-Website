import type { ReactElement, ReactNode } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp } from 'antd'
import { ErpConfigProvider } from '../theme/ErpConfigProvider'
import { SessionProvider, type Me } from '../session/session'

// 组件测试的统一渲染入口：带主题与数据请求环境；不重试、不缓存，测试结果可预期。
// 传 me 时同时提供登录会话（权限判断用）。

export function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } } })
}

export function renderWithApp(ui: ReactElement, options: { client?: QueryClient; me?: Me } = {}) {
  const client = options.client ?? createTestQueryClient()
  const wrap = (children: ReactNode) => (
    <ErpConfigProvider>
      <AntApp>
        <QueryClientProvider client={client}>{options.me ? <SessionProvider me={options.me}>{children}</SessionProvider> : children}</QueryClientProvider>
      </AntApp>
    </ErpConfigProvider>
  )
  const result = render(wrap(ui))
  return { ...result, client, rerender: (next: ReactElement) => result.rerender(wrap(next)) }
}
