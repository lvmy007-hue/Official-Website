// 列显示配置的本机部分（P6-02 起）：按表格标识记在本机，隐藏哪些列。
// P6-03 起，打开了服务端视图的表格（use-grid-views）不再写本机：第一次加载时把这里的旧记录迁成“我的”视图并删掉本机副本；
// 没打开服务端视图的表格（以及内部访问、支持访问这类没有个人账号的会话）仍然用这里。
// 防御：本机数据可能被改坏，只取字符串、限长、限个数；至少保留一列可见，不能把表格隐藏成空表头。

const MAX_HIDDEN = 200
const MAX_ID_LENGTH = 100

export const hiddenStorageKey = (gridId: string) => `erp.grid.${gridId}.hidden-columns`

export function loadHidden(gridId: string): string[] {
  try {
    const raw = window.localStorage.getItem(hiddenStorageKey(gridId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length <= MAX_ID_LENGTH))].slice(0, MAX_HIDDEN)
  } catch {
    return []
  }
}

export function saveHidden(gridId: string, hidden: string[]) {
  try {
    window.localStorage.setItem(hiddenStorageKey(gridId), JSON.stringify(hidden))
  } catch {
    // 本机存储不可用时，列配置只在当前页面有效
  }
}

/** 本机是否还留着旧的列配置（服务端视图开启的表格第一次加载时把它迁成“我的”视图）。 */
export const hasLegacyHidden = (gridId: string): boolean => {
  try {
    return window.localStorage.getItem(hiddenStorageKey(gridId)) !== null
  } catch {
    return false
  }
}

/** 迁到服务端之后删掉本机副本。 */
export function clearLegacyHidden(gridId: string) {
  try {
    window.localStorage.removeItem(hiddenStorageKey(gridId))
  } catch {
    // 本机存储不可用：没有副本可删
  }
}

/** 改变一批列的显示；返回新的隐藏列表。要隐藏到一列都不剩时拒绝（原样返回）。 */
export function applyVisibility(hidden: readonly string[], allIds: readonly string[], ids: readonly string[], visible: boolean): string[] {
  const next = visible ? hidden.filter(item => !ids.includes(item)) : [...new Set([...hidden, ...ids])]
  const remaining = allIds.filter(id => !next.includes(id))
  return remaining.length === 0 ? [...hidden] : next
}
