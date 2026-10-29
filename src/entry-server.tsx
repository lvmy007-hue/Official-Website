import { renderToString } from 'react-dom/server'
import { PublicRoot } from './PublicRoot'
import { alternatesFor, isEnglishPage, pageMeta, publicDocumentPaths, websitePageFromPath, type PublicPage } from './public-site-content'

export function prerenderPaths() {
  return [...publicDocumentPaths()].filter(path => path !== '/login' && path !== '/site')
}

export function render(path: string) {
  const page: PublicPage = websitePageFromPath(path) ?? 'not-found'
  const meta = pageMeta[page]
  return {
    html: renderToString(<PublicRoot initialPath={path} />),
    lang: isEnglishPage(page) ? 'en' : 'zh-CN',
    title: meta.title,
    description: meta.description,
    canonical: meta.canonical,
    alternates: alternatesFor(page),
  }
}
