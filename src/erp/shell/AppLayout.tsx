import { Outlet, useSearch } from '@tanstack/react-router'
import { DataState } from '../components/data-state/DataState'
import { ScopeProvider } from '../scope/context'
import { SessionProvider, useMeQuery } from '../session/session'
import { LivePagesProvider } from '../routes/live-context'
import type { LivePages } from '../routes/live-pages'
import { AppShell } from './AppShell'

// /app 下所有页面共用的布局：会话 → 范围 → 外壳。登录检查在路由的 beforeLoad 里完成。

export function AppLayout({ pages }: { pages: LivePages }) {
  const meQuery = useMeQuery()
  const search = useSearch({ strict: false }) as Record<string, unknown>
  if (!meQuery.data) {
    return <DataState kind="skeleton" />
  }
  return (
    <SessionProvider me={meQuery.data}>
      <LivePagesProvider pages={pages}>
        <ScopeProvider scope={search}>
          <AppShell>
            <Outlet />
          </AppShell>
        </ScopeProvider>
      </LivePagesProvider>
    </SessionProvider>
  )
}
