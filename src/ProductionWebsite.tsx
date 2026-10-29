import { useEffect, useId, useRef, useState } from 'react'
import { SiteLink } from './site-link'
import { BrandMark } from './brand'
import { company } from './site-company'
import { productPageBody } from './ProductDetailPages'
import { HomePage } from './home/HomePage'
import { PricingPage } from './home/PricingPage'
import { AboutPage, ContactPage, PrivacyPage, TermsPage, SecurityPage, SolutionsPage, ResourcesPage, NewsPage } from './home/pages'
import { ProductPages } from './home/ProductPages'
import {
  alternatesFor,
  isEnglishPage,
  navProduct,
  navSolutions,
  pageMeta,
  type PublicPage,
} from './public-site-content'
import './public-base.css'
import './production-website.css'
import './site-public.css'

type WebsitePage = PublicPage

function headLink(selector: string, attributes: Record<string, string>) {
  let node = document.head.querySelector(selector)
  if (!node) {
    node = document.createElement(selector.startsWith('meta') ? 'meta' : 'link')
    document.head.appendChild(node)
  }
  Object.entries(attributes).forEach(([key, value]) => node!.setAttribute(key, value))
}

function usePageMeta(page: WebsitePage) {
  useEffect(() => {
    const meta = pageMeta[page]
    const { zh, en } = alternatesFor(page)
    document.title = meta.title
    document.documentElement.lang = isEnglishPage(page) ? 'en' : 'zh-CN'
    headLink('meta[name="description"]', { name: 'description', content: meta.description })
    headLink('link[rel="canonical"]', { rel: 'canonical', href: meta.canonical })
    document.head.querySelectorAll('link[rel="alternate"]').forEach(node => node.remove())
    if (zh) headLink('link[rel="alternate"][hreflang="zh-CN"]', { rel: 'alternate', hreflang: 'zh-CN', href: zh })
    if (en) headLink('link[rel="alternate"][hreflang="en"]', { rel: 'alternate', hreflang: 'en', href: en })
  }, [page])
}

