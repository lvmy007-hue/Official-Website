import { Check, ArrowRight } from 'lucide-react'
import { SiteLink } from '../site-link'
import { company } from '../site-company'
import { enHero } from '../site-en'
import { useLang, useL } from './i18n'
import { HeroVisual } from './HeroVisual'

export function Hero() {
  const lang = useLang()
  const L = useL()
  const en = lang === 'en'
  const chips = en ? enHero.ticks : ['多主体 · 多站点统一纳管', '多币种独立核算与对账', '广告报表只读接入分析']
  return (
    <section className="border-b border-line">
      <div className="nv-container-wide grid items-center gap-12 py-16 lg:grid-cols-[0.92fr_1.08fr] lg:py-20">
        <div>
          <span className="nv-eyebrow">{en ? 'Cross-border commerce workspace' : '跨境电商经营中台'}</span>
          <h1 className="mt-5 text-display font-extrabold leading-[1.08] text-ink">
            {en ? (
              <>The operations platform<br className="hidden sm:block" /><span className="text-brand-600">for cross-border commerce</span></>
            ) : (
              <>跨境电商<br className="hidden sm:block" /><span className="text-brand-600">一体化经营平台</span></>
            )}
          </h1>
          <p className="mt-5 max-w-[520px] text-[16px] leading-[1.75] text-ink-soft">
            {en
              ? enHero.lede
              : 'NOVA ERP 面向多主体亚马逊卖家，将订单、库存、财务与广告报表统一在同一工作台；账套按法律主体独立核算，广告数据只读接入，买家信息依合规策略定期删除。'}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <SiteLink href={L('/contact')} className="nv-btn nv-btn-primary">{en ? 'Book a demo' : '预约演示'}<ArrowRight size={16} /></SiteLink>
            <SiteLink href={L('/pricing')} className="nv-btn nv-btn-ghost">{en ? 'See pricing' : '查看方案'}</SiteLink>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2.5">
            {chips.map((c) => (
              <li key={c} className="inline-flex items-center gap-2 text-[13.5px] font-medium text-ink-soft">
                <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-success/12 text-success"><Check size={12} strokeWidth={3} /></span>{c}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[12px] text-ink-mute">{en ? company.legalNameEn : company.legalName} · {en ? 'sample data on the right' : '右侧为演示数据，非真实店铺'}</p>
        </div>

        <div>
          <HeroVisual />
        </div>
      </div>
    </section>
  )
}
