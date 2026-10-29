import { Breadcrumb } from 'antd'
import { useLocation } from '@tanstack/react-router'
import { AppLink } from '../nav/AppLink'
import { useLivePages } from '../routes/live-context'
import { matchManifest, specByPath } from '../routes/manifest'

// 面包屑（P1-04）：分组 › 列表页 › 当前页。分组只是文字；列表页只有已上线时才可点击。

export type Crumb = { label: string; to?: string }

export function buildCrumbs(pathname: string, isLive: (component: string) => boolean): Crumb[] {
  const match = matchManifest(pathname)
  if (!match) return []
  const { spec } = match
  const crumbs: Crumb[] = [{ label: spec.group }]
  // 详情页：把它的列表页（去掉最后一段动态参数）放在中间
  const parentPath = spec.path.replace(/\/:[A-Za-z]+$/, '')
  const parent = parentPath !== spec.path ? specByPath.get(parentPath) : undefined
  if (parent && isLive(parent.component)) crumbs.push({ label: parent.title, to: parent.path })
  crumbs.push({ label: spec.title })
  return crumbs
}

export function Breadcrumbs() {
  const pathname = useLocation({ select: location => location.pathname })
  const pages = useLivePages()
  const crumbs = buildCrumbs(pathname, component => component in pages)
  if (crumbs.length === 0) return null
  return (
    <Breadcrumb
      items={crumbs.map(crumb => ({
        title: crumb.to ? <AppLink to={crumb.to}>{crumb.label}</AppLink> : crumb.label,
      }))}
    />
  )
}
