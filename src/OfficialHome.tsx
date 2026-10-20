import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { SiteLink } from './site-link'
import { CoreIcon } from './core-icon'
import { AdsPanel, FinancePanel, HeroDash, InventoryPanel, StorePanel } from './lx-panels'
import { homeHero, returnMatrix, scenarios } from './public-site-content'
import './lx-home.css'
import { company } from './site-company'
import { featureChapters, reasons } from './site-commercial'
import { permissionRows } from './public-product-content'

export function DemoFrame({ children }: { children: ReactNode }) {
  return <div className="site-demo"><span className="site-demo-badge">演示数据</span>{children}</div>
}

export function ReturnMatrixFigure() {
  return <div className="site-matrix"><table><caption>原订单月与退款月</caption><thead><tr><th>原订单月</th>{returnMatrix.refundMonths.map(month => <th key={month}>{month}</th>)}</tr></thead><tbody>{returnMatrix.orderMonths.map((month, row) => <tr key={month}><th>{month}</th>{returnMatrix.counts[row].map((count, column) => <td key={returnMatrix.refundMonths[column]}>{count}</td>)}</tr>)}</tbody></table></div>
}

export function PermissionFigure() {
  return <table className="site-perms"><caption>权限码</caption><tbody>{permissionRows.slice(0, 4).map(row => <tr key={row[0]}><th>{row[0]}</th><td>{row[1]}</td></tr>)}</tbody></table>
}

const coreCards = [
  { title: '进销存一体管理', text: '库存、入库、刊登和订单挂在同一家公司的卖家账号上。', href: '/product/inventory', icon: 'FBA 库存' },
  { title: '财务精准管理', text: '收入、退款、费用按同一币种排列，退款可以对回原来的订单月。', href: '/product/finance', icon: '财务' },
  { title: '多维度数据报表', text: '订单、退款和费用放在同一家店上对照，不同币种不相加。', href: '/product/finance', icon: '退货月结' },
  { title: '广告报表', text: '广告账户单独授权后查看花费、点击和广告销售额。只读。', href: '/product/advertising', icon: '广告' },
  { title: '订单与退货', text: '购买日、状态和币种留在这家店。退款保留原订单号。', href: '/product/orders', icon: '订单' },
  { title: '商品刊登', text: 'ASIN、SKU 和刊登状态用来对照订单和库存，不代替卖家改刊登。', href: '/product/listings', icon: '商品刊登' },
  { title: '成员权限', text: '运营、财务、广告各看各的公司。登录不等于能看每一家。', href: '/product/permissions', icon: '团队权限' },
  { title: 'FBA 入库', text: '先有卖家授权才能建计划。货件号和接收数量来自同步结果。', href: '/product/inbound', icon: 'FBA 入库' },
]

function chapterStage(title: string) {
  if (title.startsWith('进销存')) return <InventoryPanel />
  if (title.startsWith('财务')) return <FinancePanel />
  if (title.startsWith('广告')) return <AdsPanel />
  return <StorePanel />
}

function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setShown(true) }, { threshold: 0.16 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} className={`lx-reveal${shown ? ' is-in' : ''} ${className}`}>{children}</div>
}

export function OfficialHome() {
  return <div className="lx-page">
    <section className="lx-hero">
      <div className="lx-hero-copy">
        <h1><span>多家公司一起经营时</span><em>多店铺，分开看清</em></h1>
        <p className="lx-hero-lead">{homeHero.lede}</p>
        <div className="lx-hero-actions"><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/resources" className="lx-btn lx-btn-line">查看接入说明</SiteLink></div>
        <p className="lx-hero-source">{company.legalName} · {company.email} · 右侧为演示数据</p>
      </div>
      <Reveal><HeroDash /></Reveal>
    </section>

    <section className="lx-core-block">
      <div className="lx-wrap">
        <div className="lx-core-head"><h2>核心功能</h2><p>订单、库存、财务和广告报表按法律主体分开。广告要再授权一次。</p></div>
        <div className="lx-core-grid">{coreCards.map(card => <SiteLink key={card.title} href={card.href} className="lx-core-card"><CoreIcon name={card.icon} /><b>{card.title}</b><span>{card.text}</span></SiteLink>)}</div>
      </div>
    </section>

    {featureChapters.map((chapter, index) => <section key={chapter.title} className={`lxm-block${index % 2 ? ' is-muted' : ''}`}>
      <div className="lx-wrap">
        <div className="lxm-copy">
          <h2>{chapter.title}</h2>
          <p>{chapter.lede}</p>
        </div>
        <div className="lxm-points">{chapter.points.map(point => <article key={point.title}><b>{point.title}</b><span>{point.text}</span></article>)}</div>
        <div className="lxm-actions"><SiteLink href={chapter.href} className="lx-btn">{chapter.cta}</SiteLink><SiteLink href="/contact" className="lx-btn lx-btn-line">预约演示</SiteLink></div>
        <Reveal>{chapterStage(chapter.title)}</Reveal>
      </div>
    </section>)}

    <section className="lx-band"><div className="lx-wrap"><div className="lx-core-head"><h2>为什么按公司分开</h2><p>查询带法律主体。未授权的公司不会出现在报表里。</p></div><div className="lx-reasons">{reasons.map(item => <article key={item.title}><h3>{item.title}</h3>{item.lines.map(line => <p key={line}>{line}</p>)}<strong>{item.num}</strong><small>{item.tip}</small></article>)}</div></div></section>

    <section className="lxm-block"><div className="lx-wrap"><div className="lx-core-head"><h2>三种开通范围</h2><p>按公司数量和要不要广告报表来选。目录价在价格页。</p></div><div className="lx-cases">{scenarios.slice(0, 3).map(item => <article key={item.title}><div className="lx-case-cover">{item.title}</div><div><strong>{item.title}</strong><p>{item.text}</p><SiteLink href={item.href}>查看说明</SiteLink></div></article>)}</div></div></section>

    <section className="lx-band"><div className="lx-wrap"><div className="lx-core-head"><h2>公司与数据范围</h2><p>{company.legalName}运营 NOVA ERP。数据范围以关于页和隐私政策为准。</p></div><div className="lx-core-grid lx-fact-grid"><article className="lx-core-card"><b>{company.legalName}</b><span>统一社会信用代码 {company.creditCode}。住所在许昌市魏都区。</span></article><article className="lx-core-card"><b>{company.email}</b><span>工作日回复预约。网页不收款。</span></article><article className="lx-core-card"><b>四类卖家数据</b><span>库存与订单跟踪、亚马逊履约、财务与会计、商品刊登。</span></article><article className="lx-core-card"><b>广告只读</b><span>广告账户另行授权。不改出价，不代投放。</span></article></div></div></section>

    <section className="lx-final"><h2>先约一次演示，再确认开通范围</h2><p>{company.legalName} · {company.address}</p><div><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/pricing" className="lx-btn lx-btn-line">查看目录价</SiteLink></div></section>
  </div>
}