function Header({ page }: { page: WebsitePage }) {
  const [desktopMenu, setDesktopMenu] = useState<'product' | 'solutions' | 'resources' | 'about' | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const menuId = useId()
  const drawerRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!mobileOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    drawerRef.current?.querySelector<HTMLElement>('button, a')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
      if (event.key !== 'Tab' || !drawerRef.current) return
      const items = [...drawerRef.current.querySelectorAll<HTMLElement>('button, a')].filter(item => !item.hasAttribute('disabled'))
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
      previouslyFocused?.focus()
    }
  }, [mobileOpen])

  useEffect(() => {
    if (!desktopMenu) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDesktopMenu(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desktopMenu])

  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const closeTimer = useRef<number>()
  const hover = (key: NonNullable<typeof desktopMenu>) => ({
    onMouseEnter: () => { window.clearTimeout(closeTimer.current); setDesktopMenu(key) },
    onMouseLeave: () => { closeTimer.current = window.setTimeout(() => setDesktopMenu(current => current === key ? null : current), 180) },
  })

  const closeMobile = () => setMobileOpen(false)

  return <header className={`pub-header${scrolled ? ' is-scrolled' : ''}`}>
    <div className="lx-topbar"><div><span>{company.legalName}</span><a href={`mailto:${company.email}`}>{company.email}</a><span>工作日回复</span></div><SiteLink href="/login">登录工作台</SiteLink></div>
    <div className="pub-header-bar">
      <SiteLink href="/" className="pub-brand"><BrandMark /><span><b>NOVA ERP</b><small>DZANX</small></span></SiteLink>
      <nav className="pub-desktop-nav" aria-label="主导航">
        <SiteLink href="/" className={page === 'home' ? 'active' : ''}>首页</SiteLink>
        <div className="pub-dropdown" {...hover('product')}>
          <button className={page.startsWith('product') ? 'active' : ''} aria-expanded={desktopMenu === 'product'} aria-controls={`${menuId}-product`} onClick={() => setDesktopMenu(current => current === 'product' ? null : 'product')}>产品</button>
          <div id={`${menuId}-product`} className="pub-mega" hidden={desktopMenu !== 'product'}>
            {[
              ['财务', ['/product/finance', '/product/returns']],
              ['供应链', ['/product/inventory', '/product/inbound', '/product/listings', '/product/orders', '/product/stores']],
              ['运营', ['/product/permissions']],
              ['广告', ['/product/advertising']],
            ].map(([label, hrefs]) => <div key={String(label)}><div className="pub-mega-label">{label}</div>{navProduct.filter(item => (hrefs as string[]).includes(item.href)).map(item => <SiteLink key={item.href} href={item.href} onClick={() => setDesktopMenu(null)}><b>{item.label}</b><small>{item.text}</small></SiteLink>)}</div>)}
            <aside className="pub-mega-side"><b>授权怎么分</b><p>卖家授权完成后，广告花费不会自动出现。广告账户要再授权一次，报表只读。</p><SiteLink href="/security" onClick={() => setDesktopMenu(null)}>查看数据说明</SiteLink></aside>
          </div>
        </div>
        <div className="pub-dropdown" {...hover('solutions')}>
          <button className={page === 'solutions' || page === 'solutions-advertising' ? 'active' : ''} aria-expanded={desktopMenu === 'solutions'} aria-controls={`${menuId}-solutions`} onClick={() => setDesktopMenu(current => current === 'solutions' ? null : 'solutions')}>方案</button>
          <div id={`${menuId}-solutions`} className="pub-mega pub-mega-slim" hidden={desktopMenu !== 'solutions'}>
            <div>{navSolutions.map(item => <SiteLink key={item.label} href={item.href} onClick={() => setDesktopMenu(null)}><b>{item.label}</b><small>{item.text}</small></SiteLink>)}</div>
            <aside className="pub-mega-side"><b>方案报价</b><p>单公司起步不含广告报表。开通以书面方案为准，网页不收款。</p><SiteLink href="/pricing" onClick={() => setDesktopMenu(null)}>查看方案</SiteLink></aside>
          </div>
        </div>
        <SiteLink href="/pricing" className={page === 'pricing' ? 'active' : ''}>价格</SiteLink>
        <div className="pub-dropdown" {...hover('resources')}>
          <button className={page === 'resources' || page === 'news' ? 'active' : ''} aria-expanded={desktopMenu === 'resources'} onClick={() => setDesktopMenu(current => current === 'resources' ? null : 'resources')}>资源</button>
          <div className="pub-mega pub-mega-slim" hidden={desktopMenu !== 'resources'}>
            <div>
              <div className="pub-mega-label">资源</div>
              <SiteLink href="/news" onClick={() => setDesktopMenu(null)}><b>最新资讯</b><small>已经写进网站和系统的规则</small></SiteLink>
              <SiteLink href="/resources" onClick={() => setDesktopMenu(null)}><b>接入说明</b><small>卖家授权、广告授权、权限和删除</small></SiteLink>
              <div className="pub-mega-label">支持</div>
              <SiteLink href="/security" onClick={() => setDesktopMenu(null)}><b>数据说明</b><small>保存、删除和成员权限</small></SiteLink>
            </div>
            <aside className="pub-mega-side"><b>先确认范围</b><p>主体、店铺数量和要看的模块写在预约里。没有自助开通。</p><SiteLink href="/contact" onClick={() => setDesktopMenu(null)}>预约演示</SiteLink></aside>
          </div>
        </div>
        <div className="pub-dropdown" {...hover('about')}>
          <button className={page === 'about' ? 'active' : ''} aria-expanded={desktopMenu === 'about'} onClick={() => setDesktopMenu(current => current === 'about' ? null : 'about')}>关于</button>
          <div className="pub-mega pub-mega-slim" hidden={desktopMenu !== 'about'}>
            <div>
              <SiteLink href="/about" onClick={() => setDesktopMenu(null)}><b>关于我们</b><small>公司登记、住所和统一社会信用代码</small></SiteLink>
              <SiteLink href="/news" onClick={() => setDesktopMenu(null)}><b>新闻</b><small>授权边界和删除规则的变更</small></SiteLink>
              <SiteLink href="/contact" onClick={() => setDesktopMenu(null)}><b>联系</b><small>工作日用邮件回复预约</small></SiteLink>
            </div>
            <aside className="pub-mega-side"><b>{company.legalName}</b><p>{company.email}</p><SiteLink href="/about" onClick={() => setDesktopMenu(null)}>查看登记信息</SiteLink></aside>
          </div>
        </div>
      </nav>
      <div className="pub-header-actions">
        <SiteLink href="/en" className="pub-lang">EN</SiteLink>
        <SiteLink href="/login" className="pub-login">登录</SiteLink>
        <SiteLink href="/contact" className="pub-primary">预约演示</SiteLink>
        <button ref={menuButtonRef} className="pub-menu-button" aria-expanded={mobileOpen} aria-controls="mobile-nav" onClick={() => setMobileOpen(true)}>菜单</button>
      </div>
    </div>
    {mobileOpen && <div className="pub-drawer-backdrop" onClick={closeMobile}>
      <div id="mobile-nav" ref={drawerRef} className="pub-drawer" role="dialog" aria-modal="true" aria-label="网站菜单" onClick={event => event.stopPropagation()}>
        <div className="pub-drawer-head"><b>NOVA ERP</b><button onClick={closeMobile}>关闭</button></div>
        <details open><summary>产品</summary>{navProduct.map(item => <SiteLink key={item.href} href={item.href} onClick={closeMobile}>{item.label}</SiteLink>)}</details>
        <details open><summary>方案</summary>{navSolutions.map(item => <SiteLink key={item.label} href={item.href} onClick={closeMobile}>{item.label}</SiteLink>)}</details>
        <SiteLink href="/pricing" onClick={closeMobile}>价格</SiteLink>
        <details><summary>资源</summary><SiteLink href="/news" onClick={closeMobile}>最新资讯</SiteLink><SiteLink href="/resources" onClick={closeMobile}>接入说明</SiteLink><SiteLink href="/security" onClick={closeMobile}>数据说明</SiteLink></details>
        <details><summary>关于</summary><SiteLink href="/about" onClick={closeMobile}>关于我们</SiteLink><SiteLink href="/news" onClick={closeMobile}>新闻</SiteLink><SiteLink href="/contact" onClick={closeMobile}>联系接入</SiteLink></details>
        <div className="pub-drawer-actions">
          <SiteLink href="/en" onClick={closeMobile}>English</SiteLink>
          <SiteLink href="/login" onClick={closeMobile}>登录</SiteLink>
          <SiteLink href="/contact" className="pub-primary" onClick={closeMobile}>预约演示</SiteLink>
        </div>
      </div>
    </div>}
  </header>
}

