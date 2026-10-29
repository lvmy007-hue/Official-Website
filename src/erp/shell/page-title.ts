import { useEffect, useSyncExternalStore } from 'react'
import { useRouter } from '@tanstack/react-router'

// 页面给页签报对象名（P6-01）：详情页读到对象后调用 usePageObjectName('商品名')，页签标题就变成“ASIN 360 · 商品名”。
// 以页面路径为键；页面卸载时撤销。没有报名字的详情页，页签退回用编号末 6 位区分。

const names = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

const emit = () => {
  version += 1
  for (const listener of listeners) listener()
}

export function setPageObjectName(path: string, name: string | undefined): void {
  const clean = name?.trim()
  if (clean) {
    if (names.get(path) === clean) return
    names.set(path, clean)
  } else if (!names.delete(path)) return
  emit()
}

export const getPageObjectName = (path: string) => names.get(path)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 订阅对象名的变化（页签条用）：返回一个会随任何对象名变化而变的版本号。 */
export const usePageObjectNameVersion = () => useSyncExternalStore(subscribe, () => version)

/** 详情页调用：对象名读到之前传 undefined。 */
export function usePageObjectName(name: string | undefined): void {
  // 没有路由环境（单独渲染组件做测试）时什么也不做
  const router = useRouter({ warn: false })
  useEffect(() => {
    const pathname = router?.state.location.pathname
    if (!pathname) return
    setPageObjectName(pathname, name)
    return () => setPageObjectName(pathname, undefined)
  }, [router, name])
}
