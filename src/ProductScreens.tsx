import { useEffect, useState } from 'react'

function useCount(target: number) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 1400)
      const eased = 1 - (1 - progress) ** 3
      setValue(Math.round(target * eased))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return value
}

export function HeroDashboard() {
  const orders = useCount(128400)
  const refunds = useCount(6240)
  const fees = useCount(9180)
  const ads = useCount(4860)
  const acos = useCount(235)
  return <div className="shot" aria-label="经营看板示例">
    <div className="shot-card">
      <div className="shot-head"><b>经营概览</b><span>示例集团 · 全部店铺</span><em>示例数据</em></div>
      <div className="shot-kpis">
        <div><small>订单额</small><strong>${orders.toLocaleString('en-US')}</strong><span>USD</span></div>
        <div><small>退款</small><strong>${refunds.toLocaleString('en-US')}</strong><span>USD</span></div>
        <div><small>平台费用</small><strong>${fees.toLocaleString('en-US')}</strong><span>USD</span></div>
        <div><small>广告花费</small><strong>${ads.toLocaleString('en-US')}</strong><span>USD</span></div>
      </div>
      <div className="shot-body">
        <div>
          <small>订单趋势</small>
          <svg viewBox="0 0 360 140" role="img" aria-label="订单趋势示例">
            <polyline className="shot-line" fill="none" stroke="#336FE8" strokeWidth="3" points="8,110 48,96 88,100 128,72 168,80 208,48 248,56 288,30 328,38 352,22" />
            <polyline className="shot-line delay" fill="none" stroke="#12A9A0" strokeWidth="3" points="8,120 48,116 88,108 128,112 168,96 208,100 248,84 288,88 328,70 352,66" />
          </svg>
          <div className="shot-legend"><i /><span>订单额</span><i className="teal" /><span>广告花费</span></div>
        </div>
        <div className="shot-side">
          <small>退款构成</small>
          <svg className="shot-ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="42" />
            <circle className="shot-ring-value" cx="60" cy="60" r="42" />
          </svg>
          <b className="shot-ring-label">4.9%</b>
        </div>
      </div>
    </div>
    <aside className="shot-float">
      <small>广告 ACOS</small>
      <b>{(acos / 10).toFixed(1)}%</b>
      <span>示例账户 · 北美 · USD</span>
    </aside>
  </div>
}

export function Workbench({
  menu,
  active,
  crumb,
  columns,
  rows,
  alert,
}: {
  menu: string[]
  active: string
  crumb: string
  columns: string[]
  rows: string[][]
  alert?: string
}) {
  return <div className="wb" aria-label="产品界面示例">
    <div className="wb-side">
      <b>NOVA</b>
      {menu.map(item => <span key={item} className={item === active ? 'on' : ''}>{item}</span>)}
    </div>
    <div className="wb-main">
      <div className="wb-bar">
        <span>{crumb}</span>
        <span>2026-09-01 至 2026-09-30</span>
        <strong>示例数据</strong>
      </div>
      {alert && <p className="wb-alert">{alert}</p>}
      <div className="wb-table">
        <table>
          <thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  </div>
}

export function StoresScreen() {
  return <Workbench
    menu={['经营概览', '多店铺', '订单', '退货', '财务', '广告']}
    active="多店铺"
    crumb="示例集团 / 全部公司"
    columns={['公司', '店铺', '站点', '授权', '最近同步']}
    rows={[
      ['示例公司甲', '店铺 A', 'Amazon.com', '已连接', '09-30 18:20'],
      ['示例公司乙', '店铺 B', 'Amazon.co.jp', '已连接', '09-30 18:12'],
      ['示例公司丙', '店铺 C', 'Amazon.de', '待授权', '—'],
    ]}
    alert="待授权的公司不会出现订单和广告数据。"
  />
}

export function OrdersScreen() {
  return <Workbench
    menu={['经营概览', '多店铺', '订单', '退货', '财务', '广告']}
    active="订单"
    crumb="示例公司甲 / 店铺 A / Amazon.com"
    columns={['订单', '购买日', '状态', '币种', '金额']}
    rows={[
      ['示例-10021', '2026-09-02', '已发货', 'USD', '42.00'],
      ['示例-10058', '2026-09-18', '已发货', 'USD', '26.50'],
      ['示例-10077', '2026-09-27', '待发货', 'USD', '19.90'],
    ]}
  />
}

export function FinanceScreen() {
  return <Workbench
    menu={['经营概览', '多店铺', '订单', '退货', '财务', '广告']}
    active="财务"
    crumb="2026-09 / 分币种"
    columns={['店铺', '币种', '收入', '退款', '费用', '净额']}
    rows={[
      ['店铺 A', 'USD', '12,480', '860', '1,240', '10,380'],
      ['店铺 B', 'JPY', '186,000', '9,400', '21,000', '155,600'],
    ]}
    alert="美元和日元分行显示，不合成一个总数。"
  />
}

export function AdsScreen() {
  return <Workbench
    menu={['经营概览', '多店铺', '订单', '退货', '财务', '广告']}
    active="广告"
    crumb="示例广告账户 · 北美 · USD"
    columns={['活动', '类型', '花费', '点击', '广告销售额', 'ACOS']}
    rows={[
      ['品牌词', 'SP', '120.00', '86', '640.00', '18.8%'],
      ['自动投放', 'SP', '80.00', '54', '210.00', '38.1%'],
      ['品牌旗舰', 'SB', '60.00', '22', '140.00', '42.9%'],
    ]}
    alert="广告账户单独授权。此表为示例，默认只读。"
  />
}

export function InventoryScreen() {
  return <Workbench
    menu={['经营概览', '多店铺', '订单', '退货', '财务', '广告']}
    active="经营概览"
    crumb="示例公司甲 / 店铺 A"
    columns={['SKU', '可售', '在途', '预留', '更新时间']}
    rows={[
      ['示例-SKU-01', '240', '80', '12', '09-30 18:20'],
      ['示例-SKU-02', '36', '0', '4', '09-30 18:20'],
    ]}
  />
}
