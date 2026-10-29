import { ClipboardList, MessagesSquare, FileText, ArrowRight } from 'lucide-react'
import { SiteLink } from '../site-link'
import { useT, useL } from './i18n'
import { Reveal } from '../ui/motion'

export function Process() {
  const t = useT()
  const L = useL()
  const STEPS = [
    { icon: ClipboardList, n: '01', t: t('确认开通范围', 'Confirm the scope'), d: t('按公司数量、是否需要广告报表，选择合适的开通范围。', 'Choose the right scope by number of companies and whether advertising reports are needed.') },
    { icon: MessagesSquare, n: '02', t: t('预约演示沟通', 'Book a demo'), d: t('提交需求后，顾问演示系统并确认使用与对账流程。', 'After you submit a request, a consultant demos the system and confirms the setup and reconciliation flow.') },
    { icon: FileText, n: '03', t: t('获取书面报价', 'Written plan'), d: t('依据范围出具书面报价。网页不收款，按方案签约。', 'A written plan is issued for the scope. No payment on this website; you sign per the plan.') },
  ]
  return (
    <section className="py-20">
      <div className="nv-container-wide">
        <Reveal className="mx-auto max-w-[720px] text-center">
          <span className="nv-eyebrow">{t('开通流程', 'Onboarding')}</span>
          <h2 className="mt-4 text-h2 font-bold text-ink">{t('三步开通，按方案报价', 'Three steps, priced by plan')}</h2>
          <p className="mt-3 text-[16px] leading-7 text-ink-soft">{t('先确认范围、再演示沟通、最后出具书面报价。全程不在网页收款。', 'Confirm the scope, book a demo, then receive a written plan. No payment on this website.')}</p>
        </Reveal>

        <ol className="mt-16 grid gap-y-12 md:grid-cols-3 md:gap-x-6">
          {STEPS.map((s, i) => (
            <li key={s.n} className="relative">
              {i < STEPS.length - 1 ? <span aria-hidden className="absolute left-1/2 top-7 hidden h-px w-full bg-gradient-to-r from-brand-300 to-line md:block" /> : null}
              <Reveal delay={i * 0.08} className="relative flex flex-col items-center text-center">
                <span className="relative z-10 grid h-14 w-14 place-items-center rounded-full border-4 border-white bg-brand-500 text-white shadow-glow"><s.icon size={22} /></span>
                <span className="mt-5 text-[12px] font-extrabold uppercase tracking-[0.18em] text-brand-400">{t('步骤', 'Step')} {s.n}</span>
                <b className="mt-1.5 block text-[18px] font-bold text-ink">{s.t}</b>
                <p className="mt-2 max-w-[280px] text-[14px] leading-6 text-ink-soft">{s.d}</p>
              </Reveal>
            </li>
          ))}
        </ol>

        <Reveal className="mt-14 text-center">
          <SiteLink href={L('/contact')} className="nv-btn nv-btn-primary">{t('预约演示，获取书面报价', 'Book a demo for a written plan')}<ArrowRight size={16} /></SiteLink>
        </Reveal>
      </div>
    </section>
  )
}
