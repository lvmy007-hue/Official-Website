import { ShieldCheck, Lock, KeyRound, Trash2, Eye, Users, ArrowRight } from 'lucide-react'
import { company } from '../site-company'
import { useT } from './i18n'
import { SiteLink } from '../site-link'
import { Reveal, Stagger, StaggerItem } from '../ui/motion'

export function Security() {
  const t = useT()
  const PILLARS = [
    { icon: Lock, t: t('传输加密', 'Transport encryption'), d: t('数据经由 HTTPS 加密传输，凭据加密存储，不在前端暴露密钥。', 'Data is served over HTTPS and credentials are encrypted at rest; no keys are exposed to the browser.') },
    { icon: KeyRound, t: t('连接可控', 'Controllable access'), d: t('卖家与广告连接分开进行，可随时撤销。', 'Seller and advertising connections are separate and can be revoked at any time.') },
    { icon: Eye, t: t('广告只读', 'Advertising read-only'), d: t('广告数据仅用于查看与对账，不改出价、不代投放。', 'Advertising data is for viewing and reconciliation only — no bid changes, no managed campaigns.') },
    { icon: Trash2, t: t('定期删除', 'Scheduled deletion'), d: t(`买家个人信息在发货后约 ${company.piiRetentionDays} 天内按政策删除。`, `Buyer personal data is deleted within about ${company.piiRetentionDays} days after shipment, per policy.`) },
    { icon: Users, t: t('权限分级', 'Scoped permissions'), d: t('运营、财务、广告按法律主体分权查看，互不串看。', 'Ops, finance and ads are scoped by legal entity and cannot cross-view.') },
    { icon: ShieldCheck, t: t('数据隔离', 'Data isolation'), d: t('各公司账套相互隔离，未授权主体不进入合并报表。', 'Company books are isolated; unauthorized entities never enter consolidated reports.') },
  ]
  return (
    <section className="border-y border-line bg-canvas-soft py-20">
      <div className="nv-container-wide">
        <Reveal className="mx-auto flex max-w-[680px] flex-col items-center text-center">
          <span className="nv-eyebrow">{t('安全与合规', 'Security & compliance')}</span>
          <h2 className="mt-5 text-h2 font-bold text-ink">{t('规范的数据安全与权限', 'Solid data security and permissions')}</h2>
          <p className="mt-4 text-[15.5px] leading-7 text-ink-soft">{t('数据使用、存储与删除策略在隐私政策与安全说明中逐项列明，确保你的经营数据安全、可控。', 'Data use, storage and deletion are detailed in our Privacy Policy and Security page, so your business data stays safe and under control.')}</p>
        </Reveal>

        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p) => (
            <StaggerItem key={p.t}>
              <div className="h-full rounded-2xl border border-line bg-white p-6 shadow-card transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-float">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><p.icon size={22} strokeWidth={1.6} /></span>
                <b className="mt-4 block text-[16px] font-bold text-ink">{p.t}</b>
                <p className="mt-2 text-[13px] leading-6 text-ink-soft">{p.d}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>

        <div className="mt-10 text-center">
          <SiteLink href="/security" className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-brand-600 transition hover:gap-2.5">{t('查看安全说明', 'Read the security overview')}<ArrowRight size={15} /></SiteLink>
        </div>
      </div>
    </section>
  )
}
