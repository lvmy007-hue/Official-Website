import { useMemo } from 'react'
import { Menu } from 'antd'
import type { ItemType } from 'antd/es/menu/interface'
import { useLocation } from '@tanstack/react-router'
import { useAppNavigate } from '../nav/AppLink'
import { useNavGroups } from '../routes/live-context'
import { resolveFavorites } from './favorites'
import { useShellPrefs } from './shell-prefs'

// 侧边导航（P1-04）：按 03 章 3.5 分组，只含已上线且有权限的页面。
// P6-01：顶部多一个“收藏”分组（个人偏好，换设备也在）；收藏项的键带前缀，避免和下面分组里的同一页面重键。

const FAVORITE_PREFIX = 'fav:'

/** 当前地址对应的导航项：取最长的前缀匹配（详情页高亮其列表页）。 */
export function selectedNavPath(pathname: string, paths: string[]): string | undefined {
  return [...paths].sort((a, b) => b.length - a.length).find(path => pathname === path || pathname.startsWith(`${path}/`))
}

export function SideNav() {
  const groups = useNavGroups()
  const navigate = useAppNavigate()
  const pathname = useLocation({ select: location => location.pathname })
  const { enabled, ready, failed, favorites } = useShellPrefs()
  const favoriteEntries = useMemo(() => resolveFavorites(favorites, groups), [favorites, groups])
  const items = useMemo<ItemType[]>(() => {
    const normal: ItemType[] = groups.map(group => ({ type: 'group', key: group.label, label: group.label, children: group.items.map(item => ({ key: item.path, label: item.title })) }))
    if (!enabled) return normal
    const favoriteGroup: ItemType = {
      type: 'group',
      key: 'favorites',
      label: '收藏',
      children:
        favoriteEntries.length > 0
          ? favoriteEntries.map(item => ({ key: `${FAVORITE_PREFIX}${item.path}`, label: item.title }))
          : [{ key: 'favorites-empty', label: ready ? '点击页面标题旁的星标添加收藏' : failed ? '收藏暂时读不到，刷新页面重试' : '收藏读取中…', disabled: true }],
    }
    return [favoriteGroup, ...normal]
  }, [groups, enabled, ready, failed, favoriteEntries])
  const selected = selectedNavPath(
    pathname,
    groups.flatMap(group => group.items.map(item => item.path)),
  )
  const selectedKeys = selected ? [selected, ...(favoriteEntries.some(item => item.path === selected) ? [`${FAVORITE_PREFIX}${selected}`] : [])] : []
  return (
    <nav aria-label="主导航">
      <Menu
        mode="inline"
        items={items}
        selectedKeys={selectedKeys}
        onClick={({ key }) => navigate(String(key).startsWith(FAVORITE_PREFIX) ? String(key).slice(FAVORITE_PREFIX.length) : String(key))}
        style={{ borderInlineEnd: 0 }}
      />
    </nav>
  )
}
