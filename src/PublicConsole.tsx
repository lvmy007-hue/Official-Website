import { useState } from 'react'
import { SiteLink } from './site-link'
import type { PublicPage } from './public-site-content'

export type ConsoleModule = 'overview' | 'stores' | 'orders' | 'returns' | 'inventory' | 'finance' | 'ads' | 'members'

const nav: { id: ConsoleModule; label: string; href: string }[] = [
  { id: 'overview', label: '经营概览', href: '/' },
  { id: 'stores', label: '多店铺', href: '/product/stores' },
  { id: 'orders', label: '订单', href: '/product/orders' },
  { id: 'returns', label: '退货', href: '/product/returns' },
  { id: 'inventory', label: '库存', href: '/product#inventory' },
  { id: 'finance', label: '财务', href: '/product/finance' },
  { id: 'ads', label: '广告', href: '/solutions/advertising' },
  { id: 'members', label: '成员权限', href: '/product/permissions' },
]

export function consoleModuleForPage(page: PublicPage): ConsoleModule | null {
  if (page === 'home' || page === 'product') return 'overview'
  if (page === 'product-stores') return 'stores'
  if (page === 'product-orders') return 'orders'
  if (page === 'product-returns') return 'returns'
  if (page === 'product-finance') return 'finance'
  if (page === 'product-advertising' || page === 'solutions-advertising') return 'ads'
  if (page === 'product-permissions') return 'members'
  return null
}

function Topbar({ title }: { title: string }) {
  return <div className="appc-top">
    <div><b>{title}</b><span>示例集团 · 全部公司</span></div>
    <div className="appc-filters">
      <span>2026-09-01 至 2026-09-30</span>
      <span>USD / JPY 分列</span>
      <em>示例数据</em>
    </div>
  </div>
}

function Overview() {
  return <>
    <Topbar title="经营概览" />
    <div className="appc-kpis">
      <div><small>订单额</small><b>$128,400</b><span>USD · 店铺 A</span></div>
      <div><small>退款</small><b>$6,240</b><span>当月 62% · 跨月 38%</span></div>
      <div><small>平台费用</small><b>$9,180</b><span>不含广告花费</span></div>
      <div><small>广告花费</small><b>$4,860</b><span>ACOS 23.5%</span></div>
    </div>
    <div className="appc-split">
      <section>
        <header><b>最近订单</b><SiteLink href="/product/orders">全部订单</SiteLink></header>
        <table>
          <thead><tr><th>订单</th><th>店铺</th><th>购买日</th><th>状态</th><th>金额</th></tr></thead>
          <tbody>
            <tr><td>示例-10021</td><td>店铺 A · US</td><td>09-02</td><td>已发货</td><td>USD 42.00</td></tr>
            <tr><td>示例-10058</td><td>店铺 A · US</td><td>09-18</td><td>已发货</td><td>USD 26.50</td></tr>
            <tr><td>示例-10077</td><td>店铺 B · JP</td><td>09-21</td><td>待发货</td><td>JPY 3,280</td></tr>
            <tr><td>示例-10091</td><td>店铺 A · US</td><td>09-27</td><td>已发货</td><td>USD 19.90</td></tr>
          </tbody>
        </table>
      </section>
      <section>
        <header><b>广告活动</b><SiteLink href="/solutions/advertising">广告报表</SiteLink></header>
        <table>
          <thead><tr><th>活动</th><th>类型</th><th>花费</th><th>ACOS</th></tr></thead>
          <tbody>
            <tr><td>品牌词</td><td>SP</td><td>120.00</td><td>18.8%</td></tr>
            <tr><td>自动投放</td><td>SP</td><td>80.00</td><td>38.1%</td></tr>
            <tr><td>品牌旗舰</td><td>SB</td><td>60.00</td><td>42.9%</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  </>
}

