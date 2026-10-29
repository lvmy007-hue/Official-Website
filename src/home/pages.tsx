import type { ReactNode } from 'react'
import { ArrowRight, ArrowUpRight, Mail, MapPin, Building2, ShieldCheck, FileText, BookOpen, Calendar, Check, Clock, Boxes, Wallet, BarChart3, PlayCircle, Link2, Globe, Megaphone, CircleDot, Eye, Users, Compass, Scale } from 'lucide-react'
import { Header } from './Header'
import { Footer } from './Footer'
import { SiteLink, nav } from '../site-link'
import { ContactForm } from '../contact-form'
import { company } from '../site-company'
import { legalBanner, privacySections, termsSections, securitySections } from '../public-site-content'
import { enPrivacy, enTerms, enSecurity, enLegal } from '../site-en'
import { guides, press } from '../site-commercial'
import { enGuides, enPress } from '../site-commercial-en'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'
import { LangContext, type Lang } from './i18n'

type T = (zh: string, en: string) => string

export function PageShell({ children, lang = 'zh' }: { children: ReactNode; lang?: Lang }) {
  return (
    <LangContext.Provider value={lang}>
      <div className="nv min-h-screen bg-white font-sans text-ink antialiased" lang={lang}>
        <Header />
        <main>{children}</main>
        <Footer />
      </div>
    </LangContext.Provider>
  )
}

export function PageHero({ eyebrow, title, lede, children }: { eyebrow: string; title: ReactNode; lede?: string; children?: ReactNode }) {
  return (
    <section className="border-b border-line bg-canvas-soft">
      <div className="nv-container-wide py-14 lg:py-16">
        <Reveal>
          <span className="nv-eyebrow">{eyebrow}</span>
          <h1 className="mt-5 max-w-[860px] text-h1 font-extrabold text-ink">{title}</h1>
          {lede ? <p className="mt-4 max-w-[640px] text-[16.5px] leading-[1.75] text-ink-soft">{lede}</p> : null}
          {children}
        </Reveal>
      </div>
    </section>
  )
}

