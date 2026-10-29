import { useEffect, useState } from 'react'
import * as NavigationMenu from '@radix-ui/react-navigation-menu'
import { ChevronDown, Boxes, Wallet, LineChart, Megaphone, BookOpen, FileText, History, LifeBuoy, ArrowRight, Menu, X } from 'lucide-react'
import { BrandMark } from '../brand'
import { SiteLink, nav } from '../site-link'
import { useLang, useT, useL } from './i18n'

const TRIGGER = 'inline-flex items-center gap-1 rounded-lg px-3 py-2 text-[14px] font-medium text-ink-soft transition hover:bg-canvas-soft hover:text-ink data-[state=open]:text-brand-600'
const LINK = 'inline-flex items-center rounded-lg px-3 py-2 text-[14px] font-medium text-ink-soft transition hover:bg-canvas-soft hover:text-ink'

function MegaItem({ t, d, href }: { t: string; d: string; href: string }) {
  return (
    <a href={href} onClick={(e) => { e.preventDefault(); nav(href) }} className="group block rounded-lg px-3 py-2 transition hover:bg-canvas-soft">
      <b className="flex items-center gap-1 text-[13.5px] font-semibold text-ink transition group-hover:text-brand-600">{t}<ArrowRight size={12} className="-translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" /></b>
      <span className="mt-0.5 block text-[12px] leading-5 text-ink-mute">{d}</span>
    </a>
  )
}

