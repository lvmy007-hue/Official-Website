import type { ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

const EASE = [0.22, 0.61, 0.36, 1] as const

// 用 callback ref + IntersectionObserver 自管可见性：元素一挂载就开始观察，
// 首屏可见的会在初始回调里立即触发，避免客户端路由切换时 whileInView 错过
// 触发窗口、内容卡在 opacity:0 需要刷新才显示的问题。
function useInView() {
  const [inView, setInView] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    cleanup.current?.()
    cleanup.current = null
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    io.observe(el)
    cleanup.current = () => io.disconnect()
  }, [])
  return { ref, inView }
}

export function Reveal({
  children, className, delay = 0, y = 28, as = 'div',
}: { children: ReactNode; className?: string; delay?: number; y?: number; as?: 'div' | 'section' | 'li' | 'article' }) {
  const reduce = useReducedMotion()
  const { ref, inView } = useInView()
  const Tag = motion[as]
  if (reduce) {
    const Plain = as
    return <Plain className={className}>{children}</Plain>
  }
  return (
    <Tag
      ref={ref}
      className={className}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      transition={{ duration: 0.6, delay, ease: EASE }}
    >
      {children}
    </Tag>
  )
}

export function Stagger({ children, className, gap = 0.08 }: { children: ReactNode; className?: string; gap?: number }) {
  const reduce = useReducedMotion()
  const { ref, inView } = useInView()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={inView ? 'show' : 'hidden'}
      variants={{ hidden: {}, show: { transition: { staggerChildren: gap } } }}
    >
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children, className, y = 24 }: { children: ReactNode; className?: string; y?: number }) {
  const reduce = useReducedMotion()
  if (reduce) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      variants={{ hidden: { opacity: 0, y }, show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } } }}
    >
      {children}
    </motion.div>
  )
}
