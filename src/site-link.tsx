import type { ReactNode } from 'react'

export function nav(path: string) {
  const url = new URL(path, window.location.origin)
  const next = `${url.pathname}${url.search}${url.hash}`
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) {
    if (url.hash) document.querySelector(url.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  window.history.pushState({}, '', next)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.requestAnimationFrame(() => {
    if (url.hash) document.querySelector(url.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    else window.scrollTo({ top: 0 })
  })
}

export function SiteLink({ href, className, children, onClick }: { href: string; className?: string; children: ReactNode; onClick?: () => void }) {
  return <a href={href} className={className} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    onClick?.()
    nav(href)
  }}>{children}</a>
}
