import * as Tabs from '@radix-ui/react-tabs'
import { Building2, Coins, Megaphone, Gauge, Check, CircleDot } from 'lucide-react'
import { EChart } from '../ui/chart'
import { useT } from './i18n'
import { Reveal } from '../ui/motion'

export function Solutions() {
  const t = useT()

  const MULTI_STORE = (
    <div className="space-y-2.5">
      {[[t('美国 · 旗舰店', 'US · Flagship'), t('已授权', 'Authorized'), true], [t('欧洲 · 精品店', 'EU · Boutique'), t('已授权', 'Authorized'), true], [t('日本 · 新店', 'JP · New store'), t('待授权', 'Pending'), false]].map(([n, s, ok]) => (
        <div key={n as string} className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3">
          <div className="flex items-center gap-3">
            <span className={`grid h-9 w-9 place-items-center rounded-lg ${ok ? 'bg-brand-50 text-brand-500' : 'bg-canvas-sunk text-ink-mute'}`}><Building2 size={17} /></span>
            <div><b className="block text-[14px] font-semibold text-ink">{n}</b><span className="text-[12px] text-ink-mute">{t('独立法律主体 · 独立账套', 'Separate legal entity · separate books')}</span></div>
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-bold ${ok ? 'bg-[#e8f7ef] text-success' : 'bg-[#fff7e8] text-warning'}`}><CircleDot size={11} />{s}</span>
        </div>
      ))}
      <p className="pt-1 text-[12px] text-ink-mute">{t('未授权的公司不会出现在合并报表里。演示数据。', 'Companies that have not authorized never appear in consolidated reports. Sample data.')}</p>
    </div>
  )

  const MULTI_CURRENCY = (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="grid grid-cols-4 bg-canvas-soft px-4 py-2.5 text-[12px] font-semibold text-ink-mute"><span>{t('币种', 'Currency')}</span><span className="text-right">{t('收入', 'Revenue')}</span><span className="text-right">{t('费用', 'Fees')}</span><span className="text-right">{t('净额', 'Net')}</span></div>
      {[['USD', '86,400', '18,200', '68,200'], ['EUR', '32,100', '7,400', '24,700'], ['JPY', '21,800', '5,100', '16,700']].map((r) => (
        <div key={r[0]} className="grid grid-cols-4 border-t border-line px-4 py-3 text-[13px]">
          <span className="font-semibold text-ink">{r[0]}</span>
          <span className="text-right text-ink-soft">{r[1]}</span>
          <span className="text-right text-ink-soft">{r[2]}</span>
          <span className="text-right font-bold text-success">{r[3]}</span>
        </div>
      ))}
      <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-mute">{t('各币种独立核对，不做汇率合并估算。演示数据。', 'Each currency is reconciled on its own, with no FX-merged estimate. Sample data.')}</p>
    </div>
  )

  const ADS_READONLY = (
    <EChart ariaLabel={t('广告花费结构演示图', 'Ad spend breakdown demo chart')} height={240} option={{
      color: ['#2b63f0'], grid: { left: 8, right: 36, top: 10, bottom: 10, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f3f7' } }, axisLabel: { color: '#9aa3b2', fontSize: 10, formatter: '${value}' } },
      yAxis: { type: 'category', data: [t('SB 品牌', 'SB'), t('SD 展示', 'SD'), t('SP 手动', 'SP manual'), t('SP 自动', 'SP auto')], axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#4e5969', fontSize: 11 } },
      series: [{ type: 'bar', data: [1240, 1980, 3180, 4620], barWidth: 14, itemStyle: { borderRadius: [0, 7, 7, 0], color: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: '#5b86ff' }, { offset: 1, color: '#2b63f0' }] } } as never, label: { show: true, position: 'right', color: '#86909c', fontSize: 10, formatter: '${@[0]}' } }],
    }} />
  )

  const OPS = (
    <div className="grid grid-cols-2 gap-3">
      {[[t('周转天数', 'Turnover days'), '31.4', t('天', 'd')], [t('缺货预警', 'Stockout alerts'), '14', t('项', '')], [t('准时发货率', 'On-time ship'), '98.6', '%'], [t('退款率', 'Refund rate'), '1.8', '%']].map((k) => (
        <div key={k[0]} className="rounded-xl border border-line bg-white px-4 py-3.5">
          <div className="text-[12px] text-ink-mute">{k[0]} · {t('演示', 'Sample')}</div>
          <div className="mt-1 text-[24px] font-bold tracking-tight text-ink">{k[1]}<span className="ml-1 text-[13px] font-medium text-ink-mute">{k[2]}</span></div>
        </div>
      ))}
    </div>
  )

  const TABS = [
    { v: 'store', icon: Building2, label: t('多店铺 / 多公司', 'Multi-store / multi-company'), title: t('多家公司一起经营，账套分开看清', 'Run several companies together, with books kept separate'), points: [t('每家公司独立账套、分开对账', 'Each company keeps its own books'), t('合并报表按主体清晰归属', 'Consolidated reports stay attributed by entity'), t('成员按主体分权，互不串看', 'Members are scoped per entity and cannot cross-view')], panel: MULTI_STORE },
    { v: 'currency', icon: Coins, label: t('多币种对账', 'Multi-currency'), title: t('同一币种内核对收支，不做汇率估算', 'Reconcile within one currency, with no FX estimate'), points: [t('收入 / 费用 / 退款按币种分列', 'Revenue / fees / refunds listed by currency'), t('退款可对回原订单月', 'Refunds trace back to the order month'), t('结算、费用、广告分项可查', 'Settlements, fees and advertising broken out')], panel: MULTI_CURRENCY },
    { v: 'ads', icon: Megaphone, label: t('广告只读报表', 'Read-only ad reports'), title: t('广告账户单独连接，报表只读查看', 'Ad accounts connected separately, reports read-only'), points: [t('花费 / 点击 / ACoS / ROAS 集中看', 'Spend / clicks / ACoS / ROAS in one place'), t('不改出价、不代投放', 'No bid changes, no managed campaigns'), t('广告与店铺数据分开管理', 'Ads and store data kept separate')], panel: ADS_READONLY },
    { v: 'ops', icon: Gauge, label: t('精细化运营', 'Fine-grained ops'), title: t('库存、订单、财务联动的经营视图', 'An operating view linking inventory, orders and finance'), points: [t('库存周转与补货线预警', 'Inventory turnover and reorder alerts'), t('订单状态与履约跟踪', 'Order status and fulfillment tracking'), t('关键经营指标一屏汇总', 'Key operating metrics on one screen')], panel: OPS },
  ]

  return (
    <section className="bg-canvas-soft py-20">
      <div className="nv-container-wide">
        <Reveal className="mx-auto max-w-[720px] text-center">
          <span className="nv-eyebrow">{t('解决方案', 'Solutions')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{t('按你的经营场景，组合需要的能力', 'Combine the capabilities your scenario needs')}</h2>
          <p className="mt-3 text-[16px] leading-7 text-ink-soft">{t('无论是多店铺分账、多币种对账，还是广告只读报表，都在一个工作台查看与核对。', 'Multi-store books, multi-currency reconciliation or read-only ad reports — all viewed and checked in one workspace.')}</p>
        </Reveal>

        <Reveal className="mt-12">
          <Tabs.Root defaultValue="store">
            <Tabs.List className="mx-auto flex max-w-fit flex-wrap justify-center gap-1.5 rounded-2xl border border-line bg-white p-1.5 shadow-card" aria-label={t('解决方案场景', 'Solution scenarios')}>
              {TABS.map((tab) => (
                <Tabs.Trigger key={tab.v} value={tab.v} className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-semibold text-ink-soft transition data-[state=active]:bg-brand-500 data-[state=active]:text-white data-[state=active]:shadow-glow hover:text-ink data-[state=active]:hover:text-white">
                  <tab.icon size={16} />{tab.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            {TABS.map((tab) => (
              <Tabs.Content key={tab.v} value={tab.v} className="mt-8 focus:outline-none">
                <div className="grid items-center gap-10 rounded-3xl border border-line bg-white p-8 shadow-card lg:grid-cols-2 lg:p-12">
                  <div>
                    <span className="grid h-12 w-12 place-items-center text-brand-600"><tab.icon size={28} strokeWidth={1.6} /></span>
                    <h3 className="mt-5 text-[26px] font-bold leading-snug text-ink">{tab.title}</h3>
                    <ul className="mt-6 space-y-3">
                      {tab.points.map((p) => (
                        <li key={p} className="flex items-start gap-2.5 text-[15px] text-ink-soft">
                          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success/12 text-success"><Check size={13} strokeWidth={3} /></span>{p}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>{tab.panel}</div>
                </div>
              </Tabs.Content>
            ))}
          </Tabs.Root>
        </Reveal>
      </div>
    </section>
  )
}
