import { App, Button, Tooltip } from 'antd'
import { StarFilled, StarOutlined } from '@ant-design/icons'
import { useLocation } from '@tanstack/react-router'
import { FAVORITES_MAX } from '@nova/api-contracts'
import { describeError } from '../query/errors'
import { useNavGroups } from '../routes/live-context'
import { matchManifest, type NavEntry, type NavGroup } from '../routes/manifest'
import { useShellPrefs } from './shell-prefs'

// 收藏（P6-01）：页面标题旁加星，侧边导航顶部的“收藏”分组列出已收藏的页面。存服务端（个人偏好），换设备也在。
// 收藏的是路由模板：只有没有对象参数的页面（列表页、分析页、设置页）能收藏，详情页请收藏它的列表页。

/**
 * 把收藏的路由模板对上当前可用的导航项：已下线或当前成员没有权限的页面不显示（也不报错），顺序保持收藏的先后。
 */
export function resolveFavorites(favorites: readonly string[], groups: readonly NavGroup[]): NavEntry[] {
  const byPath = new Map(groups.flatMap(group => group.items).map(item => [item.path, item]))
  return favorites.flatMap(path => {
    const entry = byPath.get(path)
    return entry ? [entry] : []
  })
}

/** 收藏或取消收藏：基于最新的偏好重算（另一台设备刚改过也不会丢），失败时提示原因。 */
export function useToggleFavorite() {
  const { save } = useShellPrefs()
  const { message } = App.useApp()
  return async (path: string) => {
    try {
      await save(current => {
        const has = current.favorites.includes(path)
        if (!has && current.favorites.length >= FAVORITES_MAX) throw new Error(`最多收藏 ${FAVORITES_MAX} 个页面，请先取消一些再添加`)
        return { favorites: has ? current.favorites.filter(item => item !== path) : [...current.favorites, path] }
      })
    } catch (error) {
      void message.error(describeError(error).message)
    }
  }
}

/** 页面标题旁的星标：没有个人账号（内部访问、支持访问）、不在清单里、不在导航里的页面不显示。 */
export function FavoriteStar() {
  const pathname = useLocation({ select: location => location.pathname })
  const groups = useNavGroups()
  const { enabled, ready, favorites } = useShellPrefs()
  const toggle = useToggleFavorite()
  const match = matchManifest(pathname)
  if (!enabled || !match) return null
  const dynamic = match.spec.path.includes(':')
  const favoritable = !dynamic && groups.some(group => group.items.some(item => item.path === match.spec.path))
  if (!dynamic && !favoritable) return null
  const path = match.spec.path
  const active = favorites.includes(path)
  const full = !active && favorites.length >= FAVORITES_MAX
  const disabled = dynamic || !ready || full
  const hint = dynamic ? '详情页不能收藏，请收藏它的列表页' : full ? `收藏已满 ${FAVORITES_MAX} 个，请先取消一些` : active ? '取消收藏' : '收藏此页面'
  return (
    <Tooltip title={hint}>
      <Button
        type="text"
        size="small"
        disabled={disabled}
        aria-pressed={active}
        aria-label={active ? '取消收藏' : '加入收藏'}
        data-testid="favorite-star"
        icon={active ? <StarFilled style={{ color: 'var(--ant-color-warning)' }} /> : <StarOutlined />}
        onClick={() => void toggle(path)}
      />
    </Tooltip>
  )
}
