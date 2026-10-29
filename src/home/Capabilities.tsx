import { Boxes, Wallet, RotateCcw, Megaphone, ShoppingCart, Tags, ShieldCheck, Truck, ArrowUpRight } from 'lucide-react'
import { nav } from '../site-link'
import { useT, useL } from './i18n'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'

export function Capabilities() {
  const t = useT()
  const L = useL()
  const CARDS = [
    { icon: Boxes, t: t('进销存一体管理', 'Inventory & orders in one'), d: t('库存、入库、刊登和订单挂在同一家公司的卖家账号上。', 'Inventory, inbound, listings and orders sit under one company\u2019s seller account.'), href: '/product/inventory' },
    { icon: Wallet, t: t('财务精准管理', 'Finance you can reconcile'), d: t('收入、退款、费用按同一币种排列，退款可对回原订单月。', 'Revenue, refunds and fees listed per currency; refunds trace back to the order month.'), href: '/product/finance' },
    { icon: RotateCcw, t: t('跨月退货', 'Cross-month returns'), d: t('本月入账的退款对回原订单月，不算进新销售。', 'A refund posted this month is matched to its original order, not new sales.'), href: '/product/returns' },
    { icon: Megaphone, t: t('广告报表', 'Advertising reports'), d: t('广告账户单独连接后查看花费、点击和广告销售额，只读。', 'Spend, clicks and ad sales after the ads account connects. Read-only.'), href: '/product/advertising' },
    { icon: ShoppingCart, t: t('订单管理', 'Orders'), d: t('购买日、状态和币种留在这家店。买家信息发货后按期删除。', 'Purchase date, status and currency stay with the store; buyer data is deleted after shipment.'), href: '/product/orders' },
    { icon: Tags, t: t('商品刊登', 'Listings'), d: t('ASIN、SKU 和刊登状态用来对照订单和库存，不代改刊登。', 'ASIN, SKU and listing status are read for matching. Listings are not edited.'), href: '/product/listings' },
    { icon: ShieldCheck, t: t('成员权限', 'Member permissions'), d: t('运营、财务、广告各看各的公司，登录不等于能看每一家。', 'Ops, finance and ads staff see only their companies; signing in does not open every one.'), href: '/product/permissions' },
    { icon: Truck, t: t('FBA 入库', 'FBA inbound'), d: t('先有卖家授权才能建计划，货件号与接收数量来自同步。', 'Seller authorization comes first; shipment IDs and received units come from sync.'), href: '/product/inbound' },
  ]
  return (
    <section className="py-20">
      <div className="nv-container-wide">
        <Reveal className="mx-auto max-w-[720px] text-center">
          <span className="nv-eyebrow">{t('核心能力', 'Core capabilities')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{t('订单、库存、财务与广告报表，按法律主体分开', 'Orders, inventory, finance and advertising, separated by legal entity')}</h2>
          <p className="mt-3 text-[16px] leading-7 text-ink-soft">{t('每一类数据都集中在一个工作台查看，广告数据只读。规范的权限与对账，是跨境多店铺经营的底座。', 'Every data type comes together in one workspace, with advertising kept read-only. Proper permissions and reconciliation are the foundation of multi-store cross-border operations.')}</p>
        </Reveal>

        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CARDS.map((c) => (
            <StaggerItem key={c.t}>
              <a
                href={L(c.href)}
                onClick={(e) => { e.preventDefault(); nav(L(c.href)) }}
                className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-white p-6 shadow-card transition duration-300 hover:-translate-y-1.5 hover:border-brand-200 hover:shadow-float"
              >
                <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[3px] origin-left scale-x-0 bg-gradient-to-r from-brand-400 to-brand-600 transition-transform duration-300 group-hover:scale-x-100" />
                <span className="grid h-11 w-11 place-items-center text-brand-600 transition group-hover:text-brand-700">
                  <c.icon size={26} strokeWidth={1.6} />
                </span>
                <b className="mt-5 text-[16.5px] font-bold text-ink">{c.t}</b>
                <span className="mt-2.5 flex-1 text-[13.5px] leading-[1.6] text-ink-soft">{c.d}</span>
                <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-600 opacity-0 transition group-hover:opacity-100">
                  {t('了解更多', 'Learn more')} <ArrowUpRight size={14} />
                </span>
              </a>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}
