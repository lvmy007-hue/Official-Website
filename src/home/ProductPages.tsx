import type { ReactNode } from 'react'
import {
  Boxes, Wallet, LineChart, Megaphone, Check, ArrowRight, ArrowUpRight,
  Building2, ShoppingCart, RotateCcw, Tags, Truck, ShieldCheck, Database, Eye, Lock,
  BarChart3, PieChart, Warehouse, FileBarChart, ScrollText, Users, Lightbulb,
} from 'lucide-react'
import { PageShell, PageHero } from './pages'
import { useLang, useT, type Lang } from './i18n'
import { SiteLink, nav } from '../site-link'
import { company } from '../site-company'
import { EChart } from '../ui/chart'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'
import { adsBreakdownOption, inventoryTurnOption, salesTrendOption, orderStatusOption, returnByMonthOption, listingStatusOption, inboundProgressOption } from './panels'
import { productAreas, productDetails, permissionRows, adKpis, serviceNature } from '../public-product-content'
import { enProductAreas, enProductDetails, enPermissionRows, enAdKpis, enServiceNature } from '../public-product-content-en'

type Area = typeof productAreas[number]
type T = (zh: string, en: string) => string

const ICONS: Record<string, typeof Boxes> = {
  '/product/stores': Building2, '/product/orders': ShoppingCart, '/product/returns': RotateCcw,
  '/product/finance': Wallet, '/product/advertising': Megaphone, '/product/permissions': ShieldCheck,
  '/product/inventory': Boxes, '/product/listings': Tags, '/product/inbound': Truck,
}

const GROUPS = [
  { id: 'supply', name: '供应链', nameEn: 'Supply chain', icon: Boxes, text: '库存、入库、刊登、订单按卖家账号集中管理，数据归属清晰。', textEn: 'Inventory, inbound, listings and orders are managed centrally by seller account, with clear data ownership.', hrefs: ['/product/inventory', '/product/inbound', '/product/listings', '/product/stores'] },
  { id: 'finance', name: '财务', nameEn: 'Finance', icon: Wallet, text: '收入、退款和费用按同一币种核对，退款可对回原订单月份。', textEn: 'Revenue, refunds and fees are reconciled per currency, and refunds map back to the original order month.', hrefs: ['/product/finance', '/product/returns', '/product/orders'] },
  { id: 'ops', name: '运营', nameEn: 'Operations', icon: LineChart, text: '谁能看哪家公司由成员权限决定，职责清晰可追溯。', textEn: 'Who can see which company is decided by permissions, with clear and traceable responsibility.', hrefs: ['/product/permissions'] },
  { id: 'ads', name: '广告', nameEn: 'Advertising', icon: Megaphone, text: '广告花费与销售额集中查看，用于分析与对账。', textEn: 'Ad spend and sales are viewed centrally for analysis and reconciliation.', hrefs: ['/product/advertising'] },
]

const ERP_CAPS = [
  { icon: ShoppingCart, t: '采购与供应商', tEn: 'Purchasing & suppliers', d: '维护供应商档案，创建并跟踪采购单，把备货与到货情况和经营数据放在一起管理。', dEn: 'Maintain supplier profiles, create and track purchase orders, and manage stocking and arrivals alongside operating data.' },
  { icon: Warehouse, t: '仓库与库存流水', tEn: 'Warehouses & inventory ledger', d: '管理多个仓库，记录出入库与调拨流水，每一笔库存变动都有迹可循。', dEn: 'Manage multiple warehouses and record inbound, outbound and transfer movements, so every stock change is traceable.' },
  { icon: FileBarChart, t: '报表中心', tEn: 'Report center', d: '按需生成订单、库存、财务与广告报表任务，导出结果用于经营复盘与归档。', dEn: 'Generate order, inventory, finance and advertising report tasks on demand, and export results for review and archiving.' },
  { icon: ScrollText, t: '权限与审计', tEn: 'Permissions & audit', d: '成员按角色分权，登录、授权与数据读取全程留痕，关键操作可追溯。', dEn: 'Members are scoped by role, and logins, authorizations and data reads are logged throughout, so key actions are traceable.' },
  { icon: ShieldCheck, t: '数据安全与隔离', tEn: 'Data security & isolation', d: '传输与敏感字段加密保存，各法律主体数据按企业账户隔离，买家信息按期限删除。', dEn: 'Transport and sensitive fields are encrypted, each legal entity’s data is isolated by company account, and buyer information is deleted on schedule.' },
  { icon: Users, t: '多法人协同', tEn: 'Multi-entity collaboration', d: '多家公司、多成员在同一工作台协同，按主体与角色清晰划分可见范围。', dEn: 'Multiple companies and members collaborate in one workspace, with visibility clearly divided by entity and role.' },
] as const

