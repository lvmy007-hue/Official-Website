import { useEffect, useRef, useState } from 'react'

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function splitNumber(value: string) {
  const match = value.match(/^(\D*)([\d,]+(?:\.\d+)?)(.*)$/)
  if (!match) return null
  const [, prefix, digits, suffix] = match
  const decimals = digits.includes('.') ? digits.split('.')[1].length : 0
  return { prefix, suffix, target: Number(digits.replace(/,/g, '')), decimals, grouped: digits.includes(',') }
}

function formatNumber(amount: number, decimals: number, grouped: boolean) {
  return amount.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped })
}

export function CountUp({ value, duration = 1200 }: { value: string; duration?: number }) {
  const parts = splitNumber(value)
  const ref = useRef<HTMLSpanElement>(null)
  const [text, setText] = useState(value)
  const reduced = useReducedMotion()
  useEffect(() => {
    const node = ref.current
    if (!parts || !node || reduced) { setText(value); return }
    let frame = 0
    let started = false
    const run = () => {
      const begin = performance.now()
      const tick = (now: number) => {
        const progress = Math.min(1, (now - begin) / duration)
        const eased = 1 - Math.pow(1 - progress, 3)
        setText(`${parts.prefix}${formatNumber(parts.target * eased, parts.decimals, parts.grouped)}${parts.suffix}`)
        if (progress < 1) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    }
    const rect = node.getBoundingClientRect()
    if (rect.top > window.innerHeight) setText(`${parts.prefix}${formatNumber(0, parts.decimals, parts.grouped)}${parts.suffix}`)
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || started) return
      started = true
      run()
      observer.disconnect()
    }, { threshold: 0.4 })
    observer.observe(node)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [value, reduced])
  return <span ref={ref}>{text}</span>
}

export function useAutoCycle(length: number, interval: number, paused: boolean) {
  const [index, setIndex] = useState(0)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (paused || reduced || length < 2) return
    const timer = window.setInterval(() => setIndex(current => (current + 1) % length), interval)
    return () => window.clearInterval(timer)
  }, [length, interval, paused, reduced])
  return [index, setIndex] as const
}
