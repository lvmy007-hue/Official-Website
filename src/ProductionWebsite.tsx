import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { IconArrowRight } from '@arco-design/web-react/icon'
import { Message } from '@arco-design/web-react'
import { apiFetch } from './api'
import { SiteLink } from './site-link'
import { company, spApiRoles } from './site-company'
import { guides, press } from './site-commercial'
import { productPageBody } from './ProductDetailPages'
import { OfficialHome } from './OfficialHome'
import {
  legalBanner,
  navProduct,
  navSolutions,
  pageMeta,
  privacySections,
  securitySections,
  termsSections,
  type PublicPage,
} from './public-site-content'
import './production-website.css'
import './site-public.css'

type WebsitePage = PublicPage

function usePageMeta(page: WebsitePage) {
  useEffect(() => {
    const meta = pageMeta[page]
    document.title = meta.title
    document.documentElement.lang = 'zh-CN'
    let description = document.querySelector('meta[name="description"]')
    if (!description) {
      description = document.createElement('meta')
      description.setAttribute('name', 'description')
      document.head.appendChild(description)
    }
    description.setAttribute('content', meta.description)
    let canonical = document.querySelector('link[rel="canonical"]')
    if (!canonical) {
      canonical = document.createElement('link')
      canonical.setAttribute('rel', 'canonical')
      document.head.appendChild(canonical)
    }
    canonical.setAttribute('href', meta.canonical)
    let alternate = document.querySelector('link[rel="alternate"][hreflang="zh-CN"]')
    if (!alternate) {
      alternate = document.createElement('link')
      alternate.setAttribute('rel', 'alternate')
      alternate.setAttribute('hreflang', 'zh-CN')
      document.head.appendChild(alternate)
    }
    alternate.setAttribute('href', meta.canonical)
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

  const closeMobile = () => setMobileOpen(false)

  return <header className="pub-header">
    <div className="lx-topbar"><div><span>{company.legalName}</span><a href={`mailto:${company.email}`}>{company.email}</a><span>工作日回复</span></div><SiteLink href="/login">登录工作台</SiteLink></div>
    <div className="pub-header-bar">
      <SiteLink href="/" className="pub-brand"><span className="brand-mark">N</span><span><b>NOVA ERP</b><small>DZANX</small></span></SiteLink>
      <nav className="pub-desktop-nav" aria-label="主导航">
        <SiteLink href="/" className={page === 'home' ? 'active' : ''}>首页</SiteLink>
        <div className="pub-dropdown" onMouseLeave={() => setDesktopMenu(current => current === 'product' ? null : current)}>
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
        <div className="pub-dropdown" onMouseLeave={() => setDesktopMenu(current => current === 'solutions' ? null : current)}>
          <button className={page === 'solutions' || page === 'solutions-advertising' ? 'active' : ''} aria-expanded={desktopMenu === 'solutions'} aria-controls={`${menuId}-solutions`} onClick={() => setDesktopMenu(current => current === 'solutions' ? null : 'solutions')}>方案</button>
          <div id={`${menuId}-solutions`} className="pub-mega pub-mega-slim" hidden={desktopMenu !== 'solutions'}>
            <div>{navSolutions.map(item => <SiteLink key={item.label} href={item.href} onClick={() => setDesktopMenu(null)}><b>{item.label}</b><small>{item.text}</small></SiteLink>)}</div>
            <aside className="pub-mega-side"><b>目录价</b><p>单公司起步不含广告报表。开通以书面方案为准，网页不收款。</p><SiteLink href="/pricing" onClick={() => setDesktopMenu(null)}>查看目录价</SiteLink></aside>
          </div>
        </div>
        <SiteLink href="/pricing" className={page === 'pricing' ? 'active' : ''}>价格</SiteLink>
        <div className="pub-dropdown" onMouseLeave={() => setDesktopMenu(current => current === 'resources' ? null : current)}>
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
        <div className="pub-dropdown" onMouseLeave={() => setDesktopMenu(current => current === 'about' ? null : current)}>
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
          <SiteLink href="/login" onClick={closeMobile}>登录</SiteLink>
          <SiteLink href="/contact" className="pub-primary" onClick={closeMobile}>预约演示</SiteLink>
        </div>
      </div>
    </div>}
  </header>
}

function Footer() {
  return <footer className="pub-footer">
    <div className="pub-wrap pub-footer-intro"><b>{company.legalName}</b><p>NOVA ERP 用于多家公司的订单、库存、刊登、入库、财务和广告报表。卖家授权与广告授权分开完成。</p><a href={`mailto:${company.email}`}>{company.email}</a></div>
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
      <span className="pub-footer-links"><SiteLink href="/privacy">隐私政策</SiteLink><SiteLink href="/terms">服务条款</SiteLink><SiteLink href="/security">安全说明</SiteLink></span>
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

function SolutionsPage() {
  return <div className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">方案</p><h1>按公司数量选择接法</h1><p className="lx-lead">三列对照的是适合谁、包含哪些模块、要做几次授权。目录价在价格页。</p></section>
    <section className="lx-wrap lx-plans">
      <article id="single"><h2>单公司</h2><p className="lx-fit">1 个法律主体，1 到 5 个店铺</p><ul><li>订单、退货、库存、刊登、入库、财务</li><li>成员按权限查看这一家</li><li>卖家授权一次</li><li>不含广告报表</li></ul><SiteLink href="/pricing" className="lx-btn">查看目录价</SiteLink></article>
      <article id="multi" className="is-on"><h2>多公司</h2><p className="lx-fit">最多 3 个法律主体，6 到 20 个店铺</p><ul><li>单公司的全部模块</li><li>每家公司单独授权</li><li>广告只读报表</li><li>财务按币种分开</li></ul><SiteLink href="/pricing" className="lx-btn">查看目录价</SiteLink></article>
      <article id="ads"><h2>只看广告</h2><p className="lx-fit">广告账户和卖家账号不是同一家在管</p><ul><li>广告授权单独完成</li><li>查看花费、点击和广告销售额</li><li>不改预算，不改竞价</li><li>不代投放</li></ul><SiteLink href="/solutions/advertising" className="lx-btn lx-btn-line">查看广告说明</SiteLink></article>
    </section>
    <section className="lx-feature"><div className="lx-wrap"><h2>业财怎么对</h2><div className="lx-rows"><article className="lx-feature-row"><div><h3>财务月结</h3><p>收入、退款、费用按同一币种排列。退款保留原订单号和退货日期。</p><ul><li>同一币种内看净额</li><li>不把美元和日元加在一起</li><li>费用留着入账时间</li></ul></div><SiteLink href="/product/finance" className="lx-btn">查看财务说明</SiteLink></article><article className="lx-feature-row"><div><h3>多店铺分开授权</h3><p>每家公司自己的卖家账号单独授权。未授权的公司不进入可查看范围。</p><ul><li>公司、卖家账号、站点分层保存</li><li>等待审批的连接保持等待</li><li>成员只看被分配的公司</li></ul></div><SiteLink href="/product/stores" className="lx-btn">查看店铺说明</SiteLink></article></div></div></section>
  </div>
}

function AboutPage() {
  return <div className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">关于我们</p><h1>{company.legalName}</h1><p className="lx-lead">NOVA ERP 由本公司运营，用于已授权企业的多店铺经营数据。产品说明在产品页，这里只列公司登记。</p></section>
    <section className="lx-wrap lx-facts"><article><small>成立日期</small><b>{company.foundedOn}</b></article><article><small>注册资本</small><b>{company.registeredCapital}</b></article><article><small>邮箱</small><b>{company.email}</b></article></section>
    <section className="lx-feature"><div className="lx-wrap"><h2>登记信息</h2><dl className="lx-registry"><div><dt>名称</dt><dd>{company.legalName}</dd></div><div><dt>统一社会信用代码</dt><dd>{company.creditCode}</dd></div><div><dt>类型</dt><dd>{company.companyType}</dd></div><div><dt>法定代表人</dt><dd>{company.legalRepresentative}</dd></div><div><dt>住所</dt><dd>{company.address}</dd></div><div><dt>应用名称</dt><dd>{company.brand}</dd></div></dl></div></section>
    <section className="lx-feature"><div className="lx-wrap"><h2>产品介绍</h2><div className="lx-rows"><article className="lx-feature-row"><div><h3>财务与供应链</h3><p>订单、库存、入库、刊登、退货和财务，按法律主体分开查看。</p></div><SiteLink href="/product" className="lx-btn">查看产品</SiteLink></article><article className="lx-feature-row"><div><h3>广告报表</h3><p>广告账户另行授权后，查看花费、点击和广告销售额。默认只读。</p></div><SiteLink href="/solutions/advertising" className="lx-btn">查看广告说明</SiteLink></article></div></div></section>
    <section className="lx-band"><div className="lx-wrap"><h2>公开应用对应的数据范围</h2><div className="lx-feature-grid">{spApiRoles.map(role => <article key={role.code}><small>{role.code}</small><h3>{role.name}</h3><p>{role.use}</p></article>)}</div></div></section>
    <section className="lx-final"><h2>预约演示</h2><div><SiteLink href="/contact" className="lx-btn">联系团队</SiteLink></div></section>
  </div>
}

function NewsPage() {
  return <div className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">新闻</p><h1>产品边界变更</h1><p className="lx-lead">只记录已经写进网站和系统的规则，不发布客户案例。</p></section>
    <section className="lx-wrap"><ol className="lx-timeline">{press.map(item => <li key={item.title}><time>{item.date}</time><h2>{item.title}</h2><p>{item.text}</p><SiteLink href="/about">了解详情</SiteLink></li>)}</ol></section>
  </div>
}

function ResourcesPage() {
  return <div className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">资源中心</p><h1>接入前先看这几件事</h1><p className="lx-lead">下面是卖家授权、广告授权、权限和删除规则的说明。真实店铺数据只在授权完成并同步成功后进入工作台。</p></section>
    <section className="lx-wrap"><ul className="lx-res-list">{guides.map(item => <li key={item.title}><div><h2>{item.title}</h2><p>{item.text}</p></div><SiteLink href={item.href} className="lx-btn lx-btn-line">了解详情</SiteLink></li>)}</ul></section>
    <section className="lx-wrap"><div className="panel"><h2>申请里会出现的四类卖家数据</h2><ul><li><b>库存与订单跟踪</b><span>订单、库存和退货，供经营查看。</span></li><li><b>亚马逊履约</b><span>FBA 库存、入库计划和退货处置。</span></li><li><b>财务与会计</b><span>结算、费用和退款，同一币种内核对。</span></li><li><b>商品刊登</b><span>ASIN、SKU 和刊登状态，用于商品对照，不代替卖家改刊登。</span></li></ul><SiteLink href="/about">在关于页查看角色原文 →</SiteLink></div></section>
  </div>
}
const emptyContact = { name: '', company: '', email: '', phone: '', subject: 'Seller / FBA', storeBand: '1–5', message: '', consent: false, companyWebsite: '' }

function ContactForm() {
  const [form, setForm] = useState(emptyContact)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!form.consent) { Message.warning('请先阅读并同意隐私政策'); return }
    if (form.companyWebsite) { Message.success('信息已提交'); setForm(emptyContact); return }
    setBusy(true)
    try {
      const result = await apiFetch<{ reference?: string }>('/contact-requests', { method: 'POST', body: JSON.stringify({
        name: form.name,
        company: form.company,
        email: form.email,
        phone: form.phone,
        topic: form.subject,
        storeBand: form.storeBand,
        companyWebsite: form.companyWebsite,
        message: form.message,
      }) })
      Message.success(result.reference ? `信息已提交，咨询编号 ${result.reference}` : '信息已提交')
      setForm(emptyContact)
    } catch (error) { Message.error(error instanceof Error ? error.message : '提交失败，请稍后重试') }
    finally { setBusy(false) }
  }
  return <form id="contact-form" className="prod-contact-form" onSubmit={submit}>
    <div className="pub-honeypot" aria-hidden="true"><label>公司网站<input tabIndex={-1} autoComplete="off" value={form.companyWebsite} onChange={event => setForm({ ...form, companyWebsite: event.target.value })} /></label></div>
    <div className="prod-form-grid"><label>姓名<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="姓名" autoComplete="name" required /></label><label>公司名称<input value={form.company} onChange={event => setForm({ ...form, company: event.target.value })} placeholder="公司名称" autoComplete="organization" required /></label></div>
    <div className="prod-form-grid"><label>公司邮箱<input type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="name@company.com" autoComplete="email" required /></label><label>电话（选填）<input value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} placeholder="联系电话" autoComplete="tel" /></label></div>
    <div className="prod-form-grid"><label>接入范围<select value={form.subject} onChange={event => setForm({ ...form, subject: event.target.value })}><option>Seller / FBA</option><option>Amazon Ads</option><option>Seller + Ads</option><option>企业治理</option></select></label><label>店铺数量<select value={form.storeBand} onChange={event => setForm({ ...form, storeBand: event.target.value })}><option>1–5</option><option>6–20</option><option>21–100</option><option>100+</option></select></label></div>
    <label>需求说明<textarea value={form.message} maxLength={4000} onChange={event => setForm({ ...form, message: event.target.value })} placeholder="请描述企业数量、店铺规模和需要的报表。不要填写 Amazon 密码或令牌。" rows={6} required /></label>
    <p className="pub-count">{form.message.length}/4000</p>
    <div className="pub-consent"><label><input type="checkbox" checked={form.consent} onChange={event => setForm({ ...form, consent: event.target.checked })} required /> 我已阅读并同意隐私政策</label><SiteLink href="/privacy">查看隐私政策</SiteLink></div>
    <button className="prod-primary prod-submit" disabled={busy}>{busy ? '提交中…' : '提交联系信息'} <IconArrowRight /></button>
    <small>提交的信息仅用于联系，不会自动创建账号。</small>
  </form>
}

