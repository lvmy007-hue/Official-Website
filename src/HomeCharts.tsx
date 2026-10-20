export function HeroBoard() {
  return <div className="scene scene-hero" aria-label="三家公司在北美、欧洲、日本的订单、利润和广告">
    <div className="scene-mesh" />
    <div className="scene-sites">
      <span>Amazon.com</span><i /><span>Amazon.de</span><i /><span>Amazon.co.jp</span>
    </div>
    <div className="scene-col">
      <article className="scene-card scene-companies">
        <header>三家公司 · 9 月</header>
        <div><b>示例主体 A</b><em>美国站示例</em><strong>$186,400</strong></div>
        <div><b>示例主体 B</b><em>欧洲站示例</em><strong>$162,200</strong></div>
        <div><b>示例主体 C</b><em>日本站示例</em><strong>$137,600</strong></div>
      </article>
      <article className="scene-card scene-order">
        <header>订单 示例-10021<small>已发货</small></header>
        <p>示例主体 A · Amazon.com</p>
        <ol><li>下单 09-02</li><li>发货 09-04</li><li>结算 09-18</li></ol>
        <strong>$42.00</strong>
      </article>
    </div>
    <div className="scene-col">
      <article className="scene-card scene-money">
        <header>利润从订单额里拆出来</header>
        <div><span>订单额</span><b>$486,200</b></div>
        <div><span>货本 62%</span><b>$301,400</b></div>
        <div><span>广告 11%</span><b>$54,000</b></div>
        <div><span>平台费 7%</span><b>$33,600</b></div>
        <div className="is-profit"><span>利润 20%</span><b>$97,200</b></div>
      </article>
      <article className="scene-card scene-float">
        <small>在营店铺</small>
        <b>6</b>
        <span>5 个站点</span>
      </article>
    </div>
  </div>
}

export function StoreBoard() {
  return <div className="scene scene-store" aria-label="法律主体各自挂着店铺和站点">
    <header>一个主体一套店</header>
    <div className="scene-tree">
      <article>
        <b>示例主体 A</b>
        <span className="ok">已开通</span>
        <ul><li>美国站 · 主店</li><li>美国站 · 副店</li></ul>
      </article>
      <article>
        <b>示例主体 B</b>
        <span className="ok">已开通</span>
        <ul><li>德国站</li><li>英国站</li></ul>
      </article>
      <article>
        <b>示例主体 C</b>
        <span className="wait">待开通</span>
        <ul><li>日本站</li><li>尚未进入月报</li></ul>
      </article>
    </div>
    <p>待授权主体不会计入演示统计。</p>
  </div>
}

export function FinanceBoard() {
  return <div className="scene scene-finance" aria-label="10 月退款对回 7 月的订单，美元和日元分开">
    <header>退款回到下单的那个月</header>
    <div className="scene-ledger">
      <div><b>7 月订单</b><span>示例主体 A · 美国站</span><strong>USD 1,280</strong></div>
      <div className="scene-arrow">10 月退回 80 美元</div>
      <div><b>10 月退款</b><span>对回 7 月，不进 10 月新销售</span><strong>USD -80</strong></div>
    </div>
    <div className="scene-currencies">
      <article><small>美元账</small><b>$352,400</b><span>收入 − 退款 − 费用</span></article>
      <article><small>日元账</small><b>¥1,860,000</b><span>不与美元相加</span></article>
    </div>
  </div>
}

export function AdsBoard() {
  return <div className="scene scene-ads" aria-label="广告从曝光到销售额，ACOS 23.5%">
    <header>示例广告账户 · 北美 · 只读</header>
    <div className="scene-funnel">
      <div><b>128,000</b><span>曝光</span></div>
      <div><b>1,620</b><span>点击</span></div>
      <div><b>214</b><span>订单</span></div>
      <div><b>$230,000</b><span>广告销售额</span></div>
    </div>
    <div className="scene-campaigns">
      <article><b>品牌词 · SP</b><span>花费 $18,200</span><em>ACOS 18.8%</em></article>
      <article><b>自动投放 · SP</b><span>花费 $21,400</span><em>ACOS 26.4%</em></article>
      <article><b>品牌旗舰 · SB</b><span>花费 $14,400</span><em>ACOS 24.1%</em></article>
    </div>
    <p>三档花费合计 $54,000，除以广告销售额 $230,000，得到 ACOS 23.5%。</p>
  </div>
}