function groupOf(href: string) { return GROUPS.find(g => g.hrefs.includes(href)) }
function pagePath(page: string) { return '/' + page.replace('-', '/') }

function Window({ title, children }: { title: string; children: ReactNode }) {
  const t = useT()
  return (
    <div className="overflow-hidden rounded-2xl border border-[#eef1f6] bg-white shadow-float">
      <div className="flex h-10 items-center gap-2.5 border-b border-line bg-[#fbfcfe] px-4">
        <span className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#ff6159]" /><i className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" /><i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" /></span>
        <span className="text-[12px] font-semibold text-ink-soft">{title}</span>
        <span className="ml-auto rounded-full bg-brand-50 px-2.5 py-0.5 text-[11px] font-bold text-brand-600">{t('演示数据', 'Sample data')}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function MiniTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="grid bg-canvas-soft px-3 py-2 text-[12px] font-semibold text-ink-mute" style={{ gridTemplateColumns: `repeat(${head.length}, minmax(0,1fr))` }}>{head.map(h => <span key={h}>{h}</span>)}</div>
      {rows.map((r, i) => <div key={i} className="grid border-t border-line px-3 py-2.5 text-[12.5px] text-ink-soft" style={{ gridTemplateColumns: `repeat(${head.length}, minmax(0,1fr))` }}>{r.map((c, j) => <span key={j} className={j === 0 ? 'font-semibold text-ink' : ''}>{c}</span>)}</div>)}
    </div>
  )
}