function ContactPage() {
  return <div className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">联系</p><h1>预约演示</h1><p className="lx-lead">工作日查看表单后，用邮件回复。不会自动开通账号。</p></section>
    <section className="lx-feature"><div className="lx-wrap lx-feature-grid"><div><h2>{company.legalName}</h2><p>{company.address}</p><p><a href={`mailto:${company.email}`}>{company.email}</a></p><ol className="lx-timeline"><li><b>提交表单</b><p>写明公司数量、店铺数量和要看的模块。</p></li><li><b>邮件确认</b><p>核对主体和授权范围，发出书面方案。</p></li><li><b>开通</b><p>方案确认后配置账号。网页不收款。</p></li></ol></div><ContactForm /></div></section>
  </div>
}
function PolicyPage({ title, intro, sections }: { title: string; intro: string; sections: { h: string; p: string }[] }) {
  return <article className="pub-policy"><div className="pub-wrap lx-policy">
    <div>
      <p className="pub-policy-banner">{legalBanner}</p>
      <h1>{title}</h1>
      <p className="pub-lede">{intro}</p>
      {sections.map((section, index) => <section id={`policy-${index}`} key={section.h}><h2>{section.h}</h2><p>{section.p}</p></section>)}
      <p className="pub-policy-links"><SiteLink href="/privacy">隐私政策</SiteLink><SiteLink href="/terms">服务条款</SiteLink><SiteLink href="/security">安全说明</SiteLink><SiteLink href="/contact">联系我们</SiteLink></p>
    </div>
    <nav className="lx-toc" aria-label="本页目录">{sections.map((section, index) => <a key={section.h} href={`#policy-${index}`}>{section.h}</a>)}</nav>
  </div></article>
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
  return <div className="pub-site site-public lx">
    <a className="pub-skip" href="#main">跳到主要内容</a>
    <div className="site-notice"><span>{[company.legalName, '经营数据服务', company.phone].filter(Boolean).join(' · ')}</span><SiteLink href="/contact">预约演示</SiteLink><SiteLink href="/pricing">查看服务范围</SiteLink></div>
    <Header page={page} />
    <main id="main">
      {page === 'home' && <OfficialHome />}
      {productPageBody(page)}
      {page === 'solutions' && <SolutionsPage />}
      {page === 'about' && <AboutPage />}
      {page === 'news' && <NewsPage />}
      {page === 'resources' && <ResourcesPage />}
      {page === 'contact' && <ContactPage />}
      {page === 'privacy' && <PolicyPage title="隐私政策" intro="本政策说明卖家数据、广告数据和咨询信息如何被收集、使用、存储、保护和删除。" sections={privacySections} />}
      {page === 'terms' && <PolicyPage title="服务条款" intro="费用和退款以书面方案为准。本页说明服务范围和授权责任。" sections={termsSections} />}
      {page === 'security' && <PolicyPage title="安全说明" intro="传输、凭据、权限、隔离、审计和删除按以下方式执行。" sections={securitySections} />}
      {page === 'not-found' && <NotFoundPage />}
    </main>
    <Footer />
    <SideDock />
  </div>
}

export { websitePageFromPath } from './public-site-content'
