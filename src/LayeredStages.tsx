function Bars() {
  const heights = [42, 68, 54, 80, 48, 72, 90, 64]
  return <div className="layer-bars" aria-hidden="true">{heights.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>
}

export function OverviewStage() {
  return <div className="layers" aria-label="经营概览效果图">
    <article className="pane pane-back">
      <header><span className="dots" /><b>经营概览</b><em>示例数据</em></header>
      <div className="pane-kpis">
        <div><small>订单额</small><strong>$128,400</strong></div>
        <div><small>退款</small><strong>$6,240</strong></div>
        <div><small>费用</small><strong>$9,180</strong></div>
        <div><small>广告</small><strong>$4,860</strong></div>
      </div>
      <Bars />
    </article>
    <article className="pane pane-front">
      <header><span className="dots" /><b>广告</b><em>USD</em></header>
      <div className="pane-ads">
        <div><span>品牌词 · SP</span><b>18.8%</b></div>
        <div><span>自动投放 · SP</span><b>38.1%</b></div>
        <div><span>品牌旗舰 · SB</span><b>42.9%</b></div>
      </div>
    </article>
    <aside className="float-card">
      <small>广告 ACOS</small>
      <b>23.5%</b>
      <span>北美 · 示例账户</span>
    </aside>
    <aside className="float-pill">3 家公司 · 2 已连接</aside>
  </div>
}

export function StoreStage() {
  return <div className="layers" aria-label="多店铺效果图">
    <article className="pane pane-back">
      <header><span className="dots" /><b>公司与店铺</b><em>示例</em></header>
      <div className="pane-list">
        <div><b>示例公司甲</b><span>店铺 A · Amazon.com</span><i className="ok">已连接</i></div>
        <div><b>示例公司乙</b><span>店铺 B · Amazon.co.jp</span><i className="ok">已连接</i></div>
        <div><b>示例公司丙</b><span>店铺 C · Amazon.de</span><i>待授权</i></div>
      </div>
    </article>
    <article className="pane pane-front pane-narrow">
      <header><span className="dots" /><b>授权</b></header>
      <p>待授权的公司不会带出订单和广告。</p>
      <strong>2 / 3</strong>
      <span>已连接</span>
    </article>
  </div>
}

export function OrderStage() {
  return <div className="layers" aria-label="订单效果图">
    <article className="pane pane-back">
      <header><span className="dots" /><b>订单</b><em>示例</em></header>
      <div className="pane-list">
        <div><b>示例-10021</b><span>店铺 A · 09-02 · 已发货</span><i>USD 42.00</i></div>
        <div><b>示例-10058</b><span>店铺 A · 09-18 · 已发货</span><i>USD 26.50</i></div>
        <div><b>示例-10077</b><span>店铺 B · 09-21 · 待发货</span><i>JPY 3,280</i></div>
      </div>
    </article>
    <article className="pane pane-front">
      <header><span className="dots" /><b>示例-10021</b></header>
      <div className="pane-kpis">
        <div><small>金额</small><strong>$42.00</strong></div>
        <div><small>站点</small><strong>US</strong></div>
      </div>
      <p>购买日 2026-09-02 · 已发货</p>
    </article>
  </div>
}

export function FinanceStage() {
  return <div className="layers" aria-label="财务效果图">
    <article className="pane pane-back">
      <header><span className="dots" /><b>USD · 店铺 A</b><em>示例</em></header>
      <div className="pane-kpis">
        <div><small>收入</small><strong>12,480</strong></div>
        <div><small>退款</small><strong>860</strong></div>
        <div><small>费用</small><strong>1,240</strong></div>
        <div><small>净额</small><strong>10,380</strong></div>
      </div>
      <Bars />
    </article>
    <article className="pane pane-front">
      <header><span className="dots" /><b>JPY · 店铺 B</b></header>
      <div className="pane-kpis">
        <div><small>净额</small><strong>155,600</strong></div>
        <div><small>币种</small><strong>JPY</strong></div>
      </div>
      <p>不与美元相加。</p>
    </article>
  </div>
}

export function AdsStage() {
  return <div className="layers" aria-label="广告效果图">
    <article className="pane pane-back">
      <header><span className="dots" /><b>广告活动</b><em>示例 · USD</em></header>
      <div className="pane-ads">
        <div><span>品牌词 SP</span><b>$120</b></div>
        <div><span>自动投放 SP</span><b>$80</b></div>
        <div><span>品牌旗舰 SB</span><b>$60</b></div>
      </div>
      <Bars />
    </article>
    <aside className="float-card float-card-ads">
      <small>ACOS</small>
      <b>23.5%</b>
      <span>默认只读</span>
    </aside>
    <aside className="float-pill">账户 示例-1001 · 北美</aside>
  </div>
}
