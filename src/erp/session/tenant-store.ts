// 当前企业编号（仅内存）。查询缓存的键里带上它，即使清缓存之前有请求返回，
// 也不会把上一个企业的数据写进新企业的缓存位置（P1-06）。

let activeTenantId: string | null = null
const listeners = new Set<() => void>()

export const getActiveTenantId = () => activeTenantId

/** 设置当前企业；返回“是否发生了变化”（首次设置不算切换）。 */
export function setActiveTenantId(id: string | null): { changed: boolean; previous: string | null } {
  const previous = activeTenantId
  if (previous === id) return { changed: false, previous }
  activeTenantId = id
  for (const listener of listeners) listener()
  return { changed: previous !== null && id !== null, previous }
}

export function subscribeActiveTenant(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
