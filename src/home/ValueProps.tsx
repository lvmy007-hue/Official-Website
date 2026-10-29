import { Clock, ShieldCheck, History, BarChart3, ArrowRight } from 'lucide-react'
import { SiteLink } from '../site-link'
import { useT, useL } from './i18n'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'

export function ValueProps() {
  const t = useT()
  const L = useL()
  const CARDS = [
    { icon: Clock, title: t('更省时', 'Save time'), d: t('多家公司、多店铺的订单、库存、财务与广告集中在一个工作台，不用在多个后台之间来回切换。', 'Orders, inventory, finance and ads for many companies and stores sit in one workspace, with no switching between back offices.') },
    { icon: ShieldCheck, title: t('更少错', 'Fewer mistakes'), d: t('收入、退款、费用按同一币种对账，口径统一，减少手工搬运与跨币种相加带来的差错。', 'Revenue, refunds and fees reconcile within one currency, keeping a consistent basis and cutting manual errors.') },
    { icon: History, title: t('可追溯', 'Traceable'), d: t('数据记录更新时间，登录、授权与读取留痕，每一步经营动作都能追溯。', 'Data carries update times, while logins, authorizations and reads are logged so every action can be traced.') },
    { icon: BarChart3, title: t('有依据', 'Decision-ready'), d: t('报表与经营指标集中呈现，为补货、投放与月结等决策提供可核对的数据依据。', 'Reports and operating metrics are brought together to back decisions on restocking, ads and monthly closing.') },
  ]
  return (
    <section className="border-b border-line py-20">
      <div className="nv-container-wide grid gap-x-16 gap-y-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-start">
        <Reveal className="lg:sticky lg:top-28">
          <span className="nv-eyebrow">{t('为什么选择 NOVA ERP', 'Why NOVA ERP')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{t('把经营管理变得更省时、更准、更可控', 'Make operations faster, more accurate and more controllable')}</h2>
          <p className="mt-4 text-[16px] leading-7 text-ink-soft">{t('NOVA ERP 在合规授权的前提下，帮跨境团队把分散的经营数据理顺，看清全貌、减少出错、留下依据。', 'Within compliant authorization, NOVA ERP helps cross-border teams organize scattered data, see the whole picture, reduce errors and keep an audit trail.')}</p>
          <SiteLink href={L('/product')} className="nv-btn nv-btn-primary mt-7">{t('查看产品能力', 'See capabilities')}<ArrowRight size={16} /></SiteLink>
        </Reveal>
        <Stagger>
          {CARDS.map((c, i) => (
            <StaggerItem key={c.title}>
              <div className="group flex items-start gap-6 border-t border-line py-7 first:border-t-0 first:pt-0">
                <span className="grid h-12 w-12 shrink-0 place-items-center text-brand-600"><c.icon size={28} strokeWidth={1.6} /></span>
                <div className="flex-1">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[13px] font-extrabold tabular-nums text-brand-300">{String(i + 1).padStart(2, '0')}</span>
                    <b className="text-[17.5px] font-bold text-ink">{c.title}</b>
                  </div>
                  <p className="mt-2 text-[14.5px] leading-7 text-ink-soft">{c.d}</p>
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
