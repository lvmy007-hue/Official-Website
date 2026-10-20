export function HeroDash() {
  const bars = [42, 68, 54, 86, 61, 78, 70]
  return <div className="lxm-dash" aria-label="演示数据看板">
    <div className="lxm-kpis">
      <article><small>订单额 · 示例</small><b>1,000.00</b><span>USD</span></article>
      <article><small>退款 · 示例</small><b>80.00</b><span>USD</span></article>
      <article><small>费用 · 示例</small><b>120.00</b><span>USD</span></article>
    </div>
    <div className="lxm-dash-grid">
      <div className="lxm-card">
        <b>同一币种里的净额</b>
        <div className="lxm-bars">{bars.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
        <small>演示数据，不是真实店铺</small>
      </div>
      <div className="lxm-card lxm-donut">
        <b>广告另算</b>
        <i />
        <span>花费 200.00 USD</span>
        <span>ACOS 23.5%</span>
        <small>未单独授权时不出现</small>
      </div>
    </div>
  </div>
}

export function InventoryPanel() {
  const rows = [
    ['示例-SKU-01', '美国站', '120', '8', '40', '2', '正常'],
    ['示例-SKU-02', '美国站', '6', '0', '0', '1', '偏低'],
    ['示例-SKU-03', '日本站', '0', '15', '80', '0', '在途'],
    ['示例-SKU-04', '德国站', '40', '2', '12', '0', '正常'],
  ]
  return <section className="lxm-panel">
    <header><b>FBA 库存</b><em>演示数据</em></header>
    <div className="lxm-stats">
      <span><small>可售</small><b>166</b></span>
      <span><small>预留</small><b>25</b></span>
      <span><small>在途</small><b>132</b></span>
      <span><small>不可售</small><b>3</b></span>
    </div>
    <table>
      <thead><tr><th>SKU</th><th>站点</th><th>可售</th><th>预留</th><th>在途</th><th>不可售</th><th>状态</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index} className={cell === '偏低' ? 'is-low' : ''}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </section>
}

export function FinancePanel() {
  return <section className="lxm-panel">
    <header><b>财务月结</b><em>演示数据</em></header>
    <div className="lxm-books">
      <article>
        <b>USD</b>
        <p><span>收入</span><strong>1,000.00</strong></p>
        <p><span>退款</span><strong>80.00</strong></p>
        <p><span>费用</span><strong>120.00</strong></p>
        <p className="is-net"><span>净额</span><strong>800.00</strong></p>
      </article>
      <article>
        <b>JPY</b>
        <p><span>收入</span><strong>186,000</strong></p>
        <p><span>退款</span><strong>9,400</strong></p>
        <p><span>费用</span><strong>21,000</strong></p>
        <p className="is-net"><span>净额</span><strong>155,600</strong></p>
      </article>
    </div>
    <p className="lxm-note">10 月入账的 80 美元退款，对回 7 月的订单。两种货币不合成一个总数。</p>
  </section>
}

export function StorePanel() {
  const companies = [
    { name: '示例公司甲', state: '已授权', sites: ['美国站 · 主店', '美国站 · 副店'] },
    { name: '示例公司乙', state: '已授权', sites: ['德国站', '英国站'] },
    { name: '示例公司丙', state: '待开通', sites: ['日本站', '尚未进入月报'] },
  ]
  return <section className="lxm-panel">
    <header><b>多店铺</b><em>演示数据</em></header>
    <div className="lxm-stores">{companies.map(company => <article key={company.name}><b>{company.name}</b><em className={company.state === '待开通' ? 'is-wait' : ''}>{company.state}</em>{company.sites.map(site => <span key={site}>{site}</span>)}</article>)}</div>
    <p className="lxm-note">待授权的公司不进入订单和财务。</p>
  </section>
}

export function AdsPanel() {
  return <section className="lxm-panel">
    <header><b>广告报表</b><em>演示数据</em></header>
    <div className="lxm-funnel">
      <span><small>展示</small><b>12,400</b></span>
      <span><small>点击</small><b>140</b></span>
      <span><small>花费</small><b>200.00</b></span>
      <span><small>广告销售额</small><b>850.00</b></span>
    </div>
    <table>
      <thead><tr><th>活动</th><th>类型</th><th>花费</th><th>点击</th><th>销售额</th><th>ACOS</th></tr></thead>
      <tbody>
        <tr><td>示例活动-品牌词</td><td>SP</td><td>120.00</td><td>86</td><td>640.00</td><td>18.8%</td></tr>
        <tr><td>示例活动-自动</td><td>SP</td><td>80.00</td><td>54</td><td>210.00</td><td>38.1%</td></tr>
      </tbody>
    </table>
    <p className="lxm-note">只读。不改出价，不代投放。未授权的账户没有这些数字。</p>
  </section>
}

export function ListingPanel() {
  return <section className="lxm-panel">
    <header><b>商品刊登</b><em>演示数据</em></header>
    <table>
      <thead><tr><th>ASIN</th><th>SKU</th><th>FNSKU</th><th>站点</th><th>状态</th></tr></thead>
      <tbody>
        <tr><td>示例-ASIN-01</td><td>示例-SKU-01</td><td>示例-FN-01</td><td>美国站</td><td>在售</td></tr>
        <tr><td>示例-ASIN-02</td><td>示例-SKU-02</td><td>示例-FN-02</td><td>德国站</td><td>未完成</td></tr>
      </tbody>
    </table>
    <p className="lxm-note">只做对照。不代替卖家修改刊登。</p>
  </section>
}

export function InboundPanel() {
  return <section className="lxm-panel">
    <header><b>FBA 入库</b><em>演示数据</em></header>
    <table>
      <thead><tr><th>计划</th><th>站点</th><th>货件</th><th>应收</th><th>已收</th></tr></thead>
      <tbody>
        <tr><td>示例计划 A</td><td>美国站</td><td>待同步</td><td>200</td><td>—</td></tr>
        <tr><td>示例计划 B</td><td>美国站</td><td>示例货件</td><td>80</td><td>以同步结果为准</td></tr>
      </tbody>
    </table>
    <p className="lxm-note">没有卖家授权时，不能创建计划。</p>
  </section>
}

export function OrderPanel() {
  return <section className="lxm-panel">
    <header><b>订单</b><em>演示数据</em></header>
    <table>
      <thead><tr><th>订单</th><th>店铺</th><th>站点</th><th>购买日</th><th>金额</th><th>状态</th></tr></thead>
      <tbody>
        <tr><td>示例-1001</td><td>主店</td><td>美国站</td><td>2026-09-02</td><td>42.00 USD</td><td>已发货</td></tr>
        <tr><td>示例-1002</td><td>副店</td><td>德国站</td><td>2026-09-18</td><td>19.80 EUR</td><td>未发货</td></tr>
      </tbody>
    </table>
  </section>
}

const panels = {
  '/product/inventory': InventoryPanel,
  '/product/inbound': InboundPanel,
  '/product/listings': ListingPanel,
  '/product/orders': OrderPanel,
  '/product/returns': FinancePanel,
  '/product/finance': FinancePanel,
  '/product/stores': StorePanel,
  '/product/permissions': StorePanel,
  '/product/advertising': AdsPanel,
  '/solutions/advertising': AdsPanel,
}

export function panelFor(href: string) {
  const Panel = panels[href as keyof typeof panels] ?? StorePanel
  return <Panel />
}
