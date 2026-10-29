import type { ReactNode } from 'react'
import { SiteLink } from './site-link'
import { HeroDash } from './lx-panels'
import { CoreGrid, HeroStage, ModuleSwitcher, ReasonCards } from './lx-sections'
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
  { title: '跨月退货', text: '本月入账的退款对回原订单月，不算进新销售。', href: '/product/returns', icon: '退货月结' },
  { title: '广告报表', text: '广告账户单独授权后查看花费、点击和广告销售额。只读。', href: '/product/advertising', icon: '广告' },
  { title: '订单', text: '购买日、状态和币种留在这家店。买家信息发货后 30 日内删除。', href: '/product/orders', icon: '订单' },
  { title: '商品刊登', text: 'ASIN、SKU 和刊登状态用来对照订单和库存，不代替卖家改刊登。', href: '/product/listings', icon: '商品刊登' },
  { title: '成员权限', text: '运营、财务、广告各看各的公司。登录不等于能看每一家。', href: '/product/permissions', icon: '团队权限' },
  { title: 'FBA 入库', text: '先有卖家授权才能建计划。货件号和接收数量来自同步结果。', href: '/product/inbound', icon: 'FBA 入库' },
]

const heroScenes = [
  { label: '经营看板', panel: 'dash' as const, render: () => <HeroDash /> },
  { label: '多店铺', panel: 'stores' as const },
  { label: '广告报表', panel: 'ads' as const },
]

export function OfficialHome() {
  return <div className="lx-page">
    <section className="lx-hero">
      <div className="lx-hero-copy">
        <h1><span>多家公司一起经营时</span><em>多店铺，分开看清</em></h1>
        <p className="lx-hero-lead">{homeHero.lede}</p>
        <div className="lx-hero-actions"><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/pricing" className="lx-btn lx-btn-line">查看目录价</SiteLink></div>
        <ul className="lx-hero-ticks"><li>卖家授权与广告授权分开</li><li>财务只在同一币种里对账</li><li>广告报表只读</li></ul>
        <p className="lx-hero-source">{company.legalName} · 右侧为演示数据</p>
      </div>
      <HeroStage scenes={heroScenes} lang="zh" />
    </section>

    <CoreGrid title="核心功能" lede="订单、库存、财务和广告报表按法律主体分开。广告要再授权一次。" cards={coreCards} />

    {featureChapters.map((chapter, index) => <ModuleSwitcher key={chapter.title} chapter={chapter} lang="zh" flip={index % 2 === 1} muted={index % 2 === 1} demoLabel="预约演示" />)}

    <ReasonCards title="为什么按公司分开" lede="查询带法律主体。未授权的公司不会出现在报表里。" items={reasons} />

    <section className="lxm-block"><div className="lx-wrap"><div className="lx-core-head"><h2>三种开通范围</h2><p>按公司数量和要不要广告报表来选。目录价在价格页。</p></div><div className="lx-cases">{scenarios.slice(0, 3).map(item => <article key={item.title}><div className="lx-case-cover">{item.title}</div><div><strong>{item.title}</strong><p>{item.text}</p><SiteLink href={item.href}>查看说明</SiteLink></div></article>)}</div></div></section>

    <section className="lx-band"><div className="lx-wrap"><div className="lx-core-head"><h2>公司与数据范围</h2><p>{company.legalName}运营 NOVA ERP。数据范围以关于页和隐私政策为准。</p></div><div className="lx-core-grid lx-fact-grid"><article className="lx-core-card"><b>{company.legalName}</b><span>统一社会信用代码 {company.creditCode}。住所在许昌市魏都区。</span></article><article className="lx-core-card"><b>{company.email}</b><span>工作日回复预约。网页不收款。</span></article><article className="lx-core-card"><b>四类卖家数据</b><span>库存与订单跟踪、亚马逊履约、财务与会计、商品刊登。</span></article><article className="lx-core-card"><b>广告只读</b><span>广告账户另行授权。不改出价，不代投放。</span></article></div></div></section>

    <section className="lx-final"><h2>先约一次演示，再确认开通范围</h2><p>{company.legalName} · {company.address}</p><div><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/pricing" className="lx-btn lx-btn-line">查看目录价</SiteLink></div></section>
  </div>
}
