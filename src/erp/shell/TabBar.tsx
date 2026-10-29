import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dropdown } from 'antd'
import { CloseOutlined, EllipsisOutlined } from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useRouter } from '@tanstack/react-router'
import { useLivePages } from '../routes/live-context'
import { matchManifest } from '../routes/manifest'
import { useSession } from '../session/session'
import { getPageObjectName, usePageObjectNameVersion } from './page-title'
import { closeOthers, closeRight, closeTab, neighborAfterClose, openTab, parseStoredTabs, serializeTabs, tabTitle, tabsStorageKey, type TabEntry } from './tab-state'

// 多页签条（P6-01，15 章第 11 节）：顶栏下方，打开的页面自动成为页签；可关闭、关闭其他、关闭右侧、刷新当前；最多 15 个。
// 状态存本机（按企业与成员区分），只记路径与查询串——切回页签时用查询串还原筛选与范围，并尽力还原滚动位置；不缓存整页组件。

/** 不进页签的页面：登录、初始化向导。 */
const NO_TAB = new Set(['/app/login', '/app/onboarding'])
const RESTORE_FRAMES = 30

function readStored(key: string, isOpenable: (path: string) => boolean): TabEntry[] {
  try {
    return parseStoredTabs(localStorage.getItem(key), isOpenable)
  } catch {
    return []
  }
}

/** 等页面内容长到够高再滚动（页面是懒加载的，刚切回来时内容可能还没出来），最多等 30 帧。 */
function restoreScroll(y: number): void {
  if (typeof window.scrollTo !== 'function') return
  let frames = 0
  const step = () => {
    frames += 1
    const reachable = document.documentElement.scrollHeight - window.innerHeight >= y
    if (reachable || frames >= RESTORE_FRAMES) window.scrollTo(0, y)
    else requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export function TabBar() {
  const { me, can } = useSession()
  const pages = useLivePages()
  const router = useRouter()
  const client = useQueryClient()
  const pathname = useLocation({ select: location => location.pathname })
  const searchStr = useLocation({ select: location => location.searchStr })
  const nameVersion = usePageObjectNameVersion()
  const key = tabsStorageKey(me.activeTenantId, me.user.id)

  const isOpenable = useCallback(
    (path: string) => {
      const match = matchManifest(path)
      return Boolean(match && !NO_TAB.has(match.spec.path) && match.spec.component in pages && can(match.spec.access))
    },
    [pages, can],
  )

  const [store, setStore] = useState(() => ({ key, tabs: readStored(key, isOpenable) }))
  // 换企业或换账号：换成对应的那一份
  const tabs = store.key === key ? store.tabs : readStored(key, isOpenable)
  useEffect(() => {
    if (store.key !== key) setStore({ key, tabs })
  }, [store.key, key, tabs])

  const setTabs = useCallback((update: (tabs: TabEntry[]) => TabEntry[]) => setStore(prev => ({ key, tabs: update(prev.key === key ? prev.tabs : []) })), [key])

  // 滚动位置按路径记在内存里，写本机存储时一并带上
  const positions = useRef(new Map<string, number>())
  const currentPath = useRef(pathname)
  currentPath.current = pathname
  const restoring = useRef<{ path: string; y: number } | null>(null)
  useEffect(() => {
    const onScroll = () => positions.current.set(currentPath.current, window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // 地址变化：打开或激活对应页签
  useEffect(() => {
    if (!isOpenable(pathname)) return
    const match = matchManifest(pathname)!
    setTabs(prev => openTab(prev, { path: pathname, search: searchStr, title: tabTitle(match.spec.title, match.params, getPageObjectName(pathname)), now: Date.now() }))
    if (restoring.current?.path === pathname) {
      restoreScroll(restoring.current.y)
      restoring.current = null
    }
  }, [pathname, searchStr, nameVersion, isOpenable, setTabs])

  // 写本机存储
  useEffect(() => {
    if (store.key !== key) return
    try {
      localStorage.setItem(key, serializeTabs(store.tabs.map(tab => ({ ...tab, scrollY: positions.current.get(tab.path) ?? tab.scrollY }))))
    } catch {
      // 本机存储不可用或已满：页签只在本次打开期间有效
    }
  }, [store, key])

  const go = (tab: TabEntry) => {
    restoring.current = tab.scrollY > 0 ? { path: tab.path, y: positions.current.get(tab.path) ?? tab.scrollY } : null
    router.history.push(`${tab.path}${tab.search}`)
  }
  const titleOf = (tab: TabEntry) => {
    const match = matchManifest(tab.path)
    const name = getPageObjectName(tab.path)
    return match && name ? tabTitle(match.spec.title, match.params, name) : tab.title
  }

  const close = (path: string) => {
    if (tabs.length <= 1) return
    if (path === pathname) {
      const next = neighborAfterClose(tabs, path)
      if (next) go(next)
    }
    setTabs(prev => closeTab(prev, path))
  }
  const closeOther = (path: string) => {
    const keep = tabs.find(tab => tab.path === path)
    setTabs(prev => closeOthers(prev, path))
    if (keep && pathname !== path) go(keep)
  }
  const closeRightOf = (path: string) => {
    const keep = tabs.find(tab => tab.path === path)
    const index = tabs.findIndex(tab => tab.path === path)
    const activeIndex = tabs.findIndex(tab => tab.path === pathname)
    setTabs(prev => closeRight(prev, path))
    if (keep && activeIndex > index) go(keep)
  }
  // 刷新当前：让正在显示的数据重新取一遍（不重新加载页面，筛选与滚动位置不变）
  const refresh = () => void client.invalidateQueries()

  const menuFor = (path: string) => {
    const index = tabs.findIndex(tab => tab.path === path)
    return {
      items: [
        { key: 'refresh', label: '刷新当前', disabled: path !== pathname },
        { key: 'close', label: '关闭', disabled: tabs.length <= 1 },
        { key: 'others', label: '关闭其他', disabled: tabs.length <= 1 },
        { key: 'right', label: '关闭右侧', disabled: index < 0 || index >= tabs.length - 1 },
      ],
      onClick: ({ key: action }: { key: string }) => {
        if (action === 'refresh') refresh()
        if (action === 'close') close(path)
        if (action === 'others') closeOther(path)
        if (action === 'right') closeRightOf(path)
      },
    }
  }

  if (tabs.length === 0) return null
  return (
    <div className="erp-tabbar" data-testid="tab-bar">
      <nav className="erp-tabbar-list" aria-label="已打开的页面">
        {tabs.map(tab => {
          const active = tab.path === pathname
          const title = titleOf(tab)
          return (
            <Dropdown key={tab.path} menu={menuFor(tab.path)} trigger={['contextMenu']}>
              <div className="erp-tab" data-active={active} data-path={tab.path}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  className="erp-tab-title"
                  title={title}
                  onClick={() => (active ? undefined : go(tab))}
                  onAuxClick={event => (event.button === 1 ? close(tab.path) : undefined)}
                >
                  {title}
                </button>
                {tabs.length > 1 ? (
                  <button type="button" className="erp-tab-close" aria-label={`关闭页签 ${title}`} onClick={() => close(tab.path)}>
                    <CloseOutlined />
                  </button>
                ) : null}
              </div>
            </Dropdown>
          )
        })}
      </nav>
      <Dropdown menu={menuFor(pathname)} trigger={['click']}>
        <Button type="text" size="small" icon={<EllipsisOutlined />} aria-label="页签操作" />
      </Dropdown>
    </div>
  )
}
