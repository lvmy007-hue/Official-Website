import { useState } from 'react'
import type { ReactNode } from 'react'
import { SiteLink } from './site-link'
import { AdsScreen, FinanceScreen, InventoryScreen, OrdersScreen, StoresScreen } from './ProductScreens'
import { AdsBoard } from './HomeCharts'
import { panelFor } from './lx-panels'
import { DemoFrame, PermissionFigure, ReturnMatrixFigure } from './OfficialHome'
import { returnMatrix, storeDemoRows } from './public-site-content'
import {
  adAccountDemo,
  adCampaignDemo,
  adFaqs,
  adHierarchy,
  adKpis,
  adReportFlow,
  permissionRows,
  pricingFaqs,
  pricingSteps,
  productAreas,
  productTabs,
  serviceNature,
} from './public-product-content'
import { planCompare, productPitches, salePlans } from './site-commercial'
import type { PublicPage } from './public-site-content'

function Tabs({ page }: { page: PublicPage }) {
  return <nav className="pub-tabs" aria-label="产品分类">
    <SiteLink href="/product" aria-current={page === 'product' ? 'page' : undefined}>总览</SiteLink>
    {productTabs.map(tab => <SiteLink key={tab.href} href={tab.href} aria-current={page === tab.page ? 'page' : undefined}>{tab.label}</SiteLink>)}
  </nav>
}

function Frame({ page, eyebrow, title, lede, children }: { page: PublicPage; eyebrow: string; title: string; lede: string; children: ReactNode }) {
  return <article className="pub-detail">
    <div className="pub-wrap">
      <Tabs page={page} />
      <p className="pub-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="pub-lede">{lede}</p>
      {children}
    </div>
  </article>
}

export function ProductHub() {
  return <Frame page="product" eyebrow="产品能力" title="六类能力分开说明。" lede="每类都列出要解决的问题、四项功能和数据从哪里来。广告报表需要广告账户另行授权。">
    <div className="pub-area-list">
      {productAreas.map(area => <section key={area.href}>
        <div>
          <h2>{area.title}</h2>
          <p>{area.claim}</p>
          <p>{area.problem}</p>
          <SiteLink href={area.href} className="pub-text-link">查看详情 →</SiteLink>
        </div>
        <div>
          <ol>{area.features.map(feature => <li key={feature}>{feature}</li>)}</ol>
          <p>{area.source}</p>
          <strong>{area.status}</strong>
        </div>
      </section>)}
    </div>
    <InventoryScreen />
    <section id="inventory">
      <h2>库存视图</h2>
      <p>卖家账号下可以查看可售、在途和预留库存，并看到来源更新时间。下面的数量只出现在已授权店铺中。公开页面的表格使用示例数据。</p>
    </section>
  </Frame>
}