function Footer() {
  return <footer className="pub-footer">
    <div className="pub-wrap pub-footer-intro"><span className="pub-footer-brand"><BrandMark size={28} /><b>NOVA ERP</b></span><b>{company.legalName}</b><p>NOVA ERP 用于多家公司的订单、库存、刊登、入库、财务和广告报表。卖家授权与广告授权分开完成。</p><a href={`mailto:${company.email}`}>{company.email}</a></div>
    <div className="pub-wrap pub-footer-grid">
      <div>
        <b>产品</b>
        {navProduct.map(item => <SiteLink key={item.href} href={item.href}>{item.label}</SiteLink>)}
      </div>
      <div>
        <b>方案</b>
        <SiteLink href="/solutions#single">单公司起步</SiteLink>
        <SiteLink href="/solutions#multi">多公司</SiteLink>
        <SiteLink href="/solutions/advertising">广告只读报表</SiteLink>
        <SiteLink href="/product/finance">业财核对</SiteLink>
      </div>
      <div>
        <b>资源</b>
        <SiteLink href="/news">最新资讯</SiteLink>
        <SiteLink href="/resources">接入说明</SiteLink>
        <SiteLink href="/security">数据说明</SiteLink>
      </div>
      <div>
        <b>关于</b>
        <SiteLink href="/about">关于我们</SiteLink>
        <SiteLink href="/contact">联系接入</SiteLink>
        <SiteLink href="/news">新闻</SiteLink>
      </div>
      <div>
        <b>法律</b>
        <SiteLink href="/privacy">隐私政策</SiteLink>
        <SiteLink href="/terms">服务条款</SiteLink>
        <SiteLink href="/security">安全说明</SiteLink>
      </div>
    </div>
    <div className="pub-wrap pub-footer-bottom">
      <span>© 2026 {company.legalName}</span>
      <span>{company.address}</span>
      <span><a href={`mailto:${company.email}`}>{company.email}</a>{company.phone ? ` · ${company.phone}` : ''}</span>
      {company.icpNumber ? <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">{company.icpNumber}</a> : null}
      <span className="pub-footer-links"><SiteLink href="/privacy">隐私政策</SiteLink><SiteLink href="/terms">服务条款</SiteLink><SiteLink href="/security">安全说明</SiteLink><SiteLink href="/en">English</SiteLink></span>
    </div>
  </footer>
}

function SideDock() {
  const [top, setTop] = useState(false)
  useEffect(() => {
    const onScroll = () => setTop(window.scrollY > 480)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return <aside className="side-dock" aria-label="快捷联系">
    <SiteLink href="/contact">咨询</SiteLink>
    <a href={`mailto:${company.email}`}>邮件</a>
    {company.phone ? <a href={`tel:${company.phone.replace(/-/g, '')}`}>电话</a> : null}
    {top && <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>顶部</button>}
  </aside>
}

function NotFoundPage() {
  return <section className="pub-policy"><div className="pub-wrap"><h1>页面不存在</h1><p className="pub-lede">这个地址没有对应的公开页面。</p><SiteLink href="/" className="pub-primary">返回首页</SiteLink></div></section>
}

export function ProductionWebsite({ page = 'home' }: { page?: WebsitePage }) {
  usePageMeta(page)
  useEffect(() => {
    const hash = window.location.hash
    if (!hash) return
    const target = document.querySelector(hash)
    if (target) target.scrollIntoView()
  }, [page])
  if (page === 'en-home') return <HomePage lang="en" />
  if (page === 'en-product' || page.startsWith('en-product-') || page === 'en-solutions-advertising') return <ProductPages page={page} lang="en" />
  if (page === 'en-solutions') return <SolutionsPage lang="en" />
  if (page === 'en-pricing') return <PricingPage lang="en" />
  if (page === 'en-about') return <AboutPage lang="en" />
  if (page === 'en-news') return <NewsPage lang="en" />
  if (page === 'en-resources') return <ResourcesPage lang="en" />
  if (page === 'en-contact') return <ContactPage lang="en" />
  if (page === 'en-privacy') return <PrivacyPage lang="en" />
  if (page === 'en-terms') return <TermsPage lang="en" />
  if (page === 'en-security') return <SecurityPage lang="en" />
  if (page === 'home') return <HomePage />
  if (page === 'pricing') return <PricingPage />
  if (page === 'about') return <AboutPage />
  if (page === 'contact') return <ContactPage />
  if (page === 'privacy') return <PrivacyPage />
  if (page === 'terms') return <TermsPage />
  if (page === 'security') return <SecurityPage />
  if (page === 'product' || page.startsWith('product-') || page === 'solutions-advertising') return <ProductPages page={page} />
  if (page === 'solutions') return <SolutionsPage />
  if (page === 'resources') return <ResourcesPage />
  if (page === 'news') return <NewsPage />
  return <div className="pub-site site-public lx">
    <a className="pub-skip" href="#main">跳到主要内容</a>
    <div className="site-notice"><span>{[company.legalName, '经营数据服务', company.phone].filter(Boolean).join(' · ')}</span><SiteLink href="/contact">预约演示</SiteLink><SiteLink href="/pricing">查看服务范围</SiteLink></div>
    <Header page={page} />
    <main id="main">
      {productPageBody(page)}
      {page === 'not-found' && <NotFoundPage />}
    </main>
    <Footer />
    <SideDock />
  </div>
}

export { websitePageFromPath } from './public-site-content'