function Stores() {
  return <>
    <Topbar title="多店铺" />
    <div className="appc-tabs"><b>全部 3</b><span>已连接 2</span><span>待授权 1</span></div>
    <table className="appc-full">
      <thead><tr><th>公司</th><th>店铺</th><th>站点</th><th>卖家账号</th><th>授权</th><th>最近同步</th><th>成员</th></tr></thead>
      <tbody>
        <tr><td>示例公司甲</td><td>店铺 A</td><td>Amazon.com</td><td>示例-A01</td><td className="ok">已连接</td><td>09-30 18:20</td><td>运营、财务</td></tr>
        <tr><td>示例公司乙</td><td>店铺 B</td><td>Amazon.co.jp</td><td>示例-B02</td><td className="ok">已连接</td><td>09-30 18:12</td><td>运营</td></tr>
        <tr><td>示例公司丙</td><td>店铺 C</td><td>Amazon.de</td><td>—</td><td className="wait">待授权</td><td>—</td><td>—</td></tr>
      </tbody>
    </table>
  </>
}

function Orders() {
  const [tab, setTab] = useState('全部')
  const rows = [
    ['示例-10021', '店铺 A', 'Amazon.com', '2026-09-02', '已发货', 'USD', '42.00'],
    ['示例-10058', '店铺 A', 'Amazon.com', '2026-09-18', '已发货', 'USD', '26.50'],
    ['示例-10077', '店铺 B', 'Amazon.co.jp', '2026-09-21', '待发货', 'JPY', '3,280'],
    ['示例-10091', '店铺 A', 'Amazon.com', '2026-09-27', '已发货', 'USD', '19.90'],
  ].filter(row => tab === '全部' || row[4] === tab)
  return <>
    <Topbar title="订单" />
    <div className="appc-tabs">
      {['全部', '待发货', '已发货'].map(item => <button key={item} className={tab === item ? 'on' : ''} onClick={() => setTab(item)}>{item}</button>)}
    </div>
    <table className="appc-full">
      <thead><tr><th>订单</th><th>店铺</th><th>站点</th><th>购买日</th><th>状态</th><th>币种</th><th>金额</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </>
}

function Returns() {
  const [picked, setPicked] = useState('09 月订单 · 10 月退款 · 1 笔')
  return <>
    <Topbar title="退货" />
    <div className="appc-split">
      <section>
        <header><b>原订单月 × 退款月</b></header>
        <table>
          <thead><tr><th>原订单月</th><th>08</th><th>09</th><th>10</th></tr></thead>
          <tbody>
            <tr><th>07</th><td><button onClick={() => setPicked('07 月订单 · 08 月退款 · 3 笔')}>3</button></td><td><button onClick={() => setPicked('07 月订单 · 09 月退款 · 1 笔')}>1</button></td><td><button onClick={() => setPicked('07 月订单 · 10 月退款 · 0 笔')}>0</button></td></tr>
            <tr><th>08</th><td>0</td><td><button onClick={() => setPicked('08 月订单 · 09 月退款 · 4 笔')}>4</button></td><td><button onClick={() => setPicked('08 月订单 · 10 月退款 · 2 笔')}>2</button></td></tr>
            <tr><th>09</th><td>0</td><td>0</td><td><button onClick={() => setPicked('09 月订单 · 10 月退款 · 1 笔')}>1</button></td></tr>
          </tbody>
        </table>
      </section>
      <section>
        <header><b>{picked}</b></header>
        <table>
          <thead><tr><th>订单</th><th>退款日</th><th>金额</th><th>库存</th></tr></thead>
          <tbody>
            <tr><td>示例-10021</td><td>10-03</td><td>USD 42.00</td><td>未入库</td></tr>
            <tr><td>示例-10040</td><td>09-11</td><td>USD 15.00</td><td>已入可售</td></tr>
          </tbody>
        </table>
        <p className="appc-note">退款记录不等于货物已经退回仓库。</p>
      </section>
    </div>
  </>
}

