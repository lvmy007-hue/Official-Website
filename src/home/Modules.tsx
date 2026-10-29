import { Boxes, Wallet, Megaphone, ArrowRight, Check } from 'lucide-react'
import { EChart } from '../ui/chart'
import { SiteLink } from '../site-link'
import { useLang, useT, useL } from './i18n'
import { Reveal } from '../ui/motion'
import { adsBreakdownOption, inventoryTurnOption, salesTrendOption } from './panels'

function Window({ title, demo, children }: { title: string; demo: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#eef1f6] bg-white shadow-float">
      <div className="flex h-10 items-center gap-2.5 border-b border-line bg-[#fbfcfe] px-4">
        <span className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#ff6159]" /><i className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" /><i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" /></span>
        <span className="text-[12px] font-semibold text-ink-soft">{title}</span>
        <span className="ml-auto rounded-full bg-brand-50 px-2.5 py-0.5 text-[11px] font-bold text-brand-600">{demo}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function ModuleBlock({ eyebrow, icon: Icon, title, lede, points, href, flip, cta, children }: {
  eyebrow: string; icon: typeof Boxes; title: string; lede: string; points: string[]; href: string; flip?: boolean; cta: string; children: React.ReactNode
}) {
  return (
    <div className="grid items-center gap-12 lg:grid-cols-2">
      <Reveal className={flip ? 'lg:order-2' : ''}>
        <span className="nv-eyebrow"><Icon size={13} />{eyebrow}</span>
        <h3 className="mt-4 text-[30px] font-bold leading-tight text-ink">{title}</h3>
        <p className="mt-4 max-w-[520px] text-[16px] leading-7 text-ink-soft">{lede}</p>
        <ul className="mt-6 space-y-3">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-[15px] text-ink-soft">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-500"><Check size={13} strokeWidth={3} /></span>{p}
            </li>
          ))}
        </ul>
        <SiteLink href={href} className="nv-btn nv-btn-ghost mt-7">{cta}<ArrowRight size={15} /></SiteLink>
      </Reveal>
      <Reveal className={flip ? 'lg:order-1' : ''} delay={0.1}>{children}</Reveal>
    </div>
  )
}

export function Modules() {
  const lang = useLang()
  const t = useT()
  const L = useL()
  const demo = t('演示数据', 'Sample data')
  const cta = t('了解详情', 'Learn more')
  return (
    <section className="space-y-24 py-20">
      <div className="nv-container-wide">
        <ModuleBlock
          eyebrow={t('进销存一体', 'Inventory & orders')} icon={Boxes}
          title={t('库存、入库、刊登、订单，挂在同一账号下', 'Inventory, inbound, listings and orders under one account')}
          lede={t('从可售、预留到在途一屏可见，低于补货线自动标橙。入库计划在卖家授权后创建，货件号来自同步结果。', 'Sellable, reserved and inbound units on one screen; below the reorder line is flagged. Inbound plans are created after seller authorization and shipment IDs come from sync.')}
          points={[t('可售天数与补货线预警', 'Days of cover with reorder alerts'), t('FBA 入库计划与接收进度', 'FBA inbound plans and received progress'), t('ASIN / SKU 与订单库存对照', 'ASIN / SKU matched to orders and inventory')]}
          href={L('/product/inventory')} cta={cta}
        >
          <Window title={t('库存 / 可售天数', 'Inventory / Days of cover')} demo={demo}><EChart ariaLabel={t('库存可售天数演示图', 'Days of cover demo chart')} height={260} option={inventoryTurnOption(lang)} /></Window>
        </ModuleBlock>
      </div>

      <div className="bg-canvas-soft py-24">
        <div className="nv-container-wide">
          <ModuleBlock
            flip
            eyebrow={t('财务精准', 'Finance')} icon={Wallet}
            title={t('收入、退款、费用，在同一币种里对账', 'Revenue, refunds and fees reconciled within one currency')}
            lede={t('销售额与毛利同屏对照，退款可对回原订单月，不算进新销售。结算、费用、广告分项清晰，便于核对。', 'Sales and gross profit side by side; refunds trace back to the order month rather than new sales. Settlements, fees and advertising are broken out for checking.')}
            points={[t('销售额与毛利趋势对照', 'Sales and gross profit trend'), t('跨月退款对回原订单月', 'Cross-month refunds back to the order month'), t('多币种分列、不做汇率合并', 'Currencies listed separately, no FX merge')]}
            href={L('/product/finance')} cta={cta}
          >
            <Window title={t('财务 / 销售额与毛利', 'Finance / Sales & gross profit')} demo={demo}>
              <EChart ariaLabel={t('销售额与毛利趋势演示图', 'Sales and gross profit demo chart')} height={260} option={salesTrendOption([7.2, 8.1, 7.6, 9.3, 8.8, 10.2, 9.6, 11.2, 10.4, 12.1, 11.3, 12.8, 12.1, 13.6].map(v => v * 1000), [2.1, 2.4, 2.2, 2.9, 2.7, 3.2, 3.0, 3.5, 3.3, 3.8, 3.6, 4.1, 3.9, 4.4].map(v => v * 1000), lang)} />
            </Window>
          </ModuleBlock>
        </div>
      </div>

      <div className="nv-container-wide">
        <ModuleBlock
          eyebrow={t('广告只读', 'Advertising, read-only')} icon={Megaphone}
          title={t('广告账户单独连接后，花费与 ACoS 集中查看', 'After separate connection, spend and ACoS in one place')}
          lede={t('SP / SB / SD 各类广告的花费结构一目了然，报表只读，不改出价、不代投放。未授权时广告模块不出现。', 'The spend breakdown across SP / SB / SD is clear at a glance. Reports are read-only — no bid changes, no managed campaigns. The module is hidden until authorized.')}
          points={[t('花费 / 点击 / ACoS / ROAS 集中查看', 'Spend / clicks / ACoS / ROAS in one place'), t('只读查看，不代客户操作', 'Read-only, nothing acted on your behalf'), t('按活动类型拆解花费结构', 'Spend broken down by campaign type')]}
          href={L('/product/advertising')} cta={cta}
        >
          <Window title={t('广告 / 花费结构（只读）', 'Advertising / Spend breakdown (read-only)')} demo={demo}>
            <EChart ariaLabel={t('广告花费结构演示图', 'Ad spend breakdown demo chart')} height={220} option={adsBreakdownOption(lang)} />
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              {[[t('花费', 'Spend'), '$9,040'], ['ACoS', '18.3%'], [t('广告销售额', 'Ad sales'), '$49,400']].map((k) => (
                <div key={k[0]} className="rounded-xl bg-canvas-soft px-3 py-2.5 text-center"><div className="text-[11px] text-ink-mute">{k[0]} · {t('演示', 'Sample')}</div><div className="mt-1 text-[16px] font-bold text-ink">{k[1]}</div></div>
              ))}
            </div>
          </Window>
        </ModuleBlock>
      </div>
    </section>
  )
}
