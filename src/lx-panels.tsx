import { CountUp } from './lx-motion'

export type Lang = 'zh' | 'en'

const demo = { zh: '演示数据', en: 'Sample data' }

function Head({ lang, zh, en }: { lang: Lang; zh: string; en: string }) {
  return <header><b>{lang === 'en' ? en : zh}</b><em>{demo[lang]}</em></header>
}

function Note({ lang, zh, en }: { lang: Lang; zh: string; en: string }) {
  return <p className="lxm-note">{lang === 'en' ? en : zh}</p>
}

function Table({ head, rows, low, lang = 'zh' }: { head: string[]; rows: string[][]; low?: string[]; lang?: Lang }) {
  const label = (cell: string) => lang === 'zh' ? cell.replace(/^SAMPLE-/, '示例-') : cell
  return <table>
    <thead><tr>{head.map(cell => <th key={cell}>{cell}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index} className={low?.includes(cell) ? 'is-low' : ''}>{label(cell)}</td>)}</tr>)}</tbody>
  </table>
}

export function HeroDash({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const bars = [42, 68, 54, 86, 61, 78, 70]
  return <div className="lxm-dash" aria-label={en ? 'Sample dashboard' : '演示数据看板'}>
    <div className="lxm-kpis">
      <article><small>{en ? 'Order value · sample' : '订单额 · 示例'}</small><b><CountUp value="1,000.00" /></b><span>USD</span></article>
      <article><small>{en ? 'Refunds · sample' : '退款 · 示例'}</small><b><CountUp value="80.00" /></b><span>USD</span></article>
      <article><small>{en ? 'Fees · sample' : '费用 · 示例'}</small><b><CountUp value="120.00" /></b><span>USD</span></article>
    </div>
    <div className="lxm-dash-grid">
      <div className="lxm-card">
        <b>{en ? 'Net within one currency' : '同一币种里的净额'}</b>
        <div className="lxm-bars">{bars.map((height, index) => <i key={index} style={{ height: `${height}%`, animationDelay: `${index * 70}ms` }} />)}</div>
        <small>{en ? 'Sample data, not a real store' : '演示数据，不是真实店铺'}</small>
      </div>
      <div className="lxm-card lxm-donut">
        <b>{en ? 'Ads kept separate' : '广告另算'}</b>
        <i />
        <span>{en ? 'Spend 200.00 USD' : '花费 200.00 USD'}</span>
        <span>ACOS 23.5%</span>
        <small>{en ? 'Hidden until the ads account is authorized' : '未单独授权时不出现'}</small>
      </div>
    </div>
  </div>
}

export function InventoryPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const site = (zh: string, e: string) => en ? e : zh
  const low = en ? 'Low' : '偏低'
  return <section className="lxm-panel">
    <Head lang={lang} zh="FBA 库存" en="FBA inventory" />
    <div className="lxm-stats">
      <span><small>{en ? 'Sellable' : '可售'}</small><b><CountUp value="166" /></b></span>
      <span><small>{en ? 'Reserved' : '预留'}</small><b><CountUp value="25" /></b></span>
      <span><small>{en ? 'Inbound' : '在途'}</small><b><CountUp value="132" /></b></span>
      <span><small>{en ? 'Unfulfillable' : '不可售'}</small><b><CountUp value="3" /></b></span>
    </div>
    <Table
      head={en ? ['SKU', 'Marketplace', 'Sellable', 'Reserved', 'Inbound', 'Unfulfillable', 'Status'] : ['SKU', '站点', '可售', '预留', '在途', '不可售', '状态']}
      rows={[
        ['SAMPLE-SKU-01', site('美国站', 'US'), '120', '8', '40', '2', en ? 'Normal' : '正常'],
        ['SAMPLE-SKU-02', site('美国站', 'US'), '6', '0', '0', '1', low],
        ['SAMPLE-SKU-03', site('日本站', 'JP'), '0', '15', '80', '0', en ? 'Inbound' : '在途'],
        ['SAMPLE-SKU-04', site('德国站', 'DE'), '40', '2', '12', '0', en ? 'Normal' : '正常'],
      ]}
      low={[low]}
      lang={lang}
    />
  </section>
}

