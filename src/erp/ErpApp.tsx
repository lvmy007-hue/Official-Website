import { useEffect, useMemo } from 'react'
import { App as AntApp } from 'antd'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { createQueryClient, setErrorNotifier, setUnauthorizedHandler } from './query/client'
import { setPlatformExpiredHandler } from './platform/platform-api'
import { createErpRouter, type ErpRouter } from './routes/router'
import { startWebVitals } from './telemetry/web-vitals'
import { ErpConfigProvider } from './theme/ErpConfigProvider'

// ERP 前端的根组件：主题 → 提示 → 数据请求 → 路由。

function Bridges({ router }: { router: ErpRouter }) {
  const { message } = AntApp.useApp()
  useEffect(() => {
    // 写操作失败：统一用中文提示，带请求编号便于反馈
    setErrorNotifier(info => {
      void message.error(info.requestId ? `${info.message}（请求编号 ${info.requestId}）` : info.message)
    })
    // 登录失效：回到登录页，并记住当前位置以便登录后返回
    setUnauthorizedHandler(() => {
      const { pathname, searchStr } = router.state.location
      // 平台运营后台有自己的登录页与令牌；邀请页是公开页面，不跳转
      if (pathname.startsWith('/platform')) {
        if (pathname !== '/platform/login') void router.navigate({ to: '/platform/login' })
        return
      }
      if (pathname.startsWith('/invite/')) return
      if (pathname === '/login' || pathname === '/app/login') return
      void router.navigate({ to: '/app/login', search: { redirect: pathname + searchStr } as never })
    })
    // 平台令牌到期：回到平台登录页
    setPlatformExpiredHandler(() => {
      const { pathname } = router.state.location
      if (pathname.startsWith('/platform') && pathname !== '/platform/login') void router.navigate({ to: '/platform/login' })
    })
    return () => setPlatformExpiredHandler(null)
  }, [message, router])
  return null
}

export function ErpApp() {
  const queryClient = useMemo(() => createQueryClient(), [])
  const router = useMemo(() => createErpRouter({ queryClient }), [queryClient])
  // 性能埋点（P1-09）：只记指标名、耗时与路由模板
  useEffect(() => startWebVitals(() => router.state.location.pathname), [router])
  return (
    <ErpConfigProvider>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <Bridges router={router} />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ErpConfigProvider>
  )
}
