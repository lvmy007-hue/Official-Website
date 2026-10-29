import * as Tabs from '@radix-ui/react-tabs'
import {
  LayoutDashboard, Megaphone, Boxes, ShoppingCart, Wallet, BarChart3,
  ArrowUpRight, ArrowDownRight, ChevronDown, Lock,
} from 'lucide-react'
import { EChart } from '../ui/chart'
import { useLang, useT } from './i18n'
import { adsBreakdownOption, inventoryTurnOption, salesTrendOption, siteShareOption } from './panels'

function Sparkline({ points, tone = 'brand' }: { points: number[]; tone?: 'brand' | 'good' }) {
  const max = Math.max(...points), min = Math.min(...points)
  const span = max - min || 1
  const w = 64, h = 24
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - min) / span) * h}`).join(' ')
  const stroke = tone === 'good' ? '#12a38a' : '#2b63f0'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="overflow-visible" aria-hidden="true">
      <polyline points={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type Kpi = { label: string; value: string; delta: string; good: boolean; spark: number[] }

function KpiRow({ items }: { items: Kpi[] }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {items.map((k) => (
        <div key={k.label} className="relative rounded-xl border border-line bg-white px-4 py-3">
          <div className="text-[12px] text-ink-mute">{k.label}</div>
          <div className="mt-1.5 text-[24px] font-semibold tracking-tight text-ink">{k.value}</div>
          <div className={`mt-0.5 inline-flex items-center gap-1 text-[12px] font-semibold ${k.good ? 'text-success' : 'text-danger'}`}>
            {k.good ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{k.delta}
          </div>
          <div className="absolute bottom-3 right-3 opacity-90"><Sparkline points={k.spark} tone={k.good ? 'good' : 'brand'} /></div>
        </div>
      ))}
    </div>
  )
}

function Pill({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span className={`inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-semibold ${active ? 'border-brand-200 bg-brand-50 text-brand-600' : 'border-line bg-white text-ink-soft'}`}>
      {children}<ChevronDown size={13} className="opacity-60" />
    </span>
  )
}

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white p-3.5 pb-1">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-[13px] font-bold text-ink">{title}</h4>
        <span className="text-[11px] text-ink-mute">{sub}</span>
      </div>
      {children}
    </div>
  )
}

export function Console() {
  const lang = useLang()
  const t = useT()
  const demo = t('演示', 'Sample')
  const d14 = t('近 14 天', 'last 14 days')
  const NAV = [
    { v: 'ops', icon: LayoutDashboard, label: t('经营看板', 'Dashboard'), live: true },
    { v: 'ads', icon: Megaphone, label: t('广告', 'Ads'), live: true },
    { v: 'inv', icon: Boxes, label: t('库存', 'Inventory'), live: true },
    { v: 'ord', icon: ShoppingCart, label: t('订单', 'Orders'), live: false },
    { v: 'fin', icon: Wallet, label: t('财务', 'Finance'), live: false },
    { v: 'rep', icon: BarChart3, label: t('报表', 'Reports'), live: false },
  ]
  return (
    <div className="overflow-hidden rounded-2xl border border-[#eef1f6] bg-white shadow-float">
      {/* 窗口顶栏 */}
      <div className="flex h-11 items-center gap-3 border-b border-line bg-[#fbfcfe] px-4">
        <span className="flex gap-1.5">
          <i className="h-2.5 w-2.5 rounded-full bg-[#ff6159]" />
          <i className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" />
          <i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="text-[12.5px] font-semibold text-ink-soft">{t('经营看板', 'Dashboard')} <span className="font-medium text-ink-mute">/ {t('全部店铺', 'All stores')} · {d14}</span></span>
        <span className="ml-auto rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-600">{t('演示数据', 'Sample data')}</span>
      </div>

      <Tabs.Root defaultValue="ops" className="grid grid-cols-[116px_1fr] min-h-[478px]">
        {/* 侧边导航即视图切换器 */}
        <Tabs.List className="flex flex-col gap-1 border-r border-line bg-[#fafbfd] p-2.5" aria-label={t('控制台模块', 'Console modules')}>
          {NAV.map((n) => (
            n.live ? (
              <Tabs.Trigger
                key={n.v}
                value={n.v}
                className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-semibold text-ink-soft transition data-[state=active]:bg-white data-[state=active]:text-brand-600 data-[state=active]:shadow-card hover:bg-white/70"
              >
                <n.icon size={15} className="text-ink-mute group-data-[state=active]:text-brand-500" />{n.label}
              </Tabs.Trigger>
            ) : (
              <div key={n.v} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12.5px] font-semibold text-ink-mute/60">
                <n.icon size={15} className="opacity-50" />{n.label}
              </div>
            )
          ))}
        </Tabs.List>

        {/* 经营看板 */}
        <Tabs.Content value="ops" className="p-4 focus:outline-none">
          <div className="mb-3 flex gap-2"><Pill active>{t('全部店铺', 'All stores')}</Pill><Pill>{d14}</Pill><Pill>USD</Pill></div>
          <KpiRow items={[
            { label: `${t('销售额', 'Sales')} · ${demo}`, value: '$128,640', delta: '12.4%', good: true, spark: [6, 7, 6.5, 8, 7.6, 9, 8.4, 9.8] },
            { label: `${t('订单数', 'Orders')} · ${demo}`, value: '2,860', delta: '6.2%', good: true, spark: [4, 4.3, 4.1, 4.6, 4.4, 4.8, 4.7, 5] },
            { label: `${t('退款率', 'Refund rate')} · ${demo}`, value: '1.8%', delta: '0.3%', good: true, spark: [2.4, 2.3, 2.2, 2.1, 2.0, 1.9, 1.85, 1.8] },
          ]} />
          <div className="mt-3 grid grid-cols-[1.5fr_0.9fr] gap-3">
            <Panel title={t('销售额与毛利趋势', 'Sales & gross profit')} sub={`${d14} · ${demo}`}><EChart ariaLabel={t('销售额与毛利趋势演示图', 'Sales and gross profit demo chart')} option={salesTrendOption([7.2, 8.1, 7.6, 9.3, 8.8, 10.2, 9.6, 11.2, 10.4, 12.1, 11.3, 12.8, 12.1, 13.6].map(v => v * 1000), [2.1, 2.4, 2.2, 2.9, 2.7, 3.2, 3.0, 3.5, 3.3, 3.8, 3.6, 4.1, 3.9, 4.4].map(v => v * 1000), lang)} height={186} /></Panel>
            <Panel title={t('站点占比', 'Marketplace mix')} sub={demo}><EChart ariaLabel={t('站点销售额占比演示图', 'Marketplace share demo chart')} option={siteShareOption(lang)} height={186} /></Panel>
          </div>
        </Tabs.Content>

        {/* 广告（只读） */}
        <Tabs.Content value="ads" className="p-4 focus:outline-none">
          <div className="mb-3 flex items-center gap-2">
            <Pill active>{t('全部广告账户', 'All ad accounts')}</Pill><Pill>{d14}</Pill>
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-[#fff7e8] px-3 py-1 text-[11.5px] font-bold text-warning"><Lock size={12} />{t('只读授权', 'Read-only')}</span>
          </div>
          <KpiRow items={[
            { label: `${t('广告花费', 'Ad spend')} · ${demo}`, value: '$9,040', delta: '4.1%', good: false, spark: [5, 5.4, 5.2, 5.8, 6.1, 6.4, 6.2, 6.6] },
            { label: `ACoS · ${demo}`, value: '18.3%', delta: '1.1%', good: true, spark: [6, 5.7, 5.9, 5.4, 5.5, 5.2, 5.3, 5] },
            { label: `${t('广告销售额', 'Ad sales')} · ${demo}`, value: '$49,400', delta: '9.7%', good: true, spark: [4, 4.4, 4.2, 4.8, 4.6, 5.1, 5.0, 5.4] },
          ]} />
          <div className="mt-3 grid grid-cols-[1.1fr_1fr] gap-3">
            <Panel title={t('广告花费结构', 'Ad spend breakdown')} sub={`SP / SB · ${demo}`}><EChart ariaLabel={t('广告花费结构演示图', 'Ad spend breakdown demo chart')} option={adsBreakdownOption(lang)} height={178} /></Panel>
            <div className="rounded-xl border border-line bg-white p-3.5">
              <div className="mb-2 flex items-center justify-between"><h4 className="text-[13px] font-bold text-ink">{t('活动表现', 'Campaigns')}</h4><span className="text-[11px] text-ink-mute">{t('只读', 'Read-only')} · {demo}</span></div>
              {[[t('SP · 自动', 'SP · Auto'), '72%', 'ACoS 16.2%'], [t('SP · 手动', 'SP · Manual'), '54%', 'ACoS 19.8%'], [t('SB · 品牌', 'SB · Brand'), '38%', 'ACoS 22.4%']].map(([n, w, a]) => (
                <div key={n} className="my-2.5 grid grid-cols-[88px_1fr_66px] items-center gap-3 text-[12.5px] text-ink-soft">
                  <span>{n}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-[#eef1f6]"><i className="block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600" style={{ width: w }} /></span>
                  <em className="text-right font-bold not-italic text-ink">{a}</em>
                </div>
              ))}
              <p className="mt-3 text-[11.5px] leading-5 text-ink-mute">{t('广告数据仅用于查看与对账，不改出价、不代投放。', 'Advertising data is for viewing and reconciliation only — no bid changes, no managed campaigns.')}</p>
            </div>
          </div>
        </Tabs.Content>

        {/* 库存 */}
        <Tabs.Content value="inv" className="p-4 focus:outline-none">
          <div className="mb-3 flex gap-2"><Pill active>{t('全部店铺', 'All stores')}</Pill><Pill>FBA</Pill><Pill>{t('US 站', 'US')}</Pill></div>
          <KpiRow items={[
            { label: `${t('可售 SKU', 'Sellable SKUs')} · ${demo}`, value: '1,286', delta: '2.1%', good: true, spark: [5, 5.1, 5.2, 5.2, 5.3, 5.3, 5.4, 5.4] },
            { label: `${t('低库存 SKU', 'Low-stock SKUs')} · ${demo}`, value: '14', delta: t('3 项', '+3'), good: false, spark: [2, 2.2, 2.5, 2.8, 3.0, 3.3, 3.6, 3.8] },
            { label: `${t('在途库存', 'Inbound units')} · ${demo}`, value: '132', delta: '6.0%', good: true, spark: [3, 3.2, 3.1, 3.5, 3.6, 3.9, 4.0, 4.2] },
          ]} />
          <div className="mt-3 grid grid-cols-[1.3fr_1fr] gap-3">
            <Panel title={t('库存可售天数', 'Days of cover')} sub={`${t('低于补货线标橙', 'Below reorder line in orange')} · ${demo}`}><EChart ariaLabel={t('库存可售天数演示图', 'Days of cover demo chart')} option={inventoryTurnOption(lang)} height={182} /></Panel>
            <div className="rounded-xl border border-line bg-white p-3.5">
              <div className="mb-2 flex items-center justify-between"><h4 className="text-[13px] font-bold text-ink">{t('补货提醒', 'Reorder alerts')}</h4><span className="text-[11px] text-ink-mute">{demo}</span></div>
              {[['SKU-D4', t('9 天', '9d'), true], ['SKU-B2', t('18 天', '18d'), true], ['SKU-F6', t('27 天', '27d'), false]].map(([s, d, warn]) => (
                <div key={s as string} className="my-2 flex items-center justify-between rounded-lg border border-line px-3 py-2 text-[12.5px]">
                  <span className="font-semibold text-ink">{s}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-bold ${warn ? 'bg-[#fff7e8] text-warning' : 'bg-[#e8f7ef] text-success'}`}>{t('可售', 'cover')} {d}</span>
                </div>
              ))}
              <p className="mt-3 text-[11.5px] leading-5 text-ink-mute">{t('入库计划需卖家授权后创建，货件号来自同步结果。', 'Inbound plans require seller authorization first; shipment IDs come from sync results.')}</p>
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
