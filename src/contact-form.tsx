import { useState } from 'react'
import type { FormEvent } from 'react'
import { SiteLink } from './site-link'
import { publicPost } from './public-api'

const copy = {
  zh: {
    honeypot: '公司网站', name: '姓名', company: '公司名称', email: '公司邮箱', phone: '电话（选填）', phoneHint: '联系电话',
    scope: '接入范围', stores: '店铺数量', time: '方便联系的时间（选填）', timeHint: '例如：工作日下午',
    message: '需求说明', messageHint: '请描述企业数量、店铺规模和需要的报表。不要填写 Amazon 密码或令牌。',
    consent: '我已阅读并同意隐私政策', privacy: '查看隐私政策', privacyHref: '/privacy',
    submit: '提交联系信息', busy: '提交中…', note: '提交的信息仅用于联系，不会自动创建账号。',
    needConsent: '请先阅读并同意隐私政策。', done: (ref?: string) => ref ? `已收到，咨询编号 ${ref}。工作日内邮件回复。` : '已收到。工作日内邮件回复。',
    failed: '提交失败，请稍后重试，或直接发邮件。', timeLabel: '方便联系时间',
    scopes: ['Seller / FBA', 'Amazon Ads', 'Seller + Ads', '企业治理'],
  },
  en: {
    honeypot: 'Company website', name: 'Name', company: 'Company', email: 'Business email', phone: 'Phone (optional)', phoneHint: 'Phone',
    scope: 'Scope', stores: 'Number of stores', time: 'Preferred contact time (optional)', timeHint: 'e.g. weekday afternoons, UTC+8',
    message: 'What do you need?', messageHint: 'Number of companies, stores and the reports you need. Do not enter Amazon passwords or tokens.',
    consent: 'I have read and agree to the Privacy Policy', privacy: 'Privacy Policy', privacyHref: '/en/privacy',
    submit: 'Send request', busy: 'Sending…', note: 'Used only to reply to you. No account is created automatically.',
    needConsent: 'Please accept the Privacy Policy first.', done: (ref?: string) => ref ? `Received. Reference ${ref}. We reply by email on working days.` : 'Received. We reply by email on working days.',
    failed: 'Sending failed. Please try again or email us directly.', timeLabel: 'Preferred contact time',
    scopes: ['Seller / FBA', 'Amazon Ads', 'Seller + Ads', 'Team governance'],
  },
}

export function ContactForm({ lang = 'zh' }: { lang?: 'zh' | 'en' }) {
  const t = copy[lang]
  const empty = { name: '', company: '', email: '', phone: '', subject: t.scopes[0], storeBand: '1–5', time: '', message: '', consent: false, companyWebsite: '' }
  const [form, setForm] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!form.consent) { setStatus({ tone: 'error', text: t.needConsent }); return }
    if (form.companyWebsite) { setStatus({ tone: 'ok', text: t.done() }); setForm(empty); return }
    setBusy(true)
    setStatus(null)
    try {
      const message = form.time ? `${form.message}\n\n${t.timeLabel}：${form.time}` : form.message
      const result = await publicPost<{ reference?: string }>('/contact-requests', { name: form.name, company: form.company, email: form.email, phone: form.phone || undefined, topic: form.subject, storeBand: form.storeBand, companyWebsite: form.companyWebsite, message })
      setStatus({ tone: 'ok', text: t.done(result.reference) })
      setForm(empty)
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error && error.message && !error.message.startsWith('HTTP') ? error.message : t.failed })
    } finally { setBusy(false) }
  }
  const field = 'mt-1.5 w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none transition placeholder:text-ink-mute/60 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/15'
  const fieldLabel = 'block text-[13px] font-semibold text-ink-soft'
  return <form id="contact-form" className="space-y-4" onSubmit={submit}>
    <div className="absolute -left-[10000px] h-px w-px overflow-hidden" aria-hidden="true"><label>{t.honeypot}<input tabIndex={-1} autoComplete="off" value={form.companyWebsite} onChange={event => setForm({ ...form, companyWebsite: event.target.value })} /></label></div>
    <div className="grid gap-4 sm:grid-cols-2"><label className={fieldLabel}>{t.name}<input className={field} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder={t.name} autoComplete="name" required /></label><label className={fieldLabel}>{t.company}<input className={field} value={form.company} onChange={event => setForm({ ...form, company: event.target.value })} placeholder={t.company} autoComplete="organization" required /></label></div>
    <div className="grid gap-4 sm:grid-cols-2"><label className={fieldLabel}>{t.email}<input className={field} type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="name@company.com" autoComplete="email" required /></label><label className={fieldLabel}>{t.phone}<input className={field} value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} placeholder={t.phoneHint} autoComplete="tel" /></label></div>
    <div className="grid gap-4 sm:grid-cols-2"><label className={fieldLabel}>{t.scope}<select className={field} value={form.subject} onChange={event => setForm({ ...form, subject: event.target.value })}>{t.scopes.map(item => <option key={item}>{item}</option>)}</select></label><label className={fieldLabel}>{t.stores}<select className={field} value={form.storeBand} onChange={event => setForm({ ...form, storeBand: event.target.value })}><option>1–5</option><option>6–20</option><option>21–100</option><option>100+</option></select></label></div>
    <label className={fieldLabel}>{t.time}<input className={field} value={form.time} maxLength={60} onChange={event => setForm({ ...form, time: event.target.value })} placeholder={t.timeHint} /></label>
    <label className={fieldLabel}>{t.message}<textarea className={`${field} resize-y leading-6`} value={form.message} maxLength={4000} onChange={event => setForm({ ...form, message: event.target.value })} placeholder={t.messageHint} rows={6} required /></label>
    <p className="-mt-1 text-right text-[12px] text-ink-mute">{form.message.length}/4000</p>
    <label className="flex items-start gap-2.5 text-[13.5px] text-ink-soft"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 rounded border border-line accent-brand-500" checked={form.consent} onChange={event => setForm({ ...form, consent: event.target.checked })} required /><span>{t.consent}　<SiteLink href={t.privacyHref} className="font-semibold text-brand-600 hover:underline">{t.privacy}</SiteLink></span></label>
    <button className="nv-btn nv-btn-primary w-full" disabled={busy}>{busy ? t.busy : t.submit} →</button>
    {status ? <p className={`rounded-lg px-3.5 py-2.5 text-[13px] ${status.tone === 'ok' ? 'bg-brand-50 text-brand-700' : 'bg-[#fdeded] text-[#c62828]'}`} role="status">{status.text}</p> : null}
    <small className="block text-[12px] leading-5 text-ink-mute">{t.note}</small>
  </form>
}
