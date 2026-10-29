import { useSyncExternalStore } from 'react'
import { DEFAULT_DENSITY, isDensity, type Density } from '@nova/api-contracts'

// 界面密度（P6-01）：紧凑（表格行高 36）或标准（40）。
// 服务端的个人偏好是准的（换设备也在）；本机缓存只用来第一次绘制就用对密度，避免页面先按标准画一遍再跳变。
// 主题（Ant Design 与 AG Grid）订阅这个小仓库，切换后两套主题同时响应。

const CACHE_KEY = 'nova.erp.density'

function readCache(): Density {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(CACHE_KEY)
    return isDensity(value) ? value : DEFAULT_DENSITY
  } catch {
    return DEFAULT_DENSITY
  }
}

let current: Density = readCache()
const listeners = new Set<() => void>()

export const getDensity = (): Density => current

export function setDensity(next: Density): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(CACHE_KEY, next)
  } catch {
    // 本机存储不可用（隐私模式等）：只在内存里生效
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useDensity = (): Density => useSyncExternalStore(subscribe, getDensity, () => DEFAULT_DENSITY)
