import { createContext, useContext } from 'react'

export type Lang = 'zh' | 'en'

export const LangContext = createContext<Lang>('zh')

export const useLang = () => useContext(LangContext)

/** 就地双语：t('中文','English')，按当前语言返回 */
export function useT() {
  const lang = useLang()
  return (zh: string, en: string) => (lang === 'en' ? en : zh)
}

/** 英文站与中文站页面一一对应，英文路由即 /en + 中文路径（保留子路径与 hash） */
export function enHref(href: string): string {
  if (!href.startsWith('/')) return href
  if (href.startsWith('/en')) return href
  if (href === '/' || href === '') return '/en'
  if (href === '/login') return '/login'
  if (/^\/(product|solutions|pricing|about|contact|privacy|terms|security|news|resources)(\/|#|$)/.test(href)) return '/en' + href
  return '/en'
}

/** 返回按当前语言本地化链接的函数 */
export function useL() {
  const lang = useLang()
  return (href: string) => (lang === 'en' ? enHref(href) : href)
}