export function InboundPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <section className="lxm-panel">
    <Head lang={lang} zh="FBA 入库" en="FBA inbound" />
    <Table
      head={en ? ['Plan', 'Marketplace', 'Shipment', 'Expected', 'Received'] : ['计划', '站点', '货件', '应收', '已收']}
      rows={[
        [en ? 'Sample plan A' : '示例计划 A', en ? 'US' : '美国站', en ? 'Awaiting sync' : '待同步', '200', '—'],
        [en ? 'Sample plan B' : '示例计划 B', en ? 'US' : '美国站', en ? 'Sample shipment' : '示例货件', '80', en ? 'From sync result' : '以同步结果为准'],
      ]}
    />
    <Note lang={lang} zh="没有卖家授权时，不能创建计划。货件号不编造。" en="A plan cannot be created before seller authorization. Shipment IDs are never invented." />
  </section>
}

export function ListingPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <section className="lxm-panel">
    <Head lang={lang} zh="商品刊登" en="Product listings" />
    <Table
      head={['ASIN', 'SKU', 'FNSKU', en ? 'Marketplace' : '站点', en ? 'Status' : '状态']}
      rows={[
        ['SAMPLE-ASIN-01', 'SAMPLE-SKU-01', 'SAMPLE-FN-01', en ? 'US' : '美国站', en ? 'Active' : '在售'],
        ['SAMPLE-ASIN-02', 'SAMPLE-SKU-02', 'SAMPLE-FN-02', en ? 'DE' : '德国站', en ? 'Incomplete' : '未完成'],
      ]}
      lang={lang}
    />
    <Note lang={lang} zh="只做对照，不代替卖家修改刊登。" en="Read for matching only. Listings are not edited on the seller's behalf." />
  </section>
}

export function OrderPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <section className="lxm-panel">
    <Head lang={lang} zh="订单" en="Orders" />
    <Table
      head={en ? ['Order', 'Store', 'Marketplace', 'Purchased', 'Amount', 'Status'] : ['订单', '店铺', '站点', '购买日', '金额', '状态']}
      rows={[
        ['SAMPLE-1001', en ? 'Main' : '主店', en ? 'US' : '美国站', '2026-09-02', '42.00 USD', en ? 'Shipped' : '已发货'],
        ['SAMPLE-1002', en ? 'Second' : '副店', en ? 'DE' : '德国站', '2026-09-18', '19.80 EUR', en ? 'Unshipped' : '未发货'],
      ]}
      lang={lang}
    />
    <Note lang={lang} zh="买家姓名和地址加密保存，发货后 30 日内删除。" en="Buyer name and address are encrypted and deleted within 30 days after shipment." />
  </section>
}

export function FinancePanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const book = (code: string, values: string[]) => <article>
    <b>{code}</b>
    <p><span>{en ? 'Revenue' : '收入'}</span><strong>{values[0]}</strong></p>
    <p><span>{en ? 'Refunds' : '退款'}</span><strong>{values[1]}</strong></p>
    <p><span>{en ? 'Fees' : '费用'}</span><strong>{values[2]}</strong></p>
    <p className="is-net"><span>{en ? 'Net' : '净额'}</span><strong>{values[3]}</strong></p>
  </article>
  return <section className="lxm-panel">
    <Head lang={lang} zh="财务月结" en="Monthly close" />
    <div className="lxm-books">{book('USD', ['1,000.00', '80.00', '120.00', '800.00'])}{book('JPY', ['186,000', '9,400', '21,000', '155,600'])}</div>
    <Note lang={lang} zh="两种货币不合成一个总数。" en="The two currencies are never added into one total." />
  </section>
}

export function ReturnsPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const months = ['2026-08', '2026-09', '2026-10']
  const rows = [['2026-07', '3', '1', '0'], ['2026-08', '0', '4', '2'], ['2026-09', '0', '0', '1']]
  return <section className="lxm-panel">
    <Head lang={lang} zh="退款对回原订单月" en="Refunds traced to order month" />
    <Table head={[en ? 'Order month' : '原订单月', ...months.map(month => `${en ? 'Refund' : '退款'} ${month}`)]} rows={rows} />
    <Note lang={lang} zh="10 月入账的退款，对回 7 月的订单，不算进 10 月新销售。" en="An October refund is matched to its July order and is not counted against October sales." />
  </section>
}