export function Header() {
  const lang = useLang()
  const tr = useT()
  const L = useL()
  const en = lang === 'en'
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const go = (href: string) => { nav(L(href)); setMobileOpen(false) }
  const mobileNav = [
    { t: tr('产品', 'Product'), href: '/product' },
    { t: tr('解决方案', 'Solutions'), href: '/solutions' },
    { t: tr('价格', 'Pricing'), href: '/pricing' },
    { t: tr('资源与支持', 'Resources'), href: '/resources' },
    { t: tr('关于', 'About'), href: '/about' },
    { t: tr('联系', 'Contact'), href: '/contact' },
  ]

  const PRODUCT_COLS = [
    { head: tr('供应链', 'Supply chain'), icon: Boxes, items: [
      { t: tr('FBA 库存', 'FBA inventory'), d: tr('可售 / 预留 / 在途一屏', 'Sellable / reserved / inbound'), href: '/product/inventory' },
      { t: tr('FBA 入库', 'FBA inbound'), d: tr('创建入库计划与货件', 'Plans and shipments'), href: '/product/inbound' },
      { t: tr('商品刊登', 'Listings'), d: tr('ASIN / SKU 对照', 'ASIN / SKU matching'), href: '/product/listings' },
    ] },
    { head: tr('财务', 'Finance'), icon: Wallet, items: [
      { t: tr('财务对账', 'Reconciliation'), d: tr('同一币种收支核对', 'Within one currency'), href: '/product/finance' },
      { t: tr('跨月退货', 'Cross-month returns'), d: tr('退款对回原订单月', 'Back to the order month'), href: '/product/returns' },
    ] },
    { head: tr('运营', 'Operations'), icon: LineChart, items: [
      { t: tr('订单管理', 'Orders'), d: tr('购买日 / 状态 / 币种', 'Date / status / currency'), href: '/product/orders' },
      { t: tr('多店铺', 'Multiple stores'), d: tr('按法律主体分开', 'Separated by entity'), href: '/product/stores' },
      { t: tr('成员权限', 'Permissions'), d: tr('分级查看各自公司', 'Scoped per company'), href: '/product/permissions' },
    ] },
    { head: tr('广告', 'Advertising'), icon: Megaphone, items: [
      { t: tr('广告报表', 'Ad reports'), d: tr('花费 / ACoS 只读', 'Spend / ACoS, read-only'), href: '/product/advertising' },
    ] },
  ]

  const RESOURCES = [
    { t: tr('帮助中心', 'Help center'), d: tr('使用说明与常见问题', 'Guides and FAQ'), href: '/resources', icon: BookOpen },
    { t: tr('隐私与安全', 'Privacy & security'), d: tr('数据保护与删除策略', 'Data protection and deletion'), href: '/security', icon: FileText },
    { t: tr('更新动态', 'Updates'), d: tr('产品功能更新', 'Product updates'), href: '/news', icon: History },
    { t: tr('联系支持', 'Support'), d: tr('预约演示与方案报价', 'Demos and plans'), href: '/contact', icon: LifeBuoy },
  ]

  return (
    <header className={`sticky top-0 z-50 border-b transition-colors ${scrolled ? 'border-line bg-white/85 shadow-card backdrop-blur-xl' : 'border-transparent bg-white/70 backdrop-blur-md'}`}>
      <div className="nv-container-wide flex h-16 items-center gap-6">
        <a href={L('/')} onClick={(e) => { e.preventDefault(); nav(L('/')) }} className="flex items-center gap-2.5">
          <BrandMark size={32} />
          <span className="leading-none"><b className="block text-[17px] font-bold tracking-tight text-ink">NOVA ERP</b><small className="block text-[10px] font-semibold tracking-[0.14em] text-ink-mute">DZANX</small></span>
        </a>

        <NavigationMenu.Root className="relative hidden lg:block" delayDuration={80}>
          <NavigationMenu.List className="flex items-center gap-0.5">
            <NavigationMenu.Item>
              <NavigationMenu.Trigger className={TRIGGER}>{tr('产品', 'Product')} <ChevronDown size={14} className="opacity-60 transition group-data-[state=open]:rotate-180" /></NavigationMenu.Trigger>
              <NavigationMenu.Content className="w-[780px] data-[motion=from-start]:animate-in data-[motion=to-start]:animate-out">
                <div className="flex gap-3 p-3">
                  <div className="flex w-[218px] shrink-0 flex-col rounded-xl bg-canvas-soft p-5">
                    <span className="grid h-10 w-10 place-items-center rounded-lg bg-white text-brand-600 shadow-card"><Boxes size={22} strokeWidth={1.6} /></span>
                    <b className="mt-4 text-[14.5px] font-bold text-ink">{tr('产品能力', 'Product')}</b>
                    <p className="mt-1.5 text-[12.5px] leading-5 text-ink-mute">{tr('9 个模块，从订单、库存到财务与广告，覆盖多公司的日常经营。', 'Nine modules spanning orders, inventory, finance and advertising for multi-entity operations.')}</p>
                    <a href={L('/product')} onClick={(e) => { e.preventDefault(); nav(L('/product')) }} className="mt-auto inline-flex items-center gap-1 pt-5 text-[13px] font-semibold text-brand-600">{tr('查看产品总览', 'All products')}<ArrowRight size={13} /></a>
                  </div>
                  <div className="grid flex-1 grid-cols-2 gap-x-5 gap-y-5 py-2">
                    {PRODUCT_COLS.map((col) => (
                      <div key={col.head}>
                        <div className="mb-2 flex items-center gap-1.5 border-b border-line pb-2 text-[11.5px] font-bold uppercase tracking-wide text-ink-mute"><col.icon size={13} className="text-brand-500" />{col.head}</div>
                        <div className="space-y-0.5">{col.items.map((it) => <MegaItem key={it.t} t={it.t} d={it.d} href={L(it.href)} />)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </NavigationMenu.Content>
            </NavigationMenu.Item>

            <NavigationMenu.Item>
              <NavigationMenu.Trigger className={TRIGGER}>{tr('解决方案', 'Solutions')} <ChevronDown size={14} className="opacity-60" /></NavigationMenu.Trigger>
              <NavigationMenu.Content className="w-[560px]">
                <div className="flex gap-3 p-3">
                  <div className="flex w-[190px] shrink-0 flex-col rounded-xl bg-canvas-soft p-5">
                    <span className="grid h-10 w-10 place-items-center rounded-lg bg-white text-brand-600 shadow-card"><LineChart size={22} strokeWidth={1.6} /></span>
                    <b className="mt-4 text-[14.5px] font-bold text-ink">{tr('解决方案', 'Solutions')}</b>
                    <p className="mt-1.5 text-[12.5px] leading-5 text-ink-mute">{tr('不预设统一套餐，按你的经营结构组合能力。', 'No preset package — compose capabilities around your operating structure.')}</p>
                    <a href={L('/solutions')} onClick={(e) => { e.preventDefault(); nav(L('/solutions')) }} className="mt-auto inline-flex items-center gap-1 pt-5 text-[13px] font-semibold text-brand-600">{tr('查看全部方案', 'All solutions')}<ArrowRight size={13} /></a>
                  </div>
                  <div className="flex-1 py-1">
                    <MegaItem t={tr('多店铺 / 多公司', 'Multiple stores / entities')} d={tr('按法律主体分账经营', 'Separate books by legal entity')} href={L('/solutions')} />
                    <MegaItem t={tr('多币种对账', 'Multi-currency reconciliation')} d={tr('同一币种内核对收支', 'Reconcile within one currency')} href={L('/solutions')} />
                    <MegaItem t={tr('广告只读报表', 'Ad read-only reports')} d={tr('花费与广告销售额集中查看', 'Spend and ad sales in one view')} href={L('/solutions/advertising')} />
                    <MegaItem t={tr('精细化运营', 'Fine-grained operations')} d={tr('库存、订单、财务联动', 'Inventory, orders and finance in sync')} href={L('/solutions')} />
                  </div>
                </div>
              </NavigationMenu.Content>
            </NavigationMenu.Item>

            <NavigationMenu.Item><a href={L('/pricing')} onClick={(e) => { e.preventDefault(); nav(L('/pricing')) }} className={LINK}>{tr('价格', 'Pricing')}</a></NavigationMenu.Item>

            <NavigationMenu.Item>
              <NavigationMenu.Trigger className={TRIGGER}>{tr('资源与支持', 'Resources')} <ChevronDown size={14} className="opacity-60" /></NavigationMenu.Trigger>
              <NavigationMenu.Content className="w-[460px]">
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 p-3">
                  {RESOURCES.map((r) => <MegaItem key={r.t} t={r.t} d={r.d} href={L(r.href)} />)}
                </div>
              </NavigationMenu.Content>
            </NavigationMenu.Item>

            <NavigationMenu.Item><a href={L('/about')} onClick={(e) => { e.preventDefault(); nav(L('/about')) }} className={LINK}>{tr('关于', 'About')}</a></NavigationMenu.Item>
          </NavigationMenu.List>

          <div className="absolute left-0 top-full flex justify-start perspective-[2000px]">
            <NavigationMenu.Viewport className="relative mt-2 h-[var(--radix-navigation-menu-viewport-height)] w-[var(--radix-navigation-menu-viewport-width)] shrink-0 origin-top-left overflow-hidden rounded-2xl border border-line bg-white shadow-float transition-[width,height] duration-200" />
          </div>
        </NavigationMenu.Root>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <a href={en ? '/' : '/en'} onClick={(e) => { e.preventDefault(); nav(en ? '/' : '/en') }} className="hidden text-[13px] font-semibold text-ink-mute transition hover:text-ink sm:inline">{en ? '中文' : 'EN'}</a>
          <a href={en ? '/login' : '/login'} className="hidden text-[14px] font-medium text-ink-soft transition hover:text-ink sm:inline">{tr('登录', 'Sign in')}</a>
          <SiteLink href={L('/contact')} className="hidden nv-btn nv-btn-primary nv-btn-sm sm:inline-flex">{tr('联系销售', 'Contact sales')}<ArrowRight size={15} /></SiteLink>
          <button type="button" onClick={() => setMobileOpen(v => !v)} aria-label={tr('菜单', 'Menu')} aria-expanded={mobileOpen} className="grid h-10 w-10 place-items-center rounded-lg text-ink-soft transition hover:bg-canvas-soft hover:text-ink lg:hidden">
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="border-t border-line bg-white lg:hidden">
          <nav className="nv-container-wide space-y-1 py-4" aria-label={tr('移动端导航', 'Mobile navigation')}>
            {mobileNav.map((m) => (
              <a key={m.t} href={L(m.href)} onClick={(e) => { e.preventDefault(); go(m.href) }} className="flex items-center justify-between rounded-xl px-4 py-3 text-[15px] font-medium text-ink-soft transition hover:bg-canvas-soft hover:text-ink">
                {m.t}<ArrowRight size={15} className="text-ink-mute" />
              </a>
            ))}
            <div className="mt-3 flex items-center gap-3 border-t border-line pt-4">
              <a href={en ? '/' : '/en'} onClick={(e) => { e.preventDefault(); nav(en ? '/' : '/en'); setMobileOpen(false) }} className="flex-1 rounded-lg border border-line px-4 py-2.5 text-center text-[14px] font-semibold text-ink-soft transition hover:text-ink">{en ? '中文' : 'EN'}</a>
              <a href="/login" className="flex-1 rounded-lg border border-line px-4 py-2.5 text-center text-[14px] font-medium text-ink-soft transition hover:text-ink">{tr('登录', 'Sign in')}</a>
            </div>
            <SiteLink href={L('/contact')} className="nv-btn nv-btn-primary mt-3 w-full">{tr('联系销售', 'Contact sales')}<ArrowRight size={15} /></SiteLink>
          </nav>
        </div>
      )}
    </header>
  )
}