export function StoresPage() {
  return <Frame page="product-stores" eyebrow="多店铺" title="公司、卖家账号、站点和授权是四层关系。" lede="未授权的公司不会进入可查询范围，也不会被写成开发方自己的店铺。">
    <StoresScreen />
    <div className="pub-split">
      <ol className="pub-tree">
        <li><b>租户</b><span>成员只能进入自己所属的企业空间。</span>
          <ol>
            <li><b>法律主体</b><span>一家公司一条记录，授权按公司发起。</span>
              <ol>
                <li><b>卖家账号</b><span>账号属于某一个法律主体，并带有区域。</span>
                  <ol><li><b>站点与连接</b><span>站点、授权状态、最近成功同步时间记在连接上。没有成功同步时，时间留空。</span></li></ol>
                </li>
              </ol>
            </li>
          </ol>
        </li>
      </ol>
      <div className="pub-demo-table">
        <div className="pub-demo-label">演示数据 · 无真实卖家编号</div>
        <div className="pub-scroll">
          <table>
            <caption>公司、店铺、站点与授权状态的对照示意</caption>
            <thead><tr><th>公司名称</th><th>店铺</th><th>站点</th><th>授权状态</th><th>最近同步</th></tr></thead>
            <tbody>{storeDemoRows.map(row => <tr key={row[0]} className={row[3] === '授权异常' ? 'is-alert' : ''}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <p className="pub-alert">授权异常只表示这一步没有完成。页面不会把该行改成成功。</p>
      </div>
    </div>
    <h2>谁可以看见这些行</h2>
    <p>查看卖家账号使用 seller.read，管理连接使用 connection.manage。没有对应权限码的成员，接口不会返回其他公司的记录。</p>
  </Frame>
}

export function OrdersPage() {
  const fields = [
    ['购买时间', 'Order.purchaseDate', '用来判断订单属于哪一天，也是跨月退款对照的原订单时间。'],
    ['订单状态', 'Order.status', '只反映已经写入的状态，不代表物流页面上的全部节点都已同步。'],
    ['币种与金额', 'Order.currency / amount', '金额必须带着币种。不同订单的币种不能在这里合成一个总数。'],
    ['来源更新时间', 'Order.sourceUpdatedAt', '用来说明这条记录何时从数据源更新。没有这条时间，就不能说刚刚同步完成。'],
  ]
  return <Frame page="product-orders" eyebrow="订单" title="一条订单要能回答属于谁、发生在何时、以什么币种计算。" lede="下面是订单记录里已经存在的字段，不是某一家店铺的实时清单。">
    <OrdersScreen />
    <ol className="pub-field-list">
      {fields.map(([title, field, text]) => <li key={field}><span>{field}</span><h2>{title}</h2><p>{text}</p></li>)}
    </ol>
    <div className="pub-demo-table">
      <div className="pub-demo-label">示意数据</div>
      <div className="pub-scroll">
        <table>
          <caption>单条订单示意，不代表生产数据</caption>
          <thead><tr><th>订单</th><th>店铺</th><th>购买日</th><th>状态</th><th>币种</th><th>金额</th><th>来源更新</th></tr></thead>
          <tbody><tr><td>演示订单-0701</td><td>演示店铺 A</td><td>2026-07-18</td><td>已写入示例</td><td>USD</td><td>40.00</td><td>—</td></tr></tbody>
        </table>
      </div>
    </div>
    <p>来源更新留空，是因为这条示意没有对应的同步任务。真实订单只有在授权和同步完成后才会出现更新时间。</p>
    <SiteLink href="/product/returns" className="pub-text-link">继续看退货如何对回这个购买日 →</SiteLink>
  </Frame>
}

export function ReturnsPage() {
  const [cell, setCell] = useState<[number, number] | null>(null)
  const selected = cell ? returnMatrix.counts[cell[0]][cell[1]] : null
  return <Frame page="product-returns" eyebrow="退货" title="先分清退款发生月和原订单月。" lede="退款记录不等于货物已经退回仓库。库存处置、退款金额和原订单是三件不同的事。">
    <div className="pub-define">
      <section><h2>当月退款</h2><p>退款发生的月份与原订单购买月份相同。它回答的是：这个月新产生的订单里，有多少在同一个月被退款。</p></section>
      <section><h2>跨月退款</h2><p>退款记在较晚的月份，原订单买在更早的月份。月结时要把这笔退款放回原来的订单月，而不是只算进退款发生月的新订单。</p></section>
    </div>
    <div className="pub-matrix">
      <div className="pub-demo-label">演示数据 · 退款记录数</div>
      <table>
        <caption>行是原订单月，列是退款月</caption>
        <thead><tr><th>原订单月 \ 退款月</th>{returnMatrix.refundMonths.map(month => <th key={month}>{month}</th>)}</tr></thead>
        <tbody>
          {returnMatrix.orderMonths.map((month, row) => <tr key={month}><th>{month}</th>{returnMatrix.refundMonths.map((refundMonth, column) => <td key={refundMonth}><button aria-pressed={cell?.[0] === row && cell?.[1] === column} onClick={() => setCell([row, column])}>{returnMatrix.counts[row][column]}</button></td>)}</tr>)}
        </tbody>
      </table>
      <p>{selected === null ? '点击一格，查看演示数字对应的月份。' : `原订单月 ${returnMatrix.orderMonths[cell![0]]}，退款月 ${returnMatrix.refundMonths[cell![1]]}，示意 ${selected} 笔。退款 ≠ 实物退货。`}</p>
    </div>
    <h2>一条退货明细里有什么</h2>
    <p>已建模的退货记录包含原订单号、退货日期、数量、原因、库存处置和退款金额。原订单月份不是单独字段，需要用订单购买日对照。导出需要 export.create 权限，并且走报表任务；任务未完成时不能把文件说成已经可以下载。</p>
  </Frame>
}

export function FinancePage() {
  return <Frame page="product-finance" eyebrow="财务" title="先对齐时间，再在同一种货币里看净额。" lede="订单金额、退款金额和费用事件各自有时间。净额不是把所有数字相加。">
    <FinanceScreen />
    <ol className="pub-ledger">
      <li><b>订单收入</b><span>来自订单金额和订单币种，时间用购买日。</span></li>
      <li><b>退款</b><span>来自退货记录中的退款金额，时间用退货日，并尽量关联原订单。</span></li>
      <li><b>平台费用</b><span>费用事件保存金额、币种、入账时间和可选的结算编号。费用不混进广告花费。</span></li>
      <li><b>同币种净额</b><span>只在同一币种内用收入减去退款和费用。美元和欧元分列。</span></li>
    </ol>
    <div className="pub-callout">系统里没有已上线的自动汇率换算。看到两种货币时，页面保持分行，不生成一个混合总数。</div>
    <div className="pub-demo-table">
      <div className="pub-demo-label">示意数据</div>
      <div className="pub-scroll">
        <table>
          <caption>同一月份的两条不同币种记录</caption>
          <thead><tr><th>月份</th><th>店铺</th><th>币种</th><th>收入</th><th>退款</th><th>费用</th><th>净额</th></tr></thead>
          <tbody>
            <tr><td>2026-09</td><td>演示店铺 A</td><td>USD</td><td>1,000.00</td><td>80.00</td><td>120.00</td><td>800.00</td></tr>
            <tr><td>2026-09</td><td>演示店铺 C</td><td>EUR</td><td>500.00</td><td>20.00</td><td>40.00</td><td>440.00</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <p>报表边界：费用事件和订单已经有数据模型。并非每一种结算类型都已经可以读取。没有授权和同步任务时，这些列保持为示意。</p>
  </Frame>
}

export function AdvertisingProductPage() {
  return <Frame page="product-advertising" eyebrow="广告" title="卖家账号和广告账户不是同一个对象。" lede="广告账户授权后，可以按 Profile 查看活动报表。卖家授权不会自动带上广告权限。">
    <p className="pub-status">广告账户需单独授权</p>
    <AdsScreen />
    <ol className="pub-stack">
      {adHierarchy.map((item, index) => <li key={item}><span>0{index + 1}</span><b>{item}</b></li>)}
    </ol>
    <p>Portfolio、Campaign 和更下层的对象，都挂在某一个 Advertising Profile 下面。Profile 再属于广告主的一次授权。把卖家账号直接当成广告账户，会把两家公司的数据混在一起。</p>
    <SiteLink href="/solutions/advertising" className="pub-text-link">查看广告管理方案 →</SiteLink>
  </Frame>
}

export function PermissionsPage() {
  return <Frame page="product-permissions" eyebrow="权限" title="读取、导出和修改连接使用不同的权限码。" lede="成员先要属于这个租户。之后接口再按角色里的权限码判断能不能看订单、财务或广告。">
    <div className="pub-scroll">
      <table>
        <caption>当前代码中的权限码</caption>
        <thead><tr><th>权限码</th><th>用于</th></tr></thead>
        <tbody>{permissionRows.map(row => <tr key={row[0]}><td>{row[0]}</td><td>{row[1]}</td></tr>)}</tbody>
      </table>
    </div>
    <p>只读权限不能代替 connection.manage。公开页面不能证明每一个按钮都已对只读角色隐藏，但缺少权限时，对应接口会拒绝访问。</p>
    <SiteLink href="/security" className="pub-text-link">查看安全说明 →</SiteLink>
  </Frame>
}

export function AdvertisingSolutionPage() {
  const [open, setOpen] = useState(0)
  return <article className="lx-page pub-detail">
    <section className="lx-subhero">
      <p className="lx-kicker">广告报表</p>
      <h1>广告账户单独卖、单独授权</h1>
      <p className="lx-lead">这是可以单独购买的报表服务。卖家店铺开通之后，广告花费不会自动出现。每个账户用自己的币种。</p>
      <div className="lx-hero-actions"><SiteLink href="/contact" className="lx-btn">确认接入范围</SiteLink><SiteLink href="/product" className="lx-btn lx-btn-line">查看产品能力</SiteLink></div>
    </section>
    <div className="pub-wrap">
      <p className="pub-status">广告账户需单独授权</p>
      <div className="pub-actions">
        <SiteLink href="/contact" className="pub-primary">预约广告产品演示</SiteLink>
      </div>
      <AdsScreen />
      <h2>数据从广告主走到投放对象</h2>
      <div className="pub-flow">{adHierarchy.map(item => <span key={item}>{item}</span>)}</div>
      <p>中间的 Advertising Profile 才是授权和币种的边界。它不是卖家账号的别名。</p>
      <h2>指标按公式理解，不按成绩展示</h2>
      <div className="pub-scroll">
        <table>
          <caption>指标定义。金额使用账户币种，页面同时显示数据截止时间。</caption>
          <thead><tr><th>指标</th><th>公式或来源</th><th>单位</th><th>时间窗口</th><th>数据延迟</th></tr></thead>
          <tbody>{adKpis.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <h2>广告账户</h2>
      <div className="pub-demo-table">
        <div className="pub-demo-label">示例数据</div>
        <div className="pub-scroll">
          <table>
            <caption>账户管理表的列结构</caption>
            <thead><tr><th>账户名</th><th>Profile ID</th><th>区域</th><th>币种</th><th>授权状态</th><th>同步时间</th></tr></thead>
            <tbody><tr>{adAccountDemo.map((cell, index) => <td key={index}>{cell}</td>)}</tr></tbody>
          </table>
        </div>
      </div>
      <h2>Campaign</h2>
      <div className="pub-scroll">
        <table>
          <caption>示例数据 · 美元 · 默认只读</caption>
          <thead><tr><th>活动名</th><th>类型</th><th>状态</th><th>花费</th><th>点击</th><th>广告销售额</th><th>ACOS</th><th>ROAS</th></tr></thead>
          <tbody>{adCampaignDemo.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <h2>报表要经过任务，而不是立刻出现</h2>
      <ol className="pub-report-flow">{adReportFlow.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}</ol>
      <h2>授权如何发生，如何收回</h2>
      <p>广告数据需要广告账户持有人另行完成登录授权。卖家授权不会自动带上广告权限。收回授权在广告平台完成，之后停止读取该账户的新报表。</p>
      <h2>现在提供的是哪一种服务</h2>
      <p>{serviceNature}</p>
      <h2>广告相关问题</h2>
      <div className="pub-faq">
        {adFaqs.map((item, index) => <div key={item.q}>
          <button aria-expanded={open === index} onClick={() => setOpen(current => current === index ? -1 : index)}>{item.q}</button>
          <p hidden={open !== index}>{item.a}</p>
        </div>)}
      </div>
      <div className="pub-actions">
        <SiteLink href="/contact" className="pub-primary">预约广告产品演示</SiteLink>
        <SiteLink href="/pricing" className="pub-secondary">查看服务范围</SiteLink>
      </div>
    </div>
  </article>
}

export function PricingPage() {
  return <article className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">目录价</p><h1>按公司和模块选择</h1><p className="lx-lead">下面是目录价，用来对照每档包含的模块。开通和付款以书面方案为准，不在网页收款。</p></section>
    <section className="lx-wrap lx-plans">{salePlans.map(plan => <article key={plan.name} className={plan.featured ? 'is-on' : ''}><em>{plan.featured ? '常用' : ''}</em><h2>{plan.name}</h2><div className="lx-price"><b>{plan.price}</b><span>{plan.unit}</span></div><p className="lx-fit">{plan.fit}</p><ul>{plan.points.map(point => <li key={point}>{point}</li>)}</ul><SiteLink href="/contact" className="lx-btn">获取书面方案</SiteLink></article>)}</section>
    <section className="lx-wrap lx-compare"><h2>模块对照</h2><table><thead><tr><th>模块</th>{salePlans.map(plan => <th key={plan.name}>{plan.name}</th>)}</tr></thead><tbody>{planCompare.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={`${row[0]}-${index}`}>{cell}</td>)}</tr>)}</tbody></table><p className="lx-fit">广告报表只读，不改竞价，不代投放。单公司起步不含广告报表。</p></section>
    <section className="lx-feature"><div className="lx-wrap"><h2>开通之前先确认</h2><ol className="lx-rail">{pricingSteps.map(([no, title, text]) => <li key={no}><b>{no} {title}</b><span>{text}</span></li>)}</ol></div></section>
    <section className="lx-band"><div className="lx-wrap"><h2>常见问题</h2><div className="lx-faq">{pricingFaqs.map(item => <article key={item.q}><h3>{item.q}</h3><p>{item.a}</p></article>)}</div></div></section>
  </article>
}

export function productPageBody(page: PublicPage) {
  return <ProductRoute page={page} />
}

const chapterFigure: Record<string, ReactNode> = {
  '/product/stores': <StoresScreen />,
  '/product/orders': <OrdersScreen />,
  '/product/returns': <ReturnMatrixFigure />,
  '/product/finance': <FinanceScreen />,
  '/product/advertising': <AdsScreen />,
  '/product/permissions': <PermissionFigure />,
  '/product/inventory': <DemoFrame><InventoryScreen /></DemoFrame>,
  '/product/listings': <ListingFigure />,
  '/product/inbound': <InboundFigure />,
}
function ListingFigure() {
  return <DemoFrame><table className="site-perms"><caption>刊登对照 · 示例</caption><tbody>
    <tr><th>示例-ASIN-01</th><td>示例-SKU-01 · 示例-FN-01 · 在售</td></tr>
    <tr><th>示例-ASIN-02</th><td>示例-SKU-02 · 示例-FN-02 · 未完成</td></tr>
  </tbody></table></DemoFrame>
}
function InboundFigure() {
  return <DemoFrame><table className="site-perms"><caption>入库货件 · 示例</caption><tbody>
    <tr><th>示例计划</th><td>美国站 · 待同步货件</td></tr>
    <tr><th>示例货件</th><td>目的仓与接收数量以同步结果为准</td></tr>
  </tbody></table></DemoFrame>
}

function ProductIndex() {
  const groups = [
    { title: '财务', text: '收入、退款和费用按同一币种核对，退款可以对回原来的订单月。', hrefs: ['/product/finance', '/product/returns'] },
    { title: '供应链', text: '库存、入库、刊登和订单挂在已授权的卖家账号上。', hrefs: ['/product/inventory', '/product/inbound', '/product/listings', '/product/orders', '/product/stores'] },
    { title: '运营', text: '谁能看哪家公司，由成员权限决定，不由登录本身决定。', hrefs: ['/product/permissions'] },
    { title: '广告', text: '广告账户单独授权。报表只读，不改出价，不代投放。', hrefs: ['/product/advertising'] },
  ]
  return <div className="lx-page">
    <section className="lx-subhero"><p className="lx-kicker">产品</p><h1>按财务、供应链、运营和广告查看</h1><p className="lx-lead">每一组下面是独立模块。点进去可以看到授权前后的差别，以及这一档目录价包不包括它。</p><nav className="lx-jump" aria-label="产品分组">{groups.map(group => <a key={group.title} href={`#group-${group.title}`}>{group.title}</a>)}</nav></section>
    {groups.map(group => <div key={group.title} id={`group-${group.title}`}>
      <div className="lx-wrap"><div className="lx-core-head"><h2>{group.title}</h2><p>{group.text}</p></div></div>
      {group.hrefs.map(href => productPitches.find(item => item.href === href)).filter(item => item != null).map(item => <section key={item.href} className="lxm-block">
        <div className="lx-wrap">
          <div className="lxm-copy"><h2>{item.title}</h2><p>{item.sell}</p></div>
          <div className="lxm-points">{item.points.map(point => <article key={point}><b>{point}</b><span>目录价档位：{item.plan}</span></article>)}</div>
          <div className="lxm-actions"><SiteLink href={item.href} className="lx-btn">查看说明</SiteLink><SiteLink href="/pricing" className="lx-btn lx-btn-line">查看目录价</SiteLink></div>
          {panelFor(item.href)}
        </div>
      </section>)}
    </div>)}
  </div>
}
function ProductRoute({ page }: { page: PublicPage }) {
  if (page === 'home') return null
  if (page === 'pricing') return <PricingPage />
  if (page === 'solutions-advertising' || page === 'product-advertising') return <AdsOfferPage />
  if (page === 'product') return <ProductIndex />
  const pitch = productPitches.find(item => item.href === pagePath(page))
  const area = productAreas.find(item => item.href === pagePath(page))
  if (!pitch || !area) return null
  const related = productPitches.filter(item => item.href !== pitch.href).slice(0, 3)
  return <div className="lx-page">
    <section className="lx-hero">
      <div className="lx-hero-copy">
        <p className="lx-kicker">产品模块 · {pitch.plan}</p>
        <h1><span>模块说明</span><em>{pitch.title}</em></h1>
        <p className="lx-hero-lead">{pitch.sell}</p>
        <div className="lx-hero-actions"><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/product" className="lx-btn lx-btn-line">返回产品总览</SiteLink></div>
      </div>
      <div>{panelFor(pitch.href)}</div>
    </section>
    <section className="lxm-block"><div className="lx-wrap">
      <div className="lxm-copy"><h2>这个模块解决什么</h2><p>{area.problem}</p></div>
      <div className="lxm-points">{area.features.map(feature => <article key={feature}><b>{feature}</b><span>{area.source}</span></article>)}</div>
      <div className="lxm-actions"><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink></div>
      {panelFor(pitch.href)}
      <p className="lxm-foot">{area.status} 不代投放，不改竞价，不代替卖家完成亚马逊审批。</p>
    </div></section>
    <section className="lx-band"><div className="lx-wrap"><div className="lx-core-head"><h2>相关模块</h2></div><div className="lx-cases">{related.map(item => <article key={item.href}><div className="lx-case-cover">{item.plan}</div><div><strong>{item.title}</strong><p>{item.sell}</p><SiteLink href={item.href}>查看说明</SiteLink></div></article>)}</div></div></section>
    <section className="lx-final"><h2>预约演示这个模块</h2><p>{pitch.title}</p><div><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/pricing" className="lx-btn lx-btn-line">查看目录价</SiteLink></div></section>
  </div>
}

function AdsOfferPage() {
  const [open, setOpen] = useState(-1)
  return <div className="lx-page">
    <section className="lx-hero">
      <div className="lx-hero-copy">
        <p className="lx-kicker">广告报表</p>
        <h1><span>广告账户要再授权一次</span><em>报表只读，不代投放</em></h1>
        <p className="lx-hero-lead">{serviceNature}</p>
        <div className="lx-hero-actions"><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink><SiteLink href="/pricing" className="lx-btn lx-btn-line">查看目录价</SiteLink></div>
      </div>
      <DemoFrame><AdsBoard /></DemoFrame>
    </section>
    <section className="lx-core-block"><div className="lx-wrap"><div className="lx-core-head"><h2>报表里的指标</h2><p>都挂在这个广告账户自己的币种上。不同币种不相加。</p></div><div className="lx-core-grid">{adKpis.map(row => <article key={row[0]} className="lx-core-card"><b>{row[0]}</b><span>{row[1]}。单位：{row[2]}。窗口：{row[3]}。</span></article>)}</div></div></section>
    <section className="lx-clone"><div className="lx-wrap lx-clone-grid">
      <div><h2>从广告主到关键词</h2><ul className="lx-clone-list">{adHierarchy.map(item => <li key={item}><b>{item}</b><span>按已授权的广告账户逐层查看。</span></li>)}</ul></div>
      <DemoFrame><AdsScreen /></DemoFrame>
    </div></section>
    <section className="lx-feature"><div className="lx-wrap"><div className="lx-core-head"><h2>报表要经过任务</h2><p>完成之前，页面不把结果写成已经更新。</p></div><ol className="lx-rail">{adReportFlow.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}</ol></div></section>
    <section className="lx-band"><div className="lx-wrap"><div className="lx-core-head"><h2>广告相关问题</h2></div><div className="lx-faq">{adFaqs.map((item, index) => <article key={item.q}><h3><button type="button" onClick={() => setOpen(current => current === index ? -1 : index)}>{item.q}</button></h3>{open === index ? <p>{item.a}</p> : null}</article>)}</div></div></section>
    <section className="lx-final"><h2>预约广告报表演示</h2><div><SiteLink href="/contact" className="lx-btn">预约演示</SiteLink></div></section>
  </div>
}
function pagePath(page: PublicPage) {
  if (page === 'product-stores') return '/product/stores'
  if (page === 'product-orders') return '/product/orders'
  if (page === 'product-returns') return '/product/returns'
  if (page === 'product-finance') return '/product/finance'
  if (page === 'product-advertising') return '/product/advertising'
  if (page === 'product-permissions') return '/product/permissions'
  if (page === 'product-inventory') return '/product/inventory'
  if (page === 'product-listings') return '/product/listings'
  if (page === 'product-inbound') return '/product/inbound'
  return ''
}