function figureFor(href: string, t: T, lang: Lang): ReactNode {
  const perms = lang === 'en' ? enPermissionRows : permissionRows
  switch (href) {
    case '/product/inventory':
      return <Window title={t('库存 / 可售天数', 'Inventory / days of cover')}><EChart ariaLabel={t('库存可售天数演示图', 'Inventory days-of-cover demo chart')} height={240} option={inventoryTurnOption()} /></Window>
    case '/product/finance':
      return <Window title={t('财务 / 销售额与毛利', 'Finance / sales & gross margin')}><EChart ariaLabel={t('销售额与毛利演示图', 'Sales and gross margin demo chart')} height={240} option={salesTrendOption([7.2, 8.1, 7.6, 9.3, 8.8, 10.2, 9.6, 11.2, 10.4, 12.1, 11.3, 12.8, 12.1, 13.6].map(v => v * 1000), [2.1, 2.4, 2.2, 2.9, 2.7, 3.2, 3.0, 3.5, 3.3, 3.8, 3.6, 4.1, 3.9, 4.4].map(v => v * 1000))} /></Window>
    case '/product/advertising':
      return <Window title={t('广告 / 花费结构（只读）', 'Advertising / spend structure (read-only)')}><EChart ariaLabel={t('广告花费结构演示图', 'Ad spend structure demo chart')} height={220} option={adsBreakdownOption()} /></Window>
    case '/product/stores':
      return <Window title={t('法律主体 / 店铺授权', 'Legal entity / store authorization')}><div className="space-y-2.5">
        {[[t('美国 · 旗舰店', 'US · Flagship store'), t('使用中', 'Active'), true], [t('欧洲 · 精品店', 'EU · Boutique store'), t('使用中', 'Active'), true], [t('日本 · 新店', 'JP · New store'), t('筹备中', 'Preparing'), false]].map(([n, s, ok]) => (
          <div key={n as string} className="flex items-center justify-between rounded-xl border border-line px-4 py-3">
            <div className="flex items-center gap-3"><span className={`grid h-9 w-9 place-items-center rounded-lg ${ok ? 'bg-brand-50 text-brand-500' : 'bg-canvas-sunk text-ink-mute'}`}><Building2 size={17} /></span><div><b className="block text-[13.5px] font-semibold text-ink">{n}</b><span className="text-[12px] text-ink-mute">{t('独立法律主体 · 独立账套', 'Independent legal entity · separate books')}</span></div></div>
            <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${ok ? 'bg-[#e8f7ef] text-success' : 'bg-[#fff7e8] text-warning'}`}>{s}</span>
          </div>
        ))}
      </div></Window>
    case '/product/orders':
      return <Window title={t('订单 / 状态分布', 'Orders / status distribution')}><EChart ariaLabel={t('订单状态分布演示图', 'Order status distribution demo chart')} height={240} option={orderStatusOption()} /></Window>
    case '/product/returns':
      return <Window title={t('退货 / 退款额按原订单月', 'Returns / refunds by original order month')}><EChart ariaLabel={t('退款额按原订单月演示图', 'Refunds by original order month demo chart')} height={240} option={returnByMonthOption()} /></Window>
    case '/product/permissions':
      return <Window title={t('成员权限 / 角色', 'Member permissions / roles')}><MiniTable head={[t('模块', 'Module'), t('可做的事', 'What you can do')]} rows={perms.slice(0, 5).map(r => [r[0], r[1]])} /></Window>
    case '/product/listings':
      return <Window title={t('商品刊登 / 状态占比', 'Listings / status share')}><EChart ariaLabel={t('刊登状态占比演示图', 'Listing status share demo chart')} height={240} option={listingStatusOption()} /></Window>
    case '/product/inbound':
      return <Window title={t('FBA 入库 / 接收进度', 'FBA inbound / receiving progress')}><EChart ariaLabel={t('FBA 入库接收进度演示图', 'FBA inbound receiving progress demo chart')} height={240} option={inboundProgressOption()} /></Window>
    default:
      return null
  }
}

/* ---------- 产品总览 ---------- */
function ProductIndexView() {
  const lang = useLang()
  const t = useT()
  const base = lang === 'en' ? '/en' : ''
  const areas = lang === 'en' ? (enProductAreas as Area[]) : productAreas
  return (
    <>
      <PageHero eyebrow={t('产品能力', 'Capabilities')} title={lang === 'en' ? <>Explore by <span className="nv-text-gradient">supply chain / finance / operations / advertising</span></> : <>按 <span className="nv-text-gradient">供应链 / 财务 / 运营 / 广告</span> 查看</>} lede={t('每一组下面是独立模块，点进去可以看到它解决的问题和核心功能。', 'Each group contains independent modules; open one to see the problem it solves and its core features.')}>
        <nav className="mt-7 flex flex-wrap gap-2">{GROUPS.map(g => <a key={g.id} href={`#g-${g.id}`} className="nv-chip"><g.icon size={13} />{t(g.name, g.nameEn)}</a>)}</nav>
      </PageHero>

      {GROUPS.map((g) => {
        const groupAreas = g.hrefs.map(href => areas.find(a => a.href === href)).filter((a): a is Area => a != null)
        const single = groupAreas.length === 1
        return (
          <section key={g.id} id={`g-${g.id}`} className="scroll-mt-24 border-b border-line py-16 last:border-0 odd:bg-canvas-soft">
            <div className="nv-container-wide">
              <Reveal className="mb-8"><span className="nv-eyebrow"><g.icon size={13} />{t(g.name, g.nameEn)}</span><h2 className="mt-3 text-h2 font-bold text-ink">{t(g.text, g.textEn)}</h2></Reveal>
              <Stagger className={single ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3'}>
                {groupAreas.map((a) => {
                  const Icon = ICONS[a.href] ?? Boxes
                  return (
                    <StaggerItem key={a.href}>
                      {single ? (
                        <a href={base + a.href} onClick={(e) => { e.preventDefault(); nav(base + a.href) }} className="group flex items-center gap-6 rounded-2xl border border-line bg-white p-7 shadow-card transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-float">
                          <span className="grid h-14 w-14 shrink-0 place-items-center text-brand-600 transition group-hover:text-brand-700"><Icon size={30} strokeWidth={1.6} /></span>
                          <div className="flex-1"><b className="text-[17px] font-bold text-ink">{a.title}</b><p className="mt-1.5 text-[13.5px] leading-6 text-ink-soft">{a.claim}</p></div>
                          <span className="hidden shrink-0 items-center gap-1 text-[13px] font-semibold text-brand-600 transition group-hover:gap-2 sm:inline-flex">{t('查看说明', 'View details')} <ArrowUpRight size={14} /></span>
                        </a>
                      ) : (
                        <a href={base + a.href} onClick={(e) => { e.preventDefault(); nav(base + a.href) }} className="group flex h-full flex-col rounded-2xl border border-line bg-white p-6 shadow-card transition hover:-translate-y-1.5 hover:border-brand-200 hover:shadow-float">
                          <span className="grid h-11 w-11 place-items-center text-brand-600 transition group-hover:text-brand-700"><Icon size={26} strokeWidth={1.6} /></span>
                          <b className="mt-5 text-[16.5px] font-bold text-ink">{a.title}</b>
                          <span className="mt-2.5 flex-1 text-[13.5px] leading-6 text-ink-soft">{a.claim}</span>
                          <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-600 opacity-0 transition group-hover:opacity-100">{t('查看说明', 'View details')} <ArrowUpRight size={14} /></span>
                        </a>
                      )}
                    </StaggerItem>
                  )
                })}
              </Stagger>
            </div>
          </section>
        )
      })}

      <section className="scroll-mt-24 border-t border-line bg-white py-16">
        <div className="nv-container-wide">
          <Reveal className="mx-auto max-w-[820px] text-center">
            <span className="nv-eyebrow"><Database size={13} />{t('经营管理能力', 'Operations management')}</span>
            <h2 className="mt-3 text-h2 font-bold text-ink">{t('不止看数据，更能管理经营', 'More than viewing data — managing operations')}</h2>
            <p className="mt-3 text-[15px] leading-7 text-ink-soft">{t('在亚马逊授权的只读数据之上，NOVA ERP 还提供采购、仓储、报表与权限等经营管理能力，把日常经营放进同一个工作台。', 'On top of read-only, Amazon-authorized data, NOVA ERP also provides purchasing, warehousing, reporting and permissions, bringing daily operations into one workspace.')}</p>
          </Reveal>
          <Reveal className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <span className="inline-flex items-center gap-2 rounded-xl border border-line bg-canvas-soft px-4 py-2.5 text-[13px] font-semibold text-ink-soft"><Database size={14} className="text-brand-500" />{t('数据底座 · 亚马逊只读：订单 / 库存 / 财务 / 广告', 'Data foundation · Amazon read-only: orders / inventory / finance / advertising')}</span>
            <ArrowRight size={18} className="rotate-90 text-ink-mute sm:rotate-0" />
            <span className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-glow">{t('经营管理层 · 采购 / 仓储 / 报表 / 权限', 'Operations layer · purchasing / warehousing / reporting / permissions')}</span>
          </Reveal>
          <Stagger className="mx-auto mt-9 grid max-w-[940px] gap-3 sm:grid-cols-2">
            {ERP_CAPS.map((c) => (
              <StaggerItem key={c.t}>
                <div className="flex items-start gap-4 rounded-2xl border border-line bg-white p-5 shadow-card transition hover:border-brand-200 hover:shadow-float">
                  <span className="grid h-11 w-11 shrink-0 place-items-center text-brand-600"><c.icon size={26} strokeWidth={1.6} /></span>
                  <div><b className="text-[15px] font-bold text-ink">{t(c.t, c.tEn)}</b><p className="mt-1.5 text-[13px] leading-6 text-ink-soft">{t(c.d, c.dEn)}</p></div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>
    </>
  )
}

/* ---------- 产品详情 ---------- */
const STRUCTURE_MODULES = ['/product/stores', '/product/permissions']

function ProductDetailView({ area }: { area: Area }) {
  const lang = useLang()
  const t = useT()
  const base = lang === 'en' ? '/en' : ''
  const Icon = ICONS[area.href] ?? Boxes
  const details = lang === 'en' ? enProductDetails : productDetails
  const areas = lang === 'en' ? (enProductAreas as Area[]) : productAreas
  const d = details[area.href]
  const isStructure = STRUCTURE_MODULES.includes(area.href)
  const related = areas.filter(a => a.href !== area.href).slice(0, 3)
  const group = groupOf(area.href)
  const groupLabel = group ? t(group.name, group.nameEn) : t('产品能力', 'Capabilities')
  return (
    <>
      <section className="border-b border-line bg-canvas-soft">
        <div className="nv-container-wide grid items-center gap-12 py-14 lg:grid-cols-2 lg:py-16">
          <Reveal>
            <span className="nv-eyebrow"><Icon size={13} />{t('产品', 'Product')} · {groupLabel}</span>
            <h1 className="mt-4 text-h1 font-extrabold text-ink">{area.title}</h1>
            <p className="mt-4 text-[16.5px] leading-[1.7] text-ink-soft">{area.claim}</p>
            {d ? (
              <ul className="mt-6 flex flex-wrap gap-2">
                {d.highlights.map((h) => (
                  <li key={h} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink-soft shadow-card"><Check size={12} strokeWidth={3} className="text-brand-500" />{h}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-7 flex flex-wrap gap-3"><SiteLink href={`${base}/contact`} className="nv-btn nv-btn-primary">{t('预约演示', 'Book a demo')}<ArrowRight size={16} /></SiteLink><SiteLink href={`${base}/product`} className="nv-btn nv-btn-ghost">{t('返回产品总览', 'Back to products')}</SiteLink></div>
          </Reveal>
          <Reveal delay={0.1}>{figureFor(area.href, t, lang)}</Reveal>
        </div>
      </section>

      <section className="border-y border-line bg-canvas-soft py-16">
        <div className="nv-container-wide">
          <Reveal className="max-w-[720px]">
            <span className="nv-eyebrow">{t('设计背景', 'Background')}</span>
            <h2 className="mt-4 text-h2 font-bold text-ink">{d ? d.sections.problem : t('为什么需要这样设计', 'Why it’s designed this way')}</h2>
            <p className="mt-4 text-[15.5px] leading-[1.8] text-ink-soft">{area.problem}</p>
          </Reveal>
          <Stagger className="mt-8 grid gap-4 sm:grid-cols-2">
            {[{ icon: Database, k: t('适用场景', 'Where it applies'), v: area.source }, { icon: Eye, k: t('带来的改变', 'What changes'), v: area.status }].map((x) => (
              <StaggerItem key={x.k}>
                <div className="flex h-full gap-4 rounded-2xl border border-line bg-white p-6 shadow-card">
                  <span className="grid h-10 w-10 shrink-0 place-items-center text-brand-600"><x.icon size={22} strokeWidth={1.6} /></span>
                  <div><b className="block text-[14.5px] font-bold text-ink">{x.k}</b><p className="mt-1.5 text-[13.5px] leading-6 text-ink-soft">{x.v}</p></div>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      <section className="nv-container-wide py-16">
        <Reveal className="max-w-[720px]">
          <span className="nv-eyebrow">{t('核心能力', 'Core capabilities')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{d ? d.sections.feature : (isStructure ? t('它是怎么组织的', 'How it’s organized') : t('这个模块提供什么', 'What this module provides'))}</h2>
        </Reveal>
        {isStructure ? (
          <ol className="mx-auto mt-8 grid max-w-[900px] gap-3">
            {(d ? d.detail : area.features.map((f) => ({ t: f, d: '' }))).map((f, i) => (
              <li key={f.t} className="flex gap-4 rounded-2xl border border-line bg-white p-5 shadow-card">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-[13px] font-extrabold tabular-nums text-brand-600">{String(i + 1).padStart(2, '0')}</span>
                <div><b className="text-[14.5px] font-bold text-ink">{f.t}</b>{f.d ? <p className="mt-1.5 text-[13px] leading-6 text-ink-soft">{f.d}</p> : null}</div>
              </li>
            ))}
          </ol>
        ) : (
          <Stagger className={`mt-8 grid gap-4 sm:grid-cols-2 ${(d ? d.detail.length : area.features.length) >= 5 ? 'lg:grid-cols-3' : ''}`}>
            {(d ? d.detail : area.features.map((f) => ({ t: f, d: '' }))).map((f) => (
              <StaggerItem key={f.t}>
                <div className="h-full rounded-2xl border border-line bg-white p-6 shadow-card">
                  <div className="flex items-center gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600"><Check size={15} strokeWidth={3} /></span><b className="text-[14.5px] font-bold text-ink">{f.t}</b></div>
                  {f.d ? <p className="mt-3 text-[13px] leading-6 text-ink-soft">{f.d}</p> : null}
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </section>

      {d && d.scenarios.length ? (
        <section className="bg-canvas-soft py-16">
          <div className="nv-container-wide">
            <Reveal className="mb-8 max-w-[720px]"><span className="nv-eyebrow"><Lightbulb size={13} />{t('应用场景', 'Use cases')}</span><h2 className="mt-3 text-h2 font-bold text-ink">{d.sections.scenario}</h2></Reveal>
            <Stagger className={`grid gap-4 ${d.scenarios.length >= 3 ? 'md:grid-cols-3' : 'sm:grid-cols-2'}`}>
              {d.scenarios.map((s) => (
                <StaggerItem key={s.t}>
                  <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-white p-6 pl-7 shadow-card">
                    <span aria-hidden className="absolute left-0 top-6 h-10 w-1 rounded-r bg-brand-500" />
                    <div className="flex items-center gap-2"><Lightbulb size={16} className="text-brand-500" /><b className="text-[15.5px] font-bold text-ink">{s.t}</b></div>
                    <p className="mt-2.5 flex-1 text-[13.5px] leading-6 text-ink-soft">{s.d}</p>
                  </div>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </section>
      ) : null}

      <section className="bg-canvas-soft py-16">
        <div className="nv-container-wide">
          <Reveal className="mb-8 text-center"><span className="nv-eyebrow">{t('相关能力', 'Related capabilities')}</span><h2 className="mt-3 text-h2 font-bold text-ink">{t('继续了解其他模块', 'Explore other modules')}</h2></Reveal>
          <Stagger className="grid gap-4 sm:grid-cols-3">
            {related.map((a) => {
              const RIcon = ICONS[a.href] ?? Boxes
              return <StaggerItem key={a.href}><a href={base + a.href} onClick={(e) => { e.preventDefault(); nav(base + a.href) }} className="group flex h-full flex-col rounded-2xl border border-line bg-white p-6 shadow-card transition hover:-translate-y-1 hover:shadow-float"><RIcon size={22} className="text-brand-500" /><b className="mt-4 text-[15.5px] font-bold text-ink">{a.title}</b><span className="mt-2 flex-1 text-[13px] leading-6 text-ink-soft">{a.claim}</span><span className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-600">{t('查看', 'View')} <ArrowUpRight size={13} /></span></a></StaggerItem>
            })}
          </Stagger>
        </div>
      </section>
    </>
  )
}

/* ---------- 广告专页 ---------- */
function AdsView() {
  const lang = useLang()
  const t = useT()
  const base = lang === 'en' ? '/en' : ''
  const kpis = lang === 'en' ? enAdKpis : adKpis
  const nature = lang === 'en' ? enServiceNature : serviceNature
  const cards = [
    { icon: BarChart3, t: t('集中查看花费与销售额', 'View spend and sales centrally'), d: t('多个广告账户的花费、点击与广告销售额汇总在一处，按账户币种呈现，不用来回切换后台。', 'Spend, clicks and ad sales from multiple advertising accounts are gathered in one place, presented in account currency, with no back-and-forth between back offices.') },
    { icon: PieChart, t: t('按活动类型拆解结构', 'Break down structure by campaign type'), d: t('花费按品牌词、自动投放等活动类型拆开，快速看清预算投向了哪里。', 'Spend is split by campaign type such as brand and auto targeting, so you quickly see where the budget went.') },
    { icon: Lock, t: t('只读对账，安心可控', 'Read-only reconciliation, under control'), d: t('报表只读，不改出价、不代投放。每份报表都标出数据截止时间，方便和广告后台核对。', 'Reports are read-only — no bid changes, no managed operations. Each report labels its data cutoff time for reconciliation with the advertising back office.') },
  ]
  return (
    <>
      <PageHero eyebrow={t('广告分析 · 只读', 'Advertising analytics · read-only')} title={lang === 'en' ? <>Ad spend and sales, <span className="nv-text-gradient">viewed and analyzed centrally</span></> : <>广告花费与销售额，<span className="nv-text-gradient">集中查看与分析</span></>} lede={nature}>
        <div className="mt-7 flex flex-wrap gap-3"><SiteLink href={`${base}/contact`} className="nv-btn nv-btn-primary">{t('预约演示', 'Book a demo')}<ArrowRight size={16} /></SiteLink><SiteLink href={`${base}/product/advertising`} className="nv-btn nv-btn-ghost">{t('查看广告模块', 'View the advertising module')}</SiteLink></div>
      </PageHero>

      <section className="nv-container-wide py-14">
        <Reveal className="mb-8"><span className="nv-eyebrow"><Megaphone size={13} />{t('报表指标', 'Report metrics')}</span><h2 className="mt-3 text-h2 font-bold text-ink">{t('广告报表包含的指标', 'Metrics included in advertising reports')}</h2></Reveal>
        <div className="overflow-x-auto"><MiniTable head={[t('指标', 'Metric'), t('说明', 'Description'), t('单位', 'Unit'), t('周期', 'Period'), t('更新', 'Update')]} rows={kpis.map(r => [r[0], r[1], r[2], r[3], r[4]])} /></div>
      </section>

      <section className="bg-canvas-soft py-14">
        <div className="nv-container-wide">
          <Reveal className="mb-8 text-center"><span className="nv-eyebrow"><Megaphone size={13} />{t('广告分析', 'Advertising analytics')}</span><h2 className="mt-3 text-h2 font-bold text-ink">{t('广告分析能帮你做什么', 'What advertising analytics can do for you')}</h2></Reveal>
          <Stagger className="grid gap-4 sm:grid-cols-3">
            {cards.map((c) => (
              <StaggerItem key={c.t}>
                <div className="flex h-full flex-col rounded-2xl border border-line bg-white p-6 shadow-card">
                  <span className="grid h-12 w-12 place-items-center text-brand-600"><c.icon size={28} strokeWidth={1.6} /></span>
                  <b className="mt-5 text-[16px] font-bold text-ink">{c.t}</b>
                  <p className="mt-2.5 flex-1 text-[13.5px] leading-6 text-ink-soft">{c.d}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      <section className="nv-container-wide py-16">
        <div className="mx-auto max-w-[820px]">
          <Reveal className="rounded-2xl border border-brand-200 bg-brand-50/50 p-6 text-center">
            <Lock size={18} className="mx-auto text-brand-500" />
            <p className="mt-2 text-[13.5px] leading-6 text-ink-soft">{t(`广告数据默认只读，不改出价、不代投放。联系 ${company.email} 获取报价。`, `Advertising data is read-only by default — no bid changes, no managed operations. Contact ${company.email} for a quote.`)}</p>
          </Reveal>
        </div>
      </section>
    </>
  )
}

export function ProductPages({ page, lang = 'zh' }: { page: string; lang?: Lang }) {
  const cn = page.replace(/^en-/, '')
  const areas = lang === 'en' ? (enProductAreas as Area[]) : productAreas
  let body: ReactNode
  if (cn === 'product') body = <ProductIndexView />
  else if (cn === 'solutions-advertising') body = <AdsView />
  else {
    const area = areas.find(a => a.href === pagePath(cn))
    body = area ? <ProductDetailView area={area} /> : <ProductIndexView />
  }
  return <PageShell lang={lang}>{body}</PageShell>
}