export function FeesPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <section className="lxm-panel">
    <Head lang={lang} zh="费用事件" en="Fee events" />
    <Table
      head={en ? ['Fee type', 'Amount', 'Currency', 'Posted', 'Settlement'] : ['费用类型', '金额', '币种', '入账时间', '结算编号']}
      rows={[
        ['FBAPerUnitFulfillmentFee', '3.20', 'USD', '2026-09-03', 'SAMPLE-STL-01'],
        ['Commission', '6.30', 'USD', '2026-09-03', 'SAMPLE-STL-01'],
        ['StorageFee', '12.40', 'USD', '2026-09-15', 'SAMPLE-STL-02'],
      ]}
      lang={lang}
    />
    <Note lang={lang} zh="费用保留入账时间和结算编号，方便和结算报告对账。" en="Each fee keeps its posted date and settlement ID for reconciliation." />
  </section>
}

export function StorePanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const companies = [
    { name: en ? 'Sample company A' : '示例公司甲', state: en ? 'Authorized' : '已授权', wait: false, sites: en ? ['US · main store', 'US · second store'] : ['美国站 · 主店', '美国站 · 副店'] },
    { name: en ? 'Sample company B' : '示例公司乙', state: en ? 'Authorized' : '已授权', wait: false, sites: en ? ['DE', 'UK'] : ['德国站', '英国站'] },
    { name: en ? 'Sample company C' : '示例公司丙', state: en ? 'Pending' : '待开通', wait: true, sites: en ? ['JP', 'Not in monthly report yet'] : ['日本站', '尚未进入月报'] },
  ]
  return <section className="lxm-panel">
    <Head lang={lang} zh="多店铺" en="Multiple stores" />
    <div className="lxm-stores">{companies.map(item => <article key={item.name}><b>{item.name}</b><em className={item.wait ? 'is-wait' : ''}>{item.state}</em>{item.sites.map(siteName => <span key={siteName}>{siteName}</span>)}</article>)}</div>
    <Note lang={lang} zh="待授权的公司不进入订单和财务。" en="A company that has not authorized stays out of orders and finance." />
  </section>
}

export function ConnectionPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const pending = en ? 'Awaiting approval' : '等待审批'
  return <section className="lxm-panel">
    <Head lang={lang} zh="授权连接" en="Connections" />
    <Table
      head={en ? ['Company', 'Connection', 'State', 'Last successful sync'] : ['公司', '连接', '状态', '最近成功同步']}
      rows={[
        [en ? 'Sample company A' : '示例公司甲', 'Selling Partner', en ? 'Authorized' : '已授权', '2026-10-19 09:00'],
        [en ? 'Sample company B' : '示例公司乙', 'Selling Partner', en ? 'Authorized' : '已授权', '2026-10-19 08:40'],
        [en ? 'Sample company C' : '示例公司丙', 'Selling Partner', pending, '—'],
      ]}
      low={[pending]}
    />
    <Note lang={lang} zh="等待审批的连接保持等待，不显示成已经同步。" en="A pending connection stays pending and is never shown as synced." />
  </section>
}

export function PermissionPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const yes = en ? 'View' : '可看'
  const no = '—'
  return <section className="lxm-panel">
    <Head lang={lang} zh="成员与公司" en="Members and companies" />
    <Table
      head={en ? ['Member', 'Role', 'Company A', 'Company B', 'Company C'] : ['成员', '角色', '公司甲', '公司乙', '公司丙']}
      rows={[
        [en ? 'Owner' : '负责人', en ? 'Admin' : '管理员', yes, yes, yes],
        [en ? 'Finance' : '财务', en ? 'Finance' : '财务', yes, yes, no],
        [en ? 'Operator' : '运营', en ? 'Operations' : '运营', yes, no, no],
      ]}
    />
    <Note lang={lang} zh="登录成功不等于能看每一家公司。" en="Signing in does not grant access to every company." />
  </section>
}

