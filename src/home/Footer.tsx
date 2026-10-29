import { Mail, MapPin } from 'lucide-react'
import { BrandMark } from '../brand'
import { SiteLink, nav } from '../site-link'
import { company } from '../site-company'
import { useLang, useT, useL } from './i18n'

export function Footer() {
  const lang = useLang()
  const t = useT()
  const L = useL()
  const en = lang === 'en'

  const COLS = en
    ? [
        { head: 'Product', links: [['Inventory', '/en/product/inventory'], ['Reconciliation', '/en/product/finance'], ['Ad reports', '/en/product/advertising'], ['Orders', '/en/product/orders'], ['Permissions', '/en/product/permissions']] as [string, string][] },
        { head: 'Solutions', links: [['Multiple stores / entities', '/en/solutions'], ['Multi-currency reconciliation', '/en/solutions'], ['Ad read-only reports', '/en/solutions/advertising'], ['Pricing & plans', '/en/pricing']] as [string, string][] },
        { head: 'Resources', links: [['Help center', '/en/resources'], ['Updates', '/en/news'], ['Security', '/en/security'], ['Book a demo', '/en/contact']] as [string, string][] },
        { head: 'About', links: [['About us', '/en/about'], ['Privacy Policy', '/en/privacy'], ['Terms of Service', '/en/terms'], ['中文', '/']] as [string, string][] },
      ]
    : [
        { head: '产品', links: [['进销存管理', '/product/inventory'], ['财务对账', '/product/finance'], ['广告报表', '/product/advertising'], ['订单管理', '/product/orders'], ['成员权限', '/product/permissions']] as [string, string][] },
        { head: '解决方案', links: [['多店铺 / 多公司', '/solutions'], ['多币种对账', '/solutions'], ['广告只读报表', '/solutions/advertising'], ['价格与方案', '/pricing']] as [string, string][] },
        { head: '资源与支持', links: [['帮助中心', '/resources'], ['更新动态', '/news'], ['安全说明', '/security'], ['预约演示', '/contact']] as [string, string][] },
        { head: '关于', links: [['关于我们', '/about'], ['隐私政策', '/privacy'], ['服务条款', '/terms'], ['English', '/en']] as [string, string][] },
      ]

  return (
    <footer className="border-t border-line bg-canvas-soft">
      {/* 链接区 */}
      <div className="nv-container-wide grid gap-10 pb-12 pt-14 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <BrandMark size={30} />
            <span className="leading-none"><b className="block text-[16px] font-bold text-ink">NOVA ERP</b><small className="block text-[10px] font-semibold tracking-[0.14em] text-ink-mute">DZANX</small></span>
          </div>
          <p className="mt-4 max-w-[280px] text-[13px] leading-6 text-ink-soft">{t(`${company.legalName}运营的跨境电商经营中台，集中管理亚马逊卖家的订单、库存、财务与广告报表。`, `${company.legalNameEn} operates NOVA ERP, a workspace that brings orders, inventory, finance and advertising reports of Amazon sellers together.`)}</p>
          <a href={`mailto:${company.email}`} className="mt-4 inline-flex items-center gap-2 text-[13px] font-semibold text-brand-600"><Mail size={14} />{company.email}</a>
          <p className="mt-2 flex items-start gap-2 text-[12.5px] leading-5 text-ink-mute"><MapPin size={14} className="mt-0.5 shrink-0" />{en ? company.addressEn : company.address}</p>
        </div>

        {COLS.map((col) => (
          <div key={col.head}>
            <div className="text-[13px] font-bold text-ink">{col.head}</div>
            <ul className="mt-4 space-y-2.5">
              {col.links.map(([label, href]) => (
                <li key={label}><a href={href} onClick={(e) => { e.preventDefault(); nav(href) }} className="text-[13px] text-ink-soft transition hover:text-brand-600">{label}</a></li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* 底部版权 */}
      <div className="border-t border-line">
        <div className="nv-container-wide flex flex-col items-start justify-between gap-2 py-6 text-[12px] text-ink-mute sm:flex-row sm:items-center">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>© {new Date().getFullYear()} {en ? company.legalNameEn : company.legalName}</span>
            <span className="hidden sm:inline">·</span>
            <span>{t('统一社会信用代码', 'Unified social credit code')} {company.creditCode}</span>
            {company.icpNumber ? (
              <>
                <span className="hidden sm:inline">·</span>
                <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer" className="transition hover:text-brand-600">{company.icpNumber}</a>
              </>
            ) : null}
          </div>
          <div className="flex gap-4">
            <SiteLink href={L('/privacy')} className="transition hover:text-brand-600">{t('隐私政策', 'Privacy')}</SiteLink>
            <SiteLink href={L('/terms')} className="transition hover:text-brand-600">{t('服务条款', 'Terms')}</SiteLink>
            <SiteLink href={L('/security')} className="transition hover:text-brand-600">{t('安全说明', 'Security')}</SiteLink>
          </div>
        </div>
      </div>
    </footer>
  )
}