function Inventory() {
  return <>
    <Topbar title="库存" />
    <table className="appc-full">
      <thead><tr><th>SKU</th><th>店铺</th><th>可售</th><th>在途</th><th>预留</th><th>更新时间</th></tr></thead>
      <tbody>
        <tr><td>示例-SKU-01</td><td>店铺 A · US</td><td>240</td><td>80</td><td>12</td><td>09-30 18:20</td></tr>
        <tr><td>示例-SKU-02</td><td>店铺 A · US</td><td>36</td><td>0</td><td>4</td><td>09-30 18:20</td></tr>
        <tr><td>示例-SKU-03</td><td>店铺 B · JP</td><td>120</td><td>40</td><td>0</td><td>09-30 18:12</td></tr>
      </tbody>
    </table>
  </>
}

function Finance() {
  const [cur, setCur] = useState('USD')
  const rows = cur === 'USD'
    ? [['店铺 A', 'USD', '12,480.00', '860.00', '1,240.00', '10,380.00']]
    : [['店铺 B', 'JPY', '186,000', '9,400', '21,000', '155,600']]
  return <>
    <Topbar title="财务" />
    <div className="appc-tabs">
      {['USD', 'JPY'].map(item => <button key={item} className={cur === item ? 'on' : ''} onClick={() => setCur(item)}>{item}</button>)}
    </div>
    <table className="appc-full">
      <thead><tr><th>店铺</th><th>币种</th><th>收入</th><th>退款</th><th>平台费用</th><th>净额</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
    <p className="appc-note">两种货币不合成一个总数。广告花费在广告页单独看。</p>
  </>
}

function Ads() {
  const [type, setType] = useState('全部')
  const rows = [
    ['品牌词', 'SP', '启用', '120.00', '86', '640.00', '18.8%', '5.33'],
    ['自动投放', 'SP', '启用', '80.00', '54', '210.00', '38.1%', '2.63'],
    ['品牌旗舰', 'SB', '启用', '60.00', '22', '140.00', '42.9%', '1.33'],
  ].filter(row => type === '全部' || row[1] === type)
  return <>
    <Topbar title="广告报表" />
    <div className="appc-tabs">
      <span>账户 示例-1001 · 北美 · USD</span>
      {['全部', 'SP', 'SB'].map(item => <button key={item} className={type === item ? 'on' : ''} onClick={() => setType(item)}>{item}</button>)}
    </div>
    <table className="appc-full">
      <thead><tr><th>活动</th><th>类型</th><th>状态</th><th>花费</th><th>点击</th><th>广告销售额</th><th>ACOS</th><th>ROAS</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
    </table>
    <p className="appc-note">广告账户单独授权。默认只读，不修改竞价。数据截止 2026-10-19。</p>
  </>
}

function Members() {
  return <>
    <Topbar title="成员权限" />
    <table className="appc-full">
      <thead><tr><th>成员</th><th>角色</th><th>公司范围</th><th>订单</th><th>财务</th><th>广告</th><th>连接管理</th></tr></thead>
      <tbody>
        <tr><td>示例-运营</td><td>运营</td><td>公司甲</td><td>可看</td><td>—</td><td>可看</td><td>—</td></tr>
        <tr><td>示例-财务</td><td>财务</td><td>公司甲、乙</td><td>可看</td><td>可看</td><td>—</td><td>—</td></tr>
        <tr><td>示例-管理员</td><td>管理员</td><td>全部公司</td><td>可看</td><td>可看</td><td>可看</td><td>可管</td></tr>
      </tbody>
    </table>
  </>
}

export function PublicConsole({ module }: { module: ConsoleModule }) {
  return <div className="appc">
    <aside>
      <div className="appc-brand">NOVA ERP<small>示例数据</small></div>
      {nav.map(item => <SiteLink key={item.id} href={item.href} className={item.id === module ? 'on' : ''}>{item.label}</SiteLink>)}
    </aside>
    <div className="appc-main">
      {module === 'overview' && <Overview />}
      {module === 'stores' && <Stores />}
      {module === 'orders' && <Orders />}
      {module === 'returns' && <Returns />}
      {module === 'inventory' && <Inventory />}
      {module === 'finance' && <Finance />}
      {module === 'ads' && <Ads />}
      {module === 'members' && <Members />}
    </div>
  </div>
}
