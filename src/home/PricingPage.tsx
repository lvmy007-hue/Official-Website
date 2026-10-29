import { Check, Minus, ArrowRight, FileText, Building2, Layers, Sparkles, ShieldAlert } from 'lucide-react'
import { Header } from './Header'
import { Footer } from './Footer'
import { LangContext, type Lang } from './i18n'
import { SiteLink } from '../site-link'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'
import { pricingScenarios, pricingFactors, pricingSteps, pricingBands, planMatrix } from '../public-product-content'

const PLAN_ICON = [Building2, Layers, Sparkles]
const BAND_ICON = [FileText, Layers, ShieldAlert]

const enScenarios = [
  { name: 'Single company', entities: '1 legal entity', stores: '1–5 stores', includes: 'Orders, returns, inventory, listings, inbound, finance and member permissions. Advertising not included.', quote: 'The written plan lists this tier’s annual fee. No online payment, and samples are never written as list prices.' },
  { name: 'Multiple companies', entities: 'Up to 3 legal entities', stores: '6–20 stores', includes: 'Everything in the single-company tier, plus read-only advertising reports. Each entity reconciled separately.', quote: 'The written plan itemizes by number of entities and whether advertising is included.' },
  { name: 'Beyond the above', entities: 'More than 3 legal entities', stores: '20+ stores, or on-site implementation needed', includes: 'Modules are combined to the confirmed scope; managed ad operations are not included by default.', quote: 'A separate plan is issued rather than applying the first two tiers.' },
]
const enFactors = ['Number of legal entities', 'Store scale', 'User seats', 'Modules used', 'Sync frequency', 'Implementation or customization']
const enSteps: [string, string, string][] = [
  ['01', 'Submit an inquiry', 'On the contact page, tell us the number of entities, store scale and the reports you need.'],
  ['02', 'Confirm scope', 'Confirm which companies connect and whether you’ll use orders, returns, finance or advertising.'],
  ['03', 'Written plan', 'Fees, term and support follow the written plan confirmed by both sides.'],
]
const enBands = [
  { title: 'What the plan specifies', text: 'Workspace scope, how data is viewed, member permissions, and whether the orders, returns and finance modules are included.' },
  { title: 'Scope to confirm separately', text: 'On-site implementation, extra customization and sync frequency depend on your connection scope. Managed ad operations are not part of this service.' },
  { title: 'Delivery boundary', text: 'Delivered to the confirmed scope. We provide advertising reports and analytics software, not managed ad operations.' },
]
const enMatrix = {
  heads: ['Capability', 'Single company', 'Multiple companies', 'Beyond scope'],
  rows: [
    ['Orders, returns, inventory', '●', '●', '●'],
    ['Listings & FBA inbound', '●', '●', '●'],
    ['Monthly close & multi-currency reconciliation', '●', '●', '●'],
    ['Purchasing, suppliers & warehouse ledger', '●', '●', '●'],
    ['Member permissions & audit', '●', '●', '●'],
    ['Read-only advertising reports', '—', '●', '●'],
    ['Separated by legal entity', '1 company', 'Up to 3', 'Per plan'],
    ['Implementation', 'Remote onboarding', 'Implementation included', 'On-site implementation'],
  ],
}

