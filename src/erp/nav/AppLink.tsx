import type { MouseEvent, ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { pickScope } from '../scope/params'

// 站内链接：在路由里做无刷新跳转，并默认带上当前的全局范围参数（范围在页面间保持不变）。
// 没有路由环境时（例如单独渲染组件做测试）退化为普通链接。

type Search = Record<string, unknown>

export type AppLinkProps = {
  to: string
  /** 目标页自己的参数（筛选、分页等）。 */
  search?: Search
  /** 是否沿用当前范围参数，默认沿用。 */
  keepScope?: boolean
  children: ReactNode
  className?: string
  title?: string
  onNavigate?: () => void
}

export function useAppNavigate() {
  const router = useRouter({ warn: false })
  return (to: string, search?: Search, keepScope = true) => {
    if (!router) {
      window.location.assign(to)
      return
    }
    void router.navigate({ to, search: ((prev: Search) => ({ ...(keepScope ? pickScope(prev) : {}), ...search })) as never })
  }
}

export function AppLink({ to, search, keepScope = true, children, className, title, onNavigate }: AppLinkProps) {
  const router = useRouter({ warn: false })
  const href = router ? router.buildLocation({ to, search: ((prev: Search) => ({ ...(keepScope ? pickScope(prev) : {}), ...search })) as never }).href : to
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onNavigate?.()
    if (!router || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    void router.navigate({ to, search: ((prev: Search) => ({ ...(keepScope ? pickScope(prev) : {}), ...search })) as never })
  }
  return (
    <a href={href} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  )
}