/* ---------------- 关于 ---------------- */
export function AboutPage({ lang = 'zh' }: { lang?: Lang }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const base = lang === 'en' ? '/en' : ''
  const profile: [string, string][] = [
    [tr('运营应用', 'Operating app'), company.brand],
    [tr('成立日期', 'Founded'), company.foundedOn],
    [tr('办公所在地', 'Office'), tr(company.address, company.addressEn)],
    [tr('服务对象', 'Serves'), tr('跨境电商卖家团队', 'Cross-border e-commerce seller teams')],
    [tr('数据存放', 'Data residency'), tr(company.storageRegion, 'Within China (Mainland)')],
  ]
  const values = [
    { icon: Compass, t: tr('以经营者的视角做产品', 'Built from an operator’s point of view'), d: tr('我们自己也在跨境经营里摸爬过，知道多公司、多店铺到月底对账时的混乱。产品的每一屏，都从“经营者真正要看什么”出发，而不是堆功能。', 'We have run cross-border businesses ourselves and know the month-end chaos of reconciling multiple companies and stores. Every screen starts from what an operator actually needs to see, not from stacking features.') },
    { icon: ShieldCheck, t: tr('把数据的安全与归属放在前面', 'Data security and ownership come first'), d: tr('数据属于卖家，不属于我们。连接是只读、按法律主体隔离、可随时断开，账户之间不串数据，这是底线而不是卖点。', 'Data belongs to the seller, not to us. Connections are read-only, isolated per legal entity and revocable at any time, with no cross-account mixing — a baseline, not a selling point.') },
    { icon: Scale, t: tr('价格透明、按需报价', 'Transparent, quote-based pricing'), d: tr('按公司数量和实际用到的模块出具书面报价，网页不收款、不设隐藏档位。用多少、报多少，合同里写清楚。', 'We issue a written quote based on the number of companies and the modules you actually use. No online payment, no hidden tiers — pay for what you use, spelled out in the contract.') },
  ] as const
  const principles = [
    { icon: Eye, t: tr('亚马逊数据只读接入', 'Read-only Amazon data access'), d: tr('订单、库存、财务、广告默认只读，仅用于查看与对账，不改出价、不代你操作店铺。', 'Orders, inventory, finance and advertising are read-only by default — for viewing and reconciliation only. We never change bids or operate your store for you.') },
    { icon: MapPin, t: tr('数据存放中国境内', 'Data stored within China'), d: tr(`经营数据存放于${company.storageRegion}的云数据库，符合境内数据存放要求。`, 'Operational data is stored in a cloud database within mainland China, meeting local data-residency requirements.') },
    { icon: Users, t: tr('按法律主体隔离', 'Isolated per legal entity'), d: tr('每家公司一套独立账套，成员按主体分权查看，未授权的公司不进入合并报表。', 'Each company has its own set of books; members see data by entity under role permissions, and unauthorized companies never enter consolidated reports.') },
    { icon: Clock, t: tr(`买家信息 ≤ ${company.piiRetentionDays} 天删除`, `Buyer data deleted ≤ ${company.piiRetentionDays} days`), d: tr('买家个人信息在发货后按政策定期删除，仅在订单与履约必要范围内使用。', 'Buyer personal information is deleted on a schedule after fulfillment, and used only within what orders and fulfillment require.') },
    { icon: FileText, t: tr('报价制、网页不收款', 'Quote-based, no online payment'), d: tr('所有费用以书面方案为准，网页不设在线支付，开通前先确认范围与价格。', 'All fees follow the written plan. The site takes no online payment; scope and price are confirmed before activation.') },
    { icon: Link2, t: tr('授权可随时断开', 'Authorization revocable anytime'), d: tr('店铺与广告账户分开连接，你可以随时断开任一授权，断开后不再读取新数据。', 'Store and advertising accounts are connected separately; you can revoke any authorization at any time, after which no new data is read.') },
  ]
  const focus = [
    [Building2, tr('多公司经营', 'Multi-entity operations'), tr('按法律主体分层管理多家公司、多店铺、多站点，各公司数据清晰归属、互不混淆。', 'Manage multiple companies, stores and marketplaces by legal entity, with each company’s data clearly owned and never mixed.')],
    [Boxes, tr('供应链与库存', 'Supply chain & inventory'), tr('供应商、采购单、仓库与库存流水，以及 FBA 库存与入库计划集中管理。', 'Suppliers, purchase orders, warehouses and inventory movements, plus FBA inventory and inbound plans, all managed in one place.')],
    [Wallet, tr('财务对账', 'Finance & reconciliation'), tr('订单、退款、费用与结算按同一币种归集，月结与利润口径一致。', 'Orders, refunds, fees and settlements are grouped per currency, keeping month-end close and profit definitions consistent.')],
    [BarChart3, tr('广告分析', 'Advertising analytics'), tr('广告账户单独连接后只读分析花费、点击、ACoS 与 ROAS，用于投放复盘。', 'After connecting advertising accounts separately, analyze spend, clicks, ACoS and ROAS read-only for campaign reviews.')],
  ] as const
  return (
    <PageShell lang={lang}>
      <PageHero eyebrow={tr('关于我们', 'About us')} title={lang === 'en' ? <>Help every cross-border company<br />see its business clearly</> : <>让每一家跨境公司，<br />都能看清自己的经营</>} lede={tr('NOVA ERP 由许昌鸿洛商贸有限公司运营，面向跨境电商卖家，把多公司经营、供应链、财务与广告报表放进同一个工作台。我们相信：真实的数据、清晰的归属和透明的价格，才是做经营决策的底气。', 'NOVA ERP is operated by Xuchang Hongluo Trading Co., Ltd. for cross-border e-commerce sellers, bringing multi-entity operations, supply chain, finance and advertising reports into one workspace. We believe real data, clear ownership and transparent pricing are what give operators the confidence to decide.')}>
        <div className="mt-7 flex flex-wrap gap-3"><SiteLink href={`${base}/contact`} className="nv-btn nv-btn-primary">{tr('预约演示', 'Book a demo')}<ArrowRight size={16} /></SiteLink><SiteLink href={`${base}/product`} className="nv-btn nv-btn-ghost">{tr('查看产品能力', 'Explore capabilities')}</SiteLink></div>
      </PageHero>

      {/* 我们是谁 + 企业名片 */}
      <section className="nv-container-wide grid items-center gap-12 py-16 lg:grid-cols-[1.12fr_0.88fr]">
        <Reveal>
          <span className="nv-eyebrow">{tr('我们是谁', 'Who we are')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{tr('一个为跨境经营者打造的工作台', 'A workspace built for cross-border operators')}</h2>
          <p className="mt-4 text-[15.5px] leading-[1.8] text-ink-soft">{tr('跨境团队往往同时经营好几家公司、好几个店铺和站点。货在不同仓库、钱在不同币种、广告在另一套后台——到月底，经营者很难一眼说清“这个月到底赚没赚、哪家公司在拖后腿”。', 'Cross-border teams often run several companies, stores and marketplaces at once. Goods sit in different warehouses, money in different currencies, advertising in another console — so at month-end it is hard to say at a glance whether the month was profitable or which company is dragging things down.')}</p>
          <p className="mt-4 text-[15.5px] leading-[1.8] text-ink-soft">{tr('NOVA ERP 想解决的就是这件事：在合规授权、数据只读的前提下，把多公司的订单、库存、财务与广告集中到一处，按法律主体把账算清楚，让经营全貌变成一屏就能看明白的东西。', 'That is exactly what NOVA ERP addresses: under compliant, read-only authorization, it brings orders, inventory, finance and advertising from multiple companies into one place, keeps the books straight per legal entity, and turns the whole picture into something you can read on a single screen.')}</p>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="rounded-3xl border border-line bg-white p-8 shadow-card">
            <div className="text-[12px] font-bold uppercase tracking-[0.14em] text-brand-600">{tr('企业名片', 'Company profile')}</div>
            <dl className="mt-5 space-y-4">
              {profile.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-6 border-b border-line pb-4 last:border-0 last:pb-0">
                  <dt className="shrink-0 text-[13px] text-ink-mute">{k}</dt>
                  <dd className="text-right text-[14.5px] font-semibold text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </section>

      {/* 使命与主张 */}
      <section className="border-y border-line bg-canvas-soft py-16">
        <div className="nv-container-wide">
          <Reveal className="max-w-[760px]">
            <span className="nv-eyebrow">{tr('使命与主张', 'Mission & principles')}</span>
            <h2 className="mt-4 text-h2 font-bold text-ink">{tr('我们想把产品做成什么样', 'What we want the product to be')}</h2>
            <p className="mt-3 text-[15.5px] leading-[1.8] text-ink-soft">{tr('不追求“大而全”的功能清单，而是把几件对跨境经营真正要紧的事做扎实。这几条，是我们做每个决定时的尺子。', 'Rather than chasing an all-in-one feature list, we do a few things that truly matter for cross-border operations well. These are the yardsticks behind every decision we make.')}</p>
          </Reveal>
          <Stagger className="mt-10 grid gap-5 lg:grid-cols-3">
            {values.map((v) => (
              <StaggerItem key={v.t}>
                <div className="flex h-full flex-col rounded-3xl border border-line bg-white p-7 shadow-card">
                  <span className="grid h-12 w-12 place-items-center text-brand-600"><v.icon size={28} strokeWidth={1.6} /></span>
                  <b className="mt-5 block text-[16.5px] font-bold text-ink">{v.t}</b>
                  <p className="mt-3 text-[13.5px] leading-[1.75] text-ink-soft">{v.d}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* 我们坚持的原则 */}
      <section className="nv-container-wide py-16">
        <Reveal className="max-w-[760px]">
          <span className="nv-eyebrow">{tr('我们的原则', 'Our principles')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{tr('几条不会拿来妥协的做事方式', 'A few things we will not compromise on')}</h2>
          <p className="mt-3 text-[15.5px] leading-[1.8] text-ink-soft">{tr('数据安全与授权边界，对卖家是信任的起点。下面这些不是营销话术，而是产品里实际这么实现的。', 'Data security and authorization boundaries are where trust begins for sellers. These are not marketing lines — they are how the product actually works.')}</p>
        </Reveal>
        <Stagger className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {principles.map((p) => (
            <StaggerItem key={p.t}>
              <div className="flex gap-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center text-brand-600"><p.icon size={24} strokeWidth={1.6} /></span>
                <div>
                  <b className="block text-[15px] font-bold text-ink">{p.t}</b>
                  <p className="mt-2 text-[13.5px] leading-6 text-ink-soft">{p.d}</p>
                </div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* 我们在做什么 */}
      <section className="border-y border-line bg-canvas-soft py-16">
        <div className="nv-container-wide">
          <Reveal className="max-w-[760px]">
            <span className="nv-eyebrow">{tr('我们在做什么', 'What we do')}</span>
            <h2 className="mt-4 text-h2 font-bold text-ink">{tr('围绕四件事把能力做深', 'Going deep on four things')}</h2>
            <p className="mt-3 text-[15.5px] leading-[1.8] text-ink-soft">{tr(`自 ${company.foundedOn.slice(0, 4)} 年成立以来，我们把精力集中在跨境经营最吃重的四个方向上。`, `Since ${company.foundedOn.slice(0, 4)}, we have focused our energy on the four areas that weigh most in cross-border operations.`)}</p>
          </Reveal>
          <Stagger className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {focus.map(([Icon, t, d]) => (
              <StaggerItem key={t}><div className="h-full rounded-2xl border border-line bg-white p-6 shadow-card"><span className="grid h-11 w-11 place-items-center text-brand-600"><Icon size={26} strokeWidth={1.6} /></span><b className="mt-4 block text-[15.5px] font-bold text-ink">{t}</b><p className="mt-2 text-[13.5px] leading-6 text-ink-soft">{d}</p></div></StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

    </PageShell>
  )
}

/* ---------------- 联系 ---------------- */
export function ContactPage({ lang = 'zh' }: { lang?: Lang }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  return (
    <PageShell lang={lang}>
      <PageHero eyebrow={tr('联系我们', 'Contact us')} title={tr('预约演示 / 获取报价', 'Book a demo / get a quote')} lede={tr('工作日查看表单后以邮件回复，不会自动开通账号。也可直接发送邮件沟通。', 'We review submissions on business days and reply by email; accounts are not activated automatically. You can also email us directly.')} />
      <section className="nv-container-wide py-14">
        <Reveal className="mx-auto max-w-[720px]">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border border-line border-b-0 bg-canvas-soft px-7 py-4 text-[13.5px]">
            <a href={`mailto:${company.email}`} className="inline-flex items-center gap-2 font-semibold text-brand-600"><Mail size={15} />{company.email}</a>
            <span className="inline-flex items-center gap-2 text-ink-mute"><MapPin size={14} />{tr(company.address, company.addressEn)}</span>
          </div>
          <div className="rounded-b-2xl border border-line bg-white p-7 shadow-card sm:p-9"><ContactForm lang={lang} /></div>
        </Reveal>
      </section>
    </PageShell>
  )
}

/* ---------------- 合规长文 ---------------- */
const EN_BANNER = `Version ${company.privacyVersion}. Operator: ${enLegal}. Unified social credit code: ${company.creditCode}. Contact: ${company.email}.`

export function PrivacyPage({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <PolicyPage lang={lang} banner={en ? EN_BANNER : legalBanner}
    title={en ? 'Privacy Policy' : '隐私政策'}
    intro={en ? 'How seller data, advertising data and contact information are collected, used, stored, shared, protected and deleted.' : '本政策说明卖家数据、广告数据和咨询信息如何被收集、使用、存储、保护和删除。'}
    sections={en ? enPrivacy : privacySections} />
}
export function TermsPage({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <PolicyPage lang={lang} banner={en ? EN_BANNER : legalBanner}
    title={en ? 'Terms of Service' : '服务条款'}
    intro={en ? 'Fees and refunds follow the written plan. This page sets out service scope and authorization responsibilities.' : '费用和退款以书面方案为准。本页说明服务范围和授权责任。'}
    sections={en ? enTerms : termsSections} />
}
export function SecurityPage({ lang = 'zh' }: { lang?: Lang }) {
  const en = lang === 'en'
  return <PolicyPage lang={lang} banner={en ? EN_BANNER : legalBanner}
    title={en ? 'Security' : '安全说明'}
    intro={en ? 'How transport, credentials, permissions, isolation, audit and deletion are handled.' : '数据范围、加密传输、凭据与存储加密、权限隔离、登录保护、审计、安全事件响应与删除，按以下方式执行。'}
    sections={en ? enSecurity : securitySections} />
}

/* ---------------- 解决方案 ---------------- */
const SOLUTION_SCENES: { icon: typeof Building2; eyebrow: string; eyebrowEn: string; title: string; titleEn: string; problem: string; problemEn: string; points: [string, string][]; links: [string, string, string][]; panel: (t: T) => ReactNode }[] = [
  {
    icon: Building2,
    eyebrow: '多公司矩阵经营',
    eyebrowEn: 'Multi-company operations',
    title: '多家公司一起管，账套分开看清',
    titleEn: 'Manage many companies together, with books kept separate',
    problem: '多个法律主体、多个卖家账号分散在各自的后台，对账要来回登录，成员能看哪几家也难控制。',
    problemEn: 'Multiple legal entities and seller accounts scattered across separate back offices mean logging in repeatedly to reconcile, and it’s hard to control which companies each member can see.',
    points: [
      ['按"法律主体 → 卖家账号 → 站点"三层登记，数据天然按公司归属', 'Register in three tiers — legal entity → seller account → marketplace — so data is naturally owned by company'],
      ['每家公司独立账套，合并视图仍按法律主体清晰区分', 'Separate books per company, with the consolidated view still clearly divided by legal entity'],
      ['成员绑定到指定公司，运营、财务、广告各看各的那几家', 'Members bound to specific companies, so operations, finance and advertising each see their own'],
      ['未完成连接的公司不会进入可查看范围，也不会混入合并报表', 'Companies that haven’t finished connecting don’t enter the viewable scope or the consolidated reports'],
    ],
    links: [['查看店铺与账号', 'View stores & accounts', '/product/stores'], ['查看成员权限', 'View member permissions', '/product/permissions']],
    panel: (t) => (
      <div className="space-y-2.5">
        {([[t('美国 · 旗舰店', 'US · Flagship store'), t('已连接', 'Connected'), true], [t('欧洲 · 精品店', 'EU · Boutique store'), t('已连接', 'Connected'), true], [t('日本 · 新店', 'JP · New store'), t('待连接', 'Pending'), false]] as const).map(([n, s, ok]) => (
          <div key={n} className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={`grid h-9 w-9 place-items-center rounded-lg ${ok ? 'bg-brand-50 text-brand-500' : 'bg-canvas-sunk text-ink-mute'}`}><Building2 size={17} /></span>
              <div><b className="block text-[14px] font-semibold text-ink">{n}</b><span className="text-[12px] text-ink-mute">{t('独立法律主体 · 独立账套', 'Independent legal entity · separate books')}</span></div>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-bold ${ok ? 'bg-[#e8f7ef] text-success' : 'bg-[#fff7e8] text-warning'}`}><CircleDot size={11} />{s}</span>
          </div>
        ))}
        <p className="pt-1 text-[12px] text-ink-mute">{t('未连接的公司不会进入合并报表。演示数据。', 'Unconnected companies don’t enter consolidated reports. Sample data.')}</p>
      </div>
    ),
  },
  {
    icon: Globe,
    eyebrow: '多站点与多币种扩张',
    eyebrowEn: 'Multi-marketplace & multi-currency',
    title: '同一品牌卖到多个站点，收支分币种看清',
    titleEn: 'One brand across marketplaces, revenue and costs clear per currency',
    problem: '一个品牌卖到美、欧、日多个站点，币种各不相同，销量和财务很难放在一起看，跨月退款还容易把当月数字搅乱。',
    problemEn: 'A brand selling across US, EU and JP in different currencies makes it hard to view sales and finance together, and cross-month refunds easily blur the month’s figures.',
    points: [
      ['多站点订单、库存集中查看，按公司、站点、时间组合筛选', 'View multi-marketplace orders and inventory centrally, filtered by company, marketplace and time'],
      ['收入、退款、费用按同一币种核对，不同币种分别统计、不做汇率合并', 'Reconcile revenue, refunds and fees within one currency, counted separately with no FX merging'],
      ['本月退款对回原订单所在月份，不冲减当月新销售', 'This month’s refunds map back to the original order month, without offsetting new sales'],
      ['按站点对比销量与库存周转，判断各市场备货是否合理', 'Compare sales and inventory turnover by marketplace to judge whether stocking is reasonable'],
    ],
    links: [['查看订单管理', 'View order management', '/product/orders'], ['查看财务对账', 'View financial reconciliation', '/product/finance']],
    panel: (t) => (
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-4 bg-canvas-soft px-4 py-2.5 text-[12px] font-semibold text-ink-mute"><span>{t('币种', 'Currency')}</span><span className="text-right">{t('收入', 'Revenue')}</span><span className="text-right">{t('费用', 'Fees')}</span><span className="text-right">{t('净额', 'Net')}</span></div>
        {[['USD', '86,400', '18,200', '68,200'], ['EUR', '32,100', '7,400', '24,700'], ['JPY', '21,800', '5,100', '16,700']].map((r) => (
          <div key={r[0]} className="grid grid-cols-4 border-t border-line px-4 py-3 text-[13px]"><span className="font-semibold text-ink">{r[0]}</span><span className="text-right text-ink-soft">{r[1]}</span><span className="text-right text-ink-soft">{r[2]}</span><span className="text-right font-bold text-success">{r[3]}</span></div>
        ))}
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-mute">{t('各币种独立核对，不做汇率合并。演示数据。', 'Each currency reconciled independently, with no FX merging. Sample data.')}</p>
      </div>
    ),
  },
  {
    icon: Megaphone,
    eyebrow: '广告独立分析',
    eyebrowEn: 'Standalone advertising analytics',
    title: '广告和店铺不在一家管，也能单独看清效果',
    titleEn: 'See advertising results on their own, even when managed separately from stores',
    problem: '广告账户和卖家账号由不同团队在管，只想单独看广告花费和回报，不希望和店铺数据绑在一起。',
    problemEn: 'Advertising accounts and seller accounts are managed by different teams; you just want to see ad spend and returns on their own, not tied to store data.',
    points: [
      ['广告账户与卖家账号分开连接，店铺连接不会自动带出广告数据', 'Advertising and seller accounts connect separately; connecting a store doesn’t pull in ad data'],
      ['花费、点击、CTR、CPC、广告销售额、ACoS 与 ROAS 集中查看', 'View spend, clicks, CTR, CPC, ad sales, ACoS and ROAS in one place'],
      ['按 SP 自动、SP 手动、SB 品牌、SD 展示等活动类型拆解花费', 'Break down spend by campaign type such as SP auto, SP manual, SB brand and SD display'],
      ['报表只读，不改出价、不调预算，也不代替你投放广告', 'Reports are read-only — no bid changes, no budget changes, and no running campaigns for you'],
    ],
    links: [['查看广告分析', 'View advertising analytics', '/solutions/advertising'], ['查看广告模块', 'View the advertising module', '/product/advertising']],
    panel: (t) => (
      <div className="rounded-xl border border-line bg-white p-5">
        <div className="grid grid-cols-3 gap-3">
          {[[t('花费', 'Spend'), '$9,040'], ['ACoS', '18.3%'], [t('广告销售额', 'Ad sales'), '$49,400']].map((k) => (
            <div key={k[1]} className="rounded-lg bg-canvas-soft px-3 py-3 text-center"><div className="text-[11px] text-ink-mute">{k[0]} · {t('演示', 'Demo')}</div><div className="mt-1 text-[16.5px] font-bold text-ink">{k[1]}</div></div>
          ))}
        </div>
        <div className="mt-4 space-y-2.5 border-t border-line pt-4">
          {([[t('SP 自动', 'SP auto'), 4620], [t('SP 手动', 'SP manual'), 3180], [t('SD 展示', 'SD display'), 1980], [t('SB 品牌', 'SB brand'), 1240]] as const).map(([n, v]) => (
            <div key={n}>
              <div className="flex justify-between text-[12px] text-ink-soft"><span>{n}</span><span className="font-semibold text-ink">${v.toLocaleString()}</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas-sunk"><span className="block h-full rounded-full bg-brand-500" style={{ width: `${(v / 4620) * 100}%` }} /></div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-ink-mute">{t('报表只读，不改出价、不代投放。演示数据。', 'Reports are read-only — no bid changes, no managed operations. Sample data.')}</p>
      </div>
    ),
  },
]

export function SolutionsPage({ lang = 'zh' }: { lang?: Lang }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const base = lang === 'en' ? '/en' : ''
  return (
    <PageShell lang={lang}>
      <PageHero eyebrow={tr('解决方案', 'Solutions')} title={lang === 'en' ? <>Match your operating structure <span className="nv-text-gradient">to the right approach</span></> : <>按你的经营结构，<span className="nv-text-gradient">对上合适的做法</span></>} lede={tr('不预设统一套餐，而是按你怎么经营来组合能力。下面是三类最常见的场景，点进相关模块可以看到更细的做法。', 'Rather than a one-size-fits-all package, capabilities are combined around how you operate. Below are three common scenarios; open the related modules for finer detail.')}>
        <div className="mt-7 flex flex-wrap gap-3"><SiteLink href={`${base}/contact`} className="nv-btn nv-btn-primary">{tr('预约演示', 'Book a demo')}<ArrowRight size={16} /></SiteLink><SiteLink href={`${base}/pricing`} className="nv-btn nv-btn-ghost">{tr('了解报价方式', 'How pricing works')}</SiteLink></div>
      </PageHero>

      {SOLUTION_SCENES.map((s, i) => (
        <section key={s.title} className={`border-b border-line ${i % 2 ? 'bg-canvas-soft' : 'bg-white'}`}>
          <div className="nv-container-wide grid items-center gap-12 py-16 lg:grid-cols-2">
            <Reveal className={i % 2 ? 'lg:order-2' : ''}>
              <span className="nv-eyebrow"><s.icon size={13} />{tr(s.eyebrow, s.eyebrowEn)}</span>
              <h2 className="mt-4 text-[28px] font-bold leading-tight text-ink">{tr(s.title, s.titleEn)}</h2>
              <div className="mt-5 flex gap-3 rounded-2xl border border-line bg-canvas-soft/70 p-4">
                <span className="mt-0.5 shrink-0 text-[12px] font-extrabold uppercase tracking-wide text-warning">{tr('痛点', 'Pain point')}</span>
                <p className="text-[13.5px] leading-6 text-ink-soft">{tr(s.problem, s.problemEn)}</p>
              </div>
              <ul className="mt-5 space-y-3">
                {s.points.map(([zh, en]) => (
                  <li key={zh} className="flex items-start gap-2.5 text-[14.5px] leading-6 text-ink-soft"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-500"><Check size={13} strokeWidth={3} /></span>{tr(zh, en)}</li>
                ))}
              </ul>
              <div className="mt-7 flex flex-wrap gap-3">
                {s.links.map(([label, labelEn, href], li) => (
                  <SiteLink key={href} href={`${base}${href}`} className={`nv-btn ${li === 0 ? 'nv-btn-primary' : 'nv-btn-ghost'}`}>{tr(label, labelEn)}<ArrowRight size={15} /></SiteLink>
                ))}
              </div>
            </Reveal>
            <Reveal delay={0.1} className={i % 2 ? 'lg:order-1' : ''}>
              <div className="rounded-3xl border border-line bg-canvas-soft/60 p-6 shadow-card">{s.panel(tr)}</div>
            </Reveal>
          </div>
        </section>
      ))}
    </PageShell>
  )
}

/* ---------------- 资源中心 ---------------- */
const RESOURCE_TOPICS: { icon: typeof BookOpen; title: string; titleEn: string; links: [string, string, string][] }[] = [
  { icon: PlayCircle, title: '快速入门', titleEn: 'Quick start', links: [['如何开始使用', 'How to get started', '/contact'], ['选择合适的方案', 'Choose the right plan', '/solutions']] },
  { icon: Link2, title: '连接与授权', titleEn: 'Connect & authorize', links: [['多店铺连接', 'Multi-store connection', '/product/stores'], ['广告账户连接', 'Advertising account connection', '/solutions/advertising']] },
  { icon: BarChart3, title: '数据与对账', titleEn: 'Data & reconciliation', links: [['财务月结', 'Monthly close', '/product/finance'], ['跨月退货', 'Cross-month returns', '/product/returns'], ['FBA 库存', 'FBA inventory', '/product/inventory']] },
  { icon: ShieldCheck, title: '安全与合规', titleEn: 'Security & compliance', links: [['安全说明', 'Security', '/security'], ['隐私政策', 'Privacy Policy', '/privacy'], ['服务条款', 'Terms of Service', '/terms']] },
]
export function ResourcesPage({ lang = 'zh' }: { lang?: Lang }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const base = lang === 'en' ? '/en' : ''
  const items = lang === 'en' ? enGuides : guides
  return (
    <PageShell lang={lang}>
      <PageHero eyebrow={tr('资源与支持', 'Resources & support')} title={lang === 'en' ? <>Product guides and <span className="nv-text-gradient">FAQs</span></> : <>产品指南与<span className="nv-text-gradient">常见问题</span></>} lede={tr('指南、常见问题和支持方式，帮助你快速了解 NOVA ERP 并开始使用。', 'Guides, FAQs and support to help you get to know NOVA ERP and get started quickly.')} />
      <section className="nv-container-wide py-14">
        <Reveal className="mb-8"><span className="nv-eyebrow"><BookOpen size={13} />{tr('产品指南', 'Product guides')}</span><h2 className="mt-3 text-h2 font-bold text-ink">{tr('开始之前先看看', 'A quick look before you start')}</h2></Reveal>
        <Stagger className="grid gap-4 sm:grid-cols-2">
          {items.map((g) => (
            <StaggerItem key={g.title}>
              <a href={base + g.href} onClick={(e) => { e.preventDefault(); nav(base + g.href) }} className="group flex h-full items-start justify-between gap-4 rounded-2xl border border-line bg-white p-6 shadow-card transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-float">
                <div><span className="grid h-11 w-11 place-items-center text-brand-600"><BookOpen size={26} strokeWidth={1.6} /></span><b className="mt-4 block text-[16px] font-bold text-ink">{g.title}</b><p className="mt-2 text-[13.5px] leading-6 text-ink-soft">{g.text}</p></div>
                <ArrowUpRight size={18} className="shrink-0 text-ink-mute transition group-hover:text-brand-500" />
              </a>
            </StaggerItem>
          ))}
        </Stagger>
      </section>
      <section className="bg-canvas-soft py-16">
        <div className="nv-container-wide">
          <Reveal className="mb-8"><span className="nv-eyebrow"><BookOpen size={13} />{tr('按主题浏览', 'Browse by topic')}</span><h2 className="mt-3 text-h2 font-bold text-ink">{tr('想了解哪方面？', 'What would you like to learn?')}</h2></Reveal>
          <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {RESOURCE_TOPICS.map((topic) => (
              <StaggerItem key={topic.title}>
                <div className="flex h-full flex-col rounded-2xl border border-line bg-white p-6 shadow-card">
                  <span className="grid h-11 w-11 place-items-center text-brand-600"><topic.icon size={26} strokeWidth={1.6} /></span>
                  <b className="mt-4 text-[15.5px] font-bold text-ink">{tr(topic.title, topic.titleEn)}</b>
                  <ul className="mt-3 space-y-2">
                    {topic.links.map(([label, labelEn, href]) => (
                      <li key={href}><SiteLink href={`${base}${href}`} className="inline-flex items-center gap-1.5 text-[13.5px] text-ink-soft transition hover:text-brand-600"><ArrowUpRight size={13} className="shrink-0 text-ink-mute" />{tr(label, labelEn)}</SiteLink></li>
                    ))}
                  </ul>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>
    </PageShell>
  )
}

/* ---------------- 新闻 ---------------- */
export function NewsPage({ lang = 'zh' }: { lang?: Lang }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const list = lang === 'en' ? enPress : press
  const months = Array.from(new Set(list.map((p) => p.date))).sort((a, b) => b.localeCompare(a))
  const tags = Array.from(new Set(list.map((p) => p.tag)))
  return (
    <PageShell lang={lang}>
      <PageHero eyebrow={tr('更新动态', 'Updates')} title={lang === 'en' ? <>Product updates <span className="nv-text-gradient">and feature news</span></> : <>产品更新<span className="nv-text-gradient">与功能动态</span></>} lede={tr('记录 NOVA ERP 的功能更新与重要节点。我们不发布客户案例，只分享真实的产品进展。', 'A record of NOVA ERP feature updates and milestones. We don’t publish customer cases — only real product progress.')}>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ink-mute">{tr('更新分类：', 'Categories:')}</span>
          {tags.map((tg) => <span key={tg} className="nv-chip">{tg}</span>)}
        </div>
      </PageHero>
      <section className="nv-container-wide py-14">
        <div className="mx-auto max-w-[860px] space-y-12">
          {months.map((month) => {
            const items = list.filter((p) => p.date === month)
            return (
              <div key={month}>
                <div className="mb-6 flex items-center gap-4">
                  <h2 className="flex items-center gap-2 text-[19px] font-bold text-ink"><Calendar size={16} className="text-brand-500" />{month}</h2>
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-[12.5px] text-ink-mute">{items.length} {tr('项更新', items.length === 1 ? 'update' : 'updates')}</span>
                </div>
                <Stagger className="grid gap-4 sm:grid-cols-2">
                  {items.map((item) => (
                    <StaggerItem key={item.title}>
                      <article className="flex h-full flex-col rounded-2xl border border-line bg-white p-6 shadow-card transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-float">
                        <span className="w-fit rounded-full bg-brand-50 px-2.5 py-1 text-[11.5px] font-bold text-brand-600">{item.tag}</span>
                        <h3 className="mt-4 text-[17px] font-bold text-ink">{item.title}</h3>
                        <p className="mt-2 flex-1 text-[13.5px] leading-7 text-ink-soft">{item.text}</p>
                      </article>
                    </StaggerItem>
                  ))}
                </Stagger>
              </div>
            )
          })}
        </div>
      </section>
    </PageShell>
  )
}

export function PolicyPage({ title, intro, sections, lang = 'zh', banner }: { title: string; intro: string; sections: { h: string; p: string }[]; lang?: Lang; banner: string }) {
  const tr = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const base = lang === 'en' ? '/en' : ''
  return (
    <PageShell lang={lang}>
      <PageHero eyebrow={tr('法律与合规', 'Legal & compliance')} title={title} lede={intro} />
      <section className="nv-container-wide py-14">
        <div className="grid gap-12 lg:grid-cols-[220px_1fr]">
          <aside className="hidden lg:block">
            <nav className="sticky top-24 space-y-0.5" aria-label={tr('本页目录', 'On this page')}>
              <div className="mb-2 flex items-center gap-1.5 px-3 text-[12px] font-bold uppercase tracking-wide text-ink-mute"><FileText size={13} className="text-brand-400" />{tr('目录', 'Contents')}</div>
              {sections.map((s, i) => (
                <a key={s.h} href={`#policy-${i}`} className="block rounded-lg px-3 py-2 text-[13px] text-ink-soft transition hover:bg-canvas-soft hover:text-brand-600">{s.h}</a>
              ))}
            </nav>
          </aside>
          <div className="max-w-[760px]">
            <p className="rounded-xl bg-canvas-soft px-4 py-3 text-[12.5px] leading-6 text-ink-mute">{banner}</p>
            <div className="mt-8 space-y-10">
              {sections.map((s, i) => (
                <section id={`policy-${i}`} key={s.h} className="scroll-mt-24">
                  <h2 className="text-[20px] font-bold text-ink">{s.h}</h2>
                  <p className="mt-3 text-[15px] leading-[1.8] text-ink-soft">{s.p}</p>
                </section>
              ))}
            </div>
            <div className="mt-12 flex flex-wrap gap-5 border-t border-line pt-6 text-[14px] font-semibold text-brand-600">
              <SiteLink href={`${base}/privacy`}>{tr('隐私政策', 'Privacy Policy')}</SiteLink><SiteLink href={`${base}/terms`}>{tr('服务条款', 'Terms of Service')}</SiteLink><SiteLink href={`${base}/security`}>{tr('安全说明', 'Security')}</SiteLink><SiteLink href={`${base}/contact`}>{tr('联系我们', 'Contact')}</SiteLink>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  )
}