export function PricingPage({ lang = 'zh' }: { lang?: Lang }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const base = lang === 'en' ? '/en' : ''
  const scenarios = lang === 'en' ? enScenarios : pricingScenarios
  const factors = lang === 'en' ? enFactors : pricingFactors
  const steps = lang === 'en' ? enSteps : pricingSteps
  const bands = lang === 'en' ? enBands : pricingBands
  const matrix = lang === 'en' ? enMatrix : planMatrix
  return (
    <LangContext.Provider value={lang}>
      <div className="nv min-h-screen bg-white font-sans text-ink antialiased" lang={lang}>
        <Header />
        <main>
          {/* Hero */}
          <section className="border-b border-line bg-canvas-soft">
            <div className="nv-container-wide py-16 lg:py-20">
              <Reveal className="mx-auto flex max-w-[760px] flex-col items-center text-center">
                <span className="nv-eyebrow"><FileText size={13} />{tr('价格与方案', 'Pricing & plans')}</span>
                <h1 className="mt-5 text-display font-extrabold text-ink">{tr('按经营规模，', 'Priced to your scale — ')}<span className="nv-text-gradient">{tr('获取书面报价', 'a written quote')}</span></h1>
                <p className="mt-5 max-w-[560px] text-[16.5px] leading-[1.75] text-ink-soft">{tr('费用依据法律主体数量、店铺规模与使用的模块确定。网页不收款，所有费用以双方确认的书面方案为准。', 'Fees are based on the number of legal entities, store scale and the modules you use. The site takes no online payment; all fees follow the written plan confirmed by both sides.')}</p>
                <div className="mt-7 flex gap-3">
                  <SiteLink href={`${base}/contact`} className="nv-btn nv-btn-primary">{tr('获取报价', 'Get a quote')}<ArrowRight size={16} /></SiteLink>
                  <SiteLink href={`${base}/product`} className="nv-btn nv-btn-ghost">{tr('查看产品能力', 'Explore capabilities')}</SiteLink>
                </div>
              </Reveal>
            </div>
          </section>

          {/* 三档方案 */}
          <section className="pb-6">
            <div className="nv-container-wide">
              <Stagger className="grid gap-5 lg:grid-cols-3">
                {scenarios.map((p, i) => {
                  const Icon = PLAN_ICON[i] ?? Building2
                  const featured = i === 1
                  return (
                    <StaggerItem key={p.name}>
                      <div className={`relative flex h-full flex-col rounded-3xl border p-8 transition ${featured ? 'border-brand-500 bg-white shadow-float ring-1 ring-brand-500/20' : 'border-line bg-white shadow-card hover:-translate-y-1 hover:shadow-float'}`}>
                        {featured ? <span className="absolute right-6 top-6 rounded-full bg-brand-500 px-3 py-1 text-[11.5px] font-bold text-white">{tr('较常见', 'Most common')}</span> : null}
                        <span className="grid h-12 w-12 place-items-center text-brand-600"><Icon size={28} strokeWidth={1.6} /></span>
                        <h3 className="mt-5 text-[20px] font-bold text-ink">{p.name}</h3>
                        <div className="mt-4 flex items-baseline gap-2">
                          <span className="text-[28px] font-extrabold tracking-tight text-ink">{tr('书面报价', 'Written quote')}</span>
                        </div>
                        <p className="mt-1 text-[12.5px] text-ink-mute">{tr('网页不收款，按方案签约', 'No online payment; contract by plan')}</p>

                        <dl className="mt-6 space-y-3 border-t border-line pt-6 text-[14px]">
                          <div className="flex gap-3"><dt className="w-20 shrink-0 text-ink-mute">{tr('主体', 'Entities')}</dt><dd className="font-medium text-ink">{p.entities}</dd></div>
                          <div className="flex gap-3"><dt className="w-20 shrink-0 text-ink-mute">{tr('店铺', 'Stores')}</dt><dd className="font-medium text-ink">{p.stores}</dd></div>
                          <div className="flex gap-3"><dt className="w-20 shrink-0 text-ink-mute">{tr('实施对接', 'Onboarding')}</dt><dd className="font-medium text-ink">{matrix.rows[7][i + 1]}</dd></div>
                        </dl>
                        <ul className="mt-6 space-y-2.5 border-t border-line pt-6 text-[13.5px]">
                          {matrix.rows.slice(0, 6).map((row) => {
                            const included = row[i + 1] === '●'
                            return (
                              <li key={row[0]} className="flex items-start gap-2.5">
                                {included
                                  ? <Check size={16} className="mt-0.5 shrink-0 text-brand-500" strokeWidth={3} />
                                  : <Minus size={16} className="mt-0.5 shrink-0 text-ink-mute/40" />}
                                <span className={included ? 'text-ink-soft' : 'text-ink-mute/60'}>{row[0]}</span>
                              </li>
                            )
                          })}
                        </ul>
                        <p className="mt-5 flex-1 text-[12px] leading-5 text-ink-mute">{p.quote}</p>
                        <SiteLink href={`${base}/contact`} className={`nv-btn mt-6 w-full ${featured ? 'nv-btn-primary' : 'nv-btn-ghost'}`}>{tr('获取此档报价', 'Get a quote for this tier')}<ArrowRight size={15} /></SiteLink>
                      </div>
                    </StaggerItem>
                  )
                })}
              </Stagger>
            </div>
          </section>

          {/* 报价影响因素 */}
          <section className="py-16">
            <div className="nv-container-wide">
              <Reveal className="rounded-3xl border border-line bg-canvas-soft p-8 lg:p-12">
                <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
                  <div>
                    <span className="nv-eyebrow">{tr('影响报价的因素', 'What affects the quote')}</span>
                    <h2 className="mt-4 text-h2 font-bold text-ink">{tr('报价按实际接入范围核算', 'Quoted by your actual connection scope')}</h2>
                    <p className="mt-3 text-[15px] leading-7 text-ink-soft">{tr('我们不预设统一标价，而是依据下列因素出具书面方案，确保与你的经营规模匹配。', 'We don’t preset a single list price; we issue a written plan based on the factors below so it matches your scale.')}</p>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    {factors.map((f) => (
                      <span key={f} className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2.5 text-[13.5px] font-semibold text-ink-soft shadow-card">
                        <Check size={14} className="text-brand-500" strokeWidth={3} />{f}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>
            </div>
          </section>

          {/* 流程 + 边界 */}
          <section className="pb-16">
            <div className="nv-container-wide grid gap-12 lg:grid-cols-2">
              <Reveal>
                <span className="nv-eyebrow">{tr('开通流程', 'Onboarding')}</span>
                <h2 className="mt-4 text-h2 font-bold text-ink">{tr('三步获取方案', 'Three steps to a plan')}</h2>
                <ol className="mt-8 space-y-5">
                  {steps.map(([n, t, d]) => (
                    <li key={n} className="flex gap-4">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-[15px] font-extrabold text-brand-600">{n}</span>
                      <div><b className="block text-[16px] font-bold text-ink">{t}</b><p className="mt-1 text-[14px] leading-6 text-ink-soft">{d}</p></div>
                    </li>
                  ))}
                </ol>
              </Reveal>
              <Reveal delay={0.1}>
                <span className="nv-eyebrow">{tr('方案边界', 'Plan boundaries')}</span>
                <h2 className="mt-4 text-h2 font-bold text-ink">{tr('方案里会写清楚的事', 'What the plan spells out')}</h2>
                <div className="mt-8 space-y-4">
                  {bands.map((b, i) => {
                    const Icon = BAND_ICON[i] ?? FileText
                    return (
                      <div key={b.title} className="flex gap-4 rounded-2xl border border-line bg-white p-5 shadow-card">
                        <span className="grid h-10 w-10 shrink-0 place-items-center text-brand-600"><Icon size={24} strokeWidth={1.6} /></span>
                        <div><b className="block text-[15px] font-bold text-ink">{b.title}</b><p className="mt-1 text-[13.5px] leading-6 text-ink-soft">{b.text}</p></div>
                      </div>
                    )
                  })}
                </div>
              </Reveal>
            </div>
          </section>

        </main>
        <Footer />
      </div>
    </LangContext.Provider>
  )
}
