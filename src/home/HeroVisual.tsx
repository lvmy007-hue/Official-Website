import { useEffect, useState } from 'react'
import { ArrowUpRight, ArrowDownRight, Megaphone, Lock } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'
import { useT } from './i18n'

function useCountUp(target: number, decimals = 0) {
  const reduce = useReducedMotion()
  const [v, setV] = useState(target)
  useEffect(() => {
    if (reduce) { setV(target); return }
    let raf = 0
    const dur = 1500
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      setV(target * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    setV(0)
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, decimals, reduce])
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function Spark({ points, tone }: { points: number[]; tone: 'good' | 'down' }) {
  const max = Math.max(...points), min = Math.min(...points), span = max - min || 1
  const w = 52, h = 18
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - ((p - min) / span) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="overflow-visible" aria-hidden="true">
      <polyline points={d} fill="none" stroke={tone === 'good' ? '#12a38a' : '#d4380d'} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} style={{ strokeDashoffset: 0 }} className="animate-draw" />
    </svg>
  )
}

function Kpi({ label, prefix = '', suffix = '', target, decimals = 0, delta, up, spark }: { label: string; prefix?: string; suffix?: string; target: number; decimals?: number; delta: string; up: boolean; spark: number[] }) {
  const value = useCountUp(target, decimals)
  return (
    <div className="rounded-xl border border-line bg-canvas-soft/60 px-3 py-2.5">
      <div className="text-[11px] text-ink-mute">{label}</div>
      <div className="mt-1 text-[17px] font-bold tracking-tight text-ink tabular-nums">{prefix}{value}{suffix}</div>
      <div className="mt-0.5 flex items-center justify-between">
        <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${up ? 'text-success' : 'text-danger'}`}>{up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{delta}</span>
        <Spark points={spark} tone={up ? 'good' : 'down'} />
      </div>
    </div>
  )
}

export function HeroVisual() {
  const t = useT()
  const segments: [string, number, string][] = [
    [t('SP 自动', 'SP auto'), 4620, '#2b57cf'],
    [t('SP 手动', 'SP manual'), 3180, '#5873e6'],
    [t('SD 展示', 'SD display'), 1980, '#12a38a'],
    [t('SB 品牌', 'SB brand'), 1240, '#e08a00'],
  ]
  const spendTotal = segments.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="relative mx-auto w-full max-w-[640px] px-2 py-6">
      {/* 背景柔光 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/2 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(88,115,230,.16),transparent)]" />
      </div>

      {/* 主看板卡 */}
      <div className="relative overflow-hidden rounded-2xl border border-line bg-white shadow-float animate-fadeup">
        <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-500 via-brand-400 to-success" />
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-[#ff6159]" /><i className="h-2.5 w-2.5 rounded-full bg-[#ffbd2e]" /><i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" /></span>
              <span className="ml-1 text-[12.5px] font-semibold text-ink">{t('经营看板', 'Dashboard')}</span>
              <span className="text-[11.5px] text-ink-mute">· {t('全部店铺 · 近 14 天', 'All stores · 14d')}</span>
            </div>
            <span className="flex items-center gap-2">
              <span className="relative flex h-2 w-2" aria-hidden><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-success" /></span>
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[10.5px] font-bold text-brand-600">{t('演示数据', 'Sample')}</span>
            </span>
          </div>

          {/* KPI */}
          <div className="mt-3.5 grid grid-cols-3 gap-2.5">
            <Kpi label={t('销售额', 'Sales')} prefix="$" target={128640} delta="12.4%" up spark={[5, 6, 5.6, 7, 6.6, 8, 7.6, 9]} />
            <Kpi label={t('订单数', 'Orders')} target={2860} delta="6.2%" up spark={[4, 4.3, 4.1, 4.6, 4.5, 4.8, 4.7, 5]} />
            <Kpi label={t('退款率', 'Refund')} suffix="%" target={1.8} decimals={1} delta="0.3%" up={false} spark={[2.4, 2.3, 2.2, 2.1, 2, 1.95, 1.85, 1.8]} />
          </div>

          {/* 面积图 */}
          <div className="mt-3.5 rounded-xl border border-line bg-white p-3.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-bold text-ink">{t('销售额与毛利趋势', 'Sales & gross profit')}</span>
              <span className="flex items-center gap-3 text-[10.5px] text-ink-mute">
                <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded-full bg-brand-500" />{t('销售额', 'Sales')}</span>
                <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded-full bg-success" />{t('毛利', 'Profit')}</span>
              </span>
            </div>
            <div className="flex gap-1.5">
              <div className="flex flex-col justify-between py-0.5 text-right text-[9px] leading-none text-ink-mute">
                <span>$12k</span><span>$6k</span><span>$0</span>
              </div>
              <svg viewBox="0 0 440 110" preserveAspectRatio="none" className="h-[130px] w-full" aria-hidden="true">
                <defs>
                  <linearGradient id="hv-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5873e6" stopOpacity="0.22" />
                    <stop offset="100%" stopColor="#5873e6" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[10, 60, 100].map((y) => <line key={y} x1="0" y1={y} x2="440" y2={y} stroke="#f1f3f7" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
                <path d="M0,86 C52,80 86,92 122,70 S196,52 244,60 S318,34 366,40 S420,20 440,16 L440,110 L0,110 Z" fill="url(#hv-fill)" />
                <path d="M0,86 C52,80 86,92 122,70 S196,52 244,60 S318,34 366,40 S420,20 440,16" fill="none" stroke="#2b57cf" strokeWidth="2.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={1} style={{ strokeDashoffset: 0 }} className="animate-draw" />
                <path d="M0,100 C54,97 86,101 126,94 S206,86 252,88 S330,76 374,78 S422,70 440,68" fill="none" stroke="#12a38a" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray={1} style={{ strokeDashoffset: 0, animationDelay: '.45s' }} className="animate-draw" />
                <circle cx="440" cy="16" r="3.5" fill="#2b57cf" className="animate-pulsering" style={{ transformOrigin: '440px 16px' }} />
                <circle cx="440" cy="16" r="2.5" fill="#2b57cf" />
              </svg>
            </div>
            <div className="mt-1 flex justify-between pl-[26px] text-[9px] leading-none text-ink-mute">
              <span>10-07</span><span>10-13</span><span>10-20</span>
            </div>
          </div>

          {/* 广告花费结构（堆叠占比条） */}
          <div className="mt-3 rounded-xl border border-line bg-white p-3.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-bold text-ink">{t('广告花费结构 · 按类型', 'Ad spend by type')}</span>
              <span className="flex items-center gap-1.5 text-[10.5px] font-semibold text-ink tabular-nums"><Lock size={10} className="text-ink-mute" />${spendTotal.toLocaleString()}</span>
            </div>
            <div className="flex h-2.5 w-full origin-left overflow-hidden rounded-full animate-growx">
              {segments.map(([n, val, c]) => (
                <span key={n} style={{ width: `${(val / spendTotal) * 100}%`, backgroundColor: c }} className="h-full" />
              ))}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {segments.map(([n, val, c]) => (
                <span key={n} className="flex items-center gap-1.5 text-[10.5px] text-ink-soft">
                  <i className="h-2 w-2 rounded-full" style={{ backgroundColor: c }} />{n}
                  <b className="font-semibold text-ink tabular-nums">${val.toLocaleString()}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 悬浮卡：站点占比（右上） */}
      <div className="absolute -right-1 top-2 animate-floaty">
        <div className="flex items-center gap-3 rounded-xl border border-white/60 bg-white/70 px-3.5 py-3 shadow-float backdrop-blur-md">
          <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
            <circle cx="24" cy="24" r="18" fill="none" stroke="#eceef2" strokeWidth="7" />
            <circle cx="24" cy="24" r="18" fill="none" stroke="#2b57cf" strokeWidth="7" strokeLinecap="round" strokeDasharray="52 113" transform="rotate(-90 24 24)" />
            <circle cx="24" cy="24" r="18" fill="none" stroke="#5873e6" strokeWidth="7" strokeDasharray="34 113" strokeDashoffset="-52" transform="rotate(-90 24 24)" />
          </svg>
          <div className="whitespace-nowrap leading-tight">
            <div className="text-[10.5px] text-ink-mute">{t('站点占比 · 演示', 'By marketplace')}</div>
            <div className="text-[13px] font-bold text-ink">US 46% · UK 30%</div>
          </div>
        </div>
      </div>

      {/* 悬浮卡：广告只读（左下） */}
      <div className="absolute -left-1 bottom-3 animate-floaty" style={{ animationDelay: '1.4s' }}>
        <div className="flex items-center gap-2.5 rounded-xl border border-white/60 bg-white/70 px-3.5 py-3 shadow-float backdrop-blur-md">
          <Megaphone size={18} strokeWidth={1.8} className="shrink-0 text-brand-500" />
          <div className="whitespace-nowrap leading-tight">
            <div className="flex items-center gap-1.5 text-[10.5px] text-ink-mute"><Lock size={10} />{t('广告只读 · ACoS', 'Ads read-only · ACoS')}</div>
            <div className="text-[14px] font-bold text-ink">18.3%<span className="ml-1.5 text-[11px] font-semibold text-success">↓ 1.1%</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
