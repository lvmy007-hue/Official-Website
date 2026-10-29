import { Building2, Globe, Wallet, Megaphone, Check, ArrowRight } from 'lucide-react'
import { SiteLink } from '../site-link'
import { useT, useL } from './i18n'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'

export function Scenarios() {
  const t = useT()
  const L = useL()
  const CARDS = [
    {
      icon: Building2,
      title: t('多公司矩阵经营', 'Multi-entity operations'),
      d: t('多个法律主体、多家店铺并行经营，各公司账套分开对账、互不混淆。', 'Run several legal entities and stores in parallel, with books kept separate and clean per company.'),
      points: [
        t('主体—账号—站点三层登记', 'Entity–account–marketplace registration'),
        t('成员按公司分权、各看各的', 'Members scoped to their own companies'),
        t('合并视图仍按法律主体区分', 'Merged views still split by legal entity'),
      ],
    },
    {
      icon: Globe,
      title: t('多站点扩张', 'Multi-marketplace growth'),
      d: t('同一品牌在多个站点销售，多币种数据统一查看，不同币种不相加。', 'Sell one brand across marketplaces and view multi-currency data together, without mixing currencies.'),
      points: [
        t('美 / 欧 / 日多站点集中查看', 'US / EU / JP marketplaces in one view'),
        t('各币种分别统计、不做合并', 'Each currency counted separately'),
        t('按站点对比销量与库存周转', 'Compare sales and turnover by marketplace'),
      ],
    },
    {
      icon: Wallet,
      title: t('财务精细核算', 'Precise finance'),
      d: t('跨月退货对回原订单月份，收入、退款、费用按币种核对，月结更准确。', 'Trace cross-month refunds back to the order month and reconcile revenue, refunds and fees by currency.'),
      points: [
        t('跨月退款对回原订单月', 'Cross-month refunds mapped to order month'),
        t('佣金 / FBA / 仓储费分项可查', 'Commission / FBA / storage fees itemized'),
        t('按法律主体与币种出月报', 'Monthly reports by entity and currency'),
      ],
    },
    {
      icon: Megaphone,
      title: t('广告独立分析', 'Standalone ad analysis'),
      d: t('广告账户单独连接，只读查看花费、点击与广告销售额，用于分析与对账。', 'Connect the ads account on its own and view spend, clicks and ad sales read-only for analysis.'),
      points: [
        t('广告账户单独连接、只读', 'Ads account connected on its own, read-only'),
        t('ACoS / ROAS 集中监控', 'ACoS / ROAS monitored in one place'),
        t('按活动类型拆解花费结构', 'Spend broken down by campaign type'),
      ],
    },
  ]
  return (
    <section className="border-y border-line bg-canvas-soft py-20">
      <div className="nv-container-wide">
        <Reveal className="mx-auto max-w-[720px] text-center">
          <span className="nv-eyebrow">{t('适配经营场景', 'Fits your operation')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{t('为不同的跨境经营方式而设计', 'Built for different ways of selling cross-border')}</h2>
          <p className="mt-3 text-[16px] leading-7 text-ink-soft">{t('无论是多公司矩阵、多站点扩张，还是专注财务与广告分析，NOVA ERP 都能对上你的经营结构。', 'Whether you run a multi-entity matrix, expand across marketplaces, or focus on finance and ad analysis, NOVA ERP matches how you operate.')}</p>
        </Reveal>
        <Stagger className="mt-12 grid gap-5 lg:grid-cols-2">
          {CARDS.map((c) => (
            <StaggerItem key={c.title}>
              <div className="flex h-full gap-5 rounded-3xl border border-line bg-white p-7 shadow-card transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-float">
                <span className="grid h-12 w-12 shrink-0 place-items-center text-brand-600"><c.icon size={28} strokeWidth={1.6} /></span>
                <div className="flex-1">
                  <b className="text-[17.5px] font-bold text-ink">{c.title}</b>
                  <p className="mt-2 text-[13.5px] leading-6 text-ink-soft">{c.d}</p>
                  <ul className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-2">
                    {c.points.map((p) => (
                      <li key={p} className="flex items-start gap-2 text-[12.5px] leading-5 text-ink-soft"><Check size={13} strokeWidth={3} className="mt-0.5 shrink-0 text-brand-500" />{p}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
        <Reveal className="mt-10 text-center">
          <SiteLink href={L('/solutions')} className="nv-btn nv-btn-ghost">{t('查看解决方案', 'View solutions')}<ArrowRight size={15} /></SiteLink>
        </Reveal>
      </div>
    </section>
  )
}
