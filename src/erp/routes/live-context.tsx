import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { buildNav, type NavGroup } from './manifest'
import { LIVE_PAGES, type LivePages } from './live-pages'
import { useSession } from '../session/session'

// 外壳需要知道“哪些页面已上线”（导航、命令面板、面包屑链接都只指向已上线页面）。

const LivePagesContext = createContext<LivePages>(LIVE_PAGES)

export function LivePagesProvider({ pages, children }: { pages: LivePages; children: ReactNode }) {
  return <LivePagesContext.Provider value={pages}>{children}</LivePagesContext.Provider>
}

export const useLivePages = () => useContext(LivePagesContext)

/** 当前成员可见的导航：已上线且有权限。 */
export function useNavGroups(): NavGroup[] {
  const pages = useLivePages()
  const { subject } = useSession()
  return useMemo(() => buildNav(component => component in pages, subject), [pages, subject])
}