export function AdsPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <section className="lxm-panel">
    <Head lang={lang} zh="广告报表" en="Ads report" />
    <div className="lxm-funnel">
      <span><small>{en ? 'Impressions' : '展示'}</small><b><CountUp value="12,400" /></b></span>
      <span><small>{en ? 'Clicks' : '点击'}</small><b><CountUp value="140" /></b></span>
      <span><small>{en ? 'Spend' : '花费'}</small><b><CountUp value="200.00" /></b></span>
      <span><small>{en ? 'Ad sales' : '广告销售额'}</small><b><CountUp value="850.00" /></b></span>
    </div>
    <Table
      head={en ? ['Campaign', 'Type', 'Spend', 'Clicks', 'Sales', 'ACOS'] : ['活动', '类型', '花费', '点击', '销售额', 'ACOS']}
      rows={[
        [en ? 'Sample · brand terms' : '示例活动-品牌词', 'SP', '120.00', '86', '640.00', '18.8%'],
        [en ? 'Sample · auto' : '示例活动-自动', 'SP', '80.00', '54', '210.00', '38.1%'],
      ]}
    />
    <Note lang={lang} zh="只读。不改出价，不代投放。" en="Read-only. No bid changes and no managed campaigns." />
  </section>
}

export function AdsAccountPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const pending = en ? 'Not authorized' : '未授权'
  return <section className="lxm-panel">
    <Head lang={lang} zh="广告账户" en="Ads accounts" />
    <Table
      head={en ? ['Profile', 'Marketplace', 'Currency', 'Authorization', 'Report data'] : ['广告账户', '站点', '币种', '授权', '报表数据']}
      rows={[
        [en ? 'Sample profile 1001' : '示例账户 1001', en ? 'US' : '美国站', 'USD', en ? 'Authorized' : '已授权', en ? 'Shown' : '显示'],
        [en ? 'Sample profile 1002' : '示例账户 1002', en ? 'DE' : '德国站', 'EUR', pending, en ? 'Hidden' : '不显示'],
      ]}
      low={[pending]}
    />
    <Note lang={lang} zh="卖家授权完成，不会自动带出广告数据。" en="Seller authorization does not bring in advertising data." />
  </section>
}

export function AdsFlowPanel({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  const steps = en
    ? [['Request', 'A member with report permission picks account and dates.'], ['Wait', 'The task is queued and shown as pending.'], ['Download', 'The report file is downloaded when ready.'], ['Read', 'Spend, clicks and sales are shown in the account currency.']]
    : [['创建', '有报表权限的成员选择账户和日期。'], ['等待', '任务进入队列，页面显示等待中。'], ['下载', '报表生成后下载文件。'], ['查看', '按账户币种查看花费、点击和销售额。']]
  return <section className="lxm-panel">
    <Head lang={lang} zh="报表任务" en="Report tasks" />
    <ol className="lxm-steps">{steps.map(([title, text], index) => <li key={title}><b>{String(index + 1).padStart(2, '0')} {title}</b><span>{text}</span></li>)}</ol>
    <Note lang={lang} zh="整个过程只读，不改出价和预算。" en="The whole flow is read-only. Bids and budgets are not changed." />
  </section>
}

const panels = {
  '/product/inventory': InventoryPanel,
  '/product/inbound': InboundPanel,
  '/product/listings': ListingPanel,
  '/product/orders': OrderPanel,
  '/product/returns': ReturnsPanel,
  '/product/finance': FinancePanel,
  '/product/stores': StorePanel,
  '/product/permissions': PermissionPanel,
  '/product/advertising': AdsPanel,
  '/solutions/advertising': AdsPanel,
}

export function panelFor(href: string, lang: Lang = 'zh') {
  const Panel = panels[href as keyof typeof panels] ?? StorePanel
  return <Panel lang={lang} />
}

export const panelByKey = {
  inventory: InventoryPanel,
  inbound: InboundPanel,
  listings: ListingPanel,
  orders: OrderPanel,
  finance: FinancePanel,
  returns: ReturnsPanel,
  fees: FeesPanel,
  stores: StorePanel,
  connections: ConnectionPanel,
  permissions: PermissionPanel,
  ads: AdsPanel,
  adsAccount: AdsAccountPanel,
  adsFlow: AdsFlowPanel,
}

export type PanelKey = keyof typeof panelByKey
