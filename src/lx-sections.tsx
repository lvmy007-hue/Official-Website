import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { SiteLink } from './site-link'
import { CoreIcon } from './core-icon'
import { CountUp, useAutoCycle } from './lx-motion'
import { panelByKey, type Lang, type PanelKey } from './lx-panels'

export type Scene = { label: string; panel: PanelKey | 'dash'; render?: () => ReactNode }

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.3 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, inView] as const
}

export function HeroStage({ scenes, lang }: { scenes: Scene[]; lang: Lang }) {
  const [hover, setHover] = useState(false)
  const [index, setIndex] = useAutoCycle(scenes.length, 6000, hover)
  const scene = scenes[index]
  const Panel = scene.panel === 'dash' ? null : panelByKey[scene.panel]
  return <div className="lxm-stage" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <div className="lxm-tabs" role="tablist" aria-label={lang === 'en' ? 'Product scenes' : '产品场景'}>
      {scenes.map((item, itemIndex) => <button key={item.label} type="button" role="tab" aria-selected={itemIndex === index} className={itemIndex === index ? 'is-on' : ''} onClick={() => setIndex(itemIndex)}>{item.label}{itemIndex === index && !hover ? <i className="lxm-progress" /> : null}</button>)}
    </div>
    <div className="lxm-fade" key={scene.label}>{scene.render ? scene.render() : Panel ? <Panel lang={lang} /> : null}</div>
  </div>
}

export type ModuleChapter = { title: string; lede: string; href: string; cta: string; points: Array<{ title: string; text: string; panel: PanelKey }> }

export function ModuleSwitcher({ chapter, lang, flip, muted, demoLabel }: { chapter: ModuleChapter; lang: Lang; flip?: boolean; muted?: boolean; demoLabel: string }) {
  const [ref, inView] = useInView<HTMLElement>()
  const [hover, setHover] = useState(false)
  const [index, setIndex] = useAutoCycle(chapter.points.length, 5000, hover || !inView)
  const point = chapter.points[index]
  const Panel = panelByKey[point.panel]
  return <section ref={ref} className={`lxm-switch${flip ? ' is-flip' : ''}${muted ? ' is-muted' : ''}`}>
    <div className="lx-wrap lxm-switch-grid">
      <div className="lxm-switch-copy" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <h2>{chapter.title}</h2>
        <p className="lxm-switch-lede">{chapter.lede}</p>
        <ul className="lxm-switch-list">
          {chapter.points.map((item, itemIndex) => <li key={item.title}>
            <button type="button" aria-pressed={itemIndex === index} className={itemIndex === index ? 'is-on' : ''} onClick={() => setIndex(itemIndex)} onMouseEnter={() => setIndex(itemIndex)} onFocus={() => setIndex(itemIndex)}>
              <b>{item.title}</b>
              <span>{item.text}</span>
              {itemIndex === index && !hover && inView ? <i className="lxm-progress is-slow" /> : null}
            </button>
          </li>)}
        </ul>
        <div className="lxm-actions"><SiteLink href={chapter.href} className="lx-btn">{chapter.cta}</SiteLink><SiteLink href={lang === 'en' ? '/en/contact' : '/contact'} className="lx-btn lx-btn-line">{demoLabel}</SiteLink></div>
      </div>
      <div className="lxm-fade" key={point.title}><Panel lang={lang} /></div>
    </div>
  </section>
}

export function CoreGrid({ title, lede, cards }: { title: string; lede: string; cards: Array<{ title: string; text: string; href: string; icon: string }> }) {
  return <section className="lx-core-block">
    <div className="lx-wrap">
      <div className="lx-core-head"><h2>{title}</h2><p>{lede}</p></div>
      <div className="lx-core-grid">{cards.map(card => <SiteLink key={card.title} href={card.href} className="lx-core-card"><CoreIcon name={card.icon} /><b>{card.title}</b><span>{card.text}</span></SiteLink>)}</div>
    </div>
  </section>
}

export function ReasonCards({ title, lede, items }: { title: string; lede: string; items: Array<{ title: string; lines: string[]; num: string; tip: string }> }) {
  return <section className="lx-band"><div className="lx-wrap">
    <div className="lx-core-head"><h2>{title}</h2><p>{lede}</p></div>
    <div className="lx-reasons">{items.map(item => <article key={item.title}><h3>{item.title}</h3>{item.lines.map(line => <p key={line}>{line}</p>)}<strong><CountUp value={item.num} /></strong><small>{item.tip}</small></article>)}</div>
  </div></section>
}
