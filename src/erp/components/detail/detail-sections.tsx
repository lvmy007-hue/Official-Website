import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Card, Skeleton } from 'antd'

// 整页详情的锚点长页（P6-05，15 章 5.3）：
// - 吸顶导航用 IntersectionObserver 高亮当前板块（useSectionSpy），点导航滚动到对应板块；
// - 板块按需加载：进入视口前 200px 才挂载内容（取数在那时才发生），挂载后不再销毁；
// - 板块离开视口后“暂停轮询”：内容里用 useSectionVisible() 取是否在视口附近，轮询间隔写成 visible ? 毫秒 : false。
// 没有 IntersectionObserver 的环境（老浏览器、测试）：全部板块直接加载并视为可见。

export type DetailSection = {
  key: string
  label: string
  children: ReactNode
  /** 卡片头右侧的局部切换（例如“按日 / 按周”）。 */
  extra?: ReactNode
}

/** 板块进入视口前提前加载的距离（像素）。 */
export const SECTION_PRELOAD_PX = 200
/** 吸顶区高度（吸顶导航加收缩后的头部），滚动定位与高亮判断都要避开它。 */
export const STICKY_OFFSET_PX = 96

export const sectionDomId = (key: string) => `erp-section-${key}`

const hasObserver = () => typeof IntersectionObserver !== 'undefined'

/** 纯函数：当前高亮的板块 = 按顺序第一个可见的；都不可见时保持上一个。 */
export function pickActiveSection(order: readonly string[], visible: ReadonlySet<string>, previous: string | null): string | null {
  for (const key of order) if (visible.has(key)) return key
  return previous && order.includes(previous) ? previous : (order[0] ?? null)
}

const SectionVisibleContext = createContext(true)

/** 板块内容用：当前是否在视口附近（预加载距离内）。离开后应暂停轮询，回来再恢复。 */
export const useSectionVisible = () => useContext(SectionVisibleContext)

/** 导航高亮：观察每个板块，视口上沿下方一段区域里第一个板块为当前。 */
export function useSectionSpy(keys: readonly string[]) {
  const [active, setActive] = useState<string | null>(keys[0] ?? null)
  const visible = useRef(new Set<string>())
  const lockUntil = useRef(0)
  const order = useMemo(() => [...keys], [keys])
  const joined = order.join('|')

  useEffect(() => {
    if (!hasObserver() || order.length === 0) return undefined
    const seen = visible.current
    seen.clear()
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.sectionKey
          if (!key) continue
          if (entry.isIntersecting) seen.add(key)
          else seen.delete(key)
        }
        if (Date.now() < lockUntil.current) return
        setActive(prev => pickActiveSection(order, seen, prev))
      },
      // 上沿让出吸顶区，下沿只看视口上半部分，这样“靠近上方的那个板块”才是当前板块
      { rootMargin: `-${STICKY_OFFSET_PX}px 0px -55% 0px` },
    )
    for (const key of order) {
      const element = document.getElementById(sectionDomId(key))
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
    // order 由 joined 稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined])

  /** 点导航：先把高亮定到点的板块，滚动期间不让观察结果把它改回去。 */
  const jump = useCallback((key: string) => {
    lockUntil.current = Date.now() + 800
    setActive(key)
    document.getElementById(sectionDomId(key))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return { active, jump }
}

function SectionCard({ section }: { section: DetailSection }) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(!hasObserver())
  const [loaded, setLoaded] = useState(!hasObserver())
  useEffect(() => {
    const element = ref.current
    if (!element || !hasObserver()) return undefined
    const observer = new IntersectionObserver(
      entries => {
        const hit = entries.some(entry => entry.isIntersecting)
        setNear(hit)
        if (hit) setLoaded(true)
      },
      { rootMargin: `${SECTION_PRELOAD_PX}px 0px` },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={ref} id={sectionDomId(section.key)} data-section-key={section.key} className="erp-detail-section">
      <Card size="small" title={section.label} extra={section.extra} data-testid={`section-${section.key}`}>
        {loaded ? (
          <SectionVisibleContext.Provider value={near}>{section.children}</SectionVisibleContext.Provider>
        ) : (
          <div data-testid={`section-placeholder-${section.key}`} style={{ minHeight: 160 }}>
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
        )}
      </Card>
    </div>
  )
}

export function SectionList({ sections }: { sections: readonly DetailSection[] }) {
  return (
    <div className="erp-detail-sections">
      {sections.map(section => (
        <SectionCard key={section.key} section={section} />
      ))}
    </div>
  )
}
