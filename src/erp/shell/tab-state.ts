// 多页签的状态与规则（P6-01，15 章第 11 节）：纯函数，不碰界面与存储，便于单测。
// 一个页签对应一个路径（详情页每个对象一个页签）；筛选条件用查询串还原，不缓存整页组件，避免内存膨胀。

/** 页签数量上限：超出时关闭最久没用的（正在打开的那个除外）。 */
export const TABS_MAX = 15

export type TabEntry = {
  /** 路径（不含查询串），页签的唯一键。 */
  path: string
  /** 最近一次的查询串（含开头的 ?，没有为空串），切回页签时用它还原筛选与范围。 */
  search: string
  title: string
  /** 最近一次使用的时间（毫秒），用来决定超限时关闭谁。 */
  usedAt: number
  /** 最近一次的页面滚动位置。 */
  scrollY: number
}

export type OpenInput = { path: string; search: string; title: string; now: number }

/** 打开或激活一个页签：已有就更新查询串、标题与使用时间（保留滚动位置）；没有就追加到末尾，超限时关闭最久未用的。 */
export function openTab(tabs: readonly TabEntry[], input: OpenInput): TabEntry[] {
  const existing = tabs.find(tab => tab.path === input.path)
  if (existing) return tabs.map(tab => (tab.path === input.path ? { ...tab, search: input.search, title: input.title, usedAt: input.now } : tab))
  const next = [...tabs, { path: input.path, search: input.search, title: input.title, usedAt: input.now, scrollY: 0 }]
  const overflow = next.length - TABS_MAX
  if (overflow <= 0) return next
  const victims = new Set(
    next
      .filter(tab => tab.path !== input.path)
      .sort((a, b) => a.usedAt - b.usedAt)
      .slice(0, overflow)
      .map(tab => tab.path),
  )
  return next.filter(tab => !victims.has(tab.path))
}

export function closeTab(tabs: readonly TabEntry[], path: string): TabEntry[] {
  return tabs.filter(tab => tab.path !== path)
}

export function closeOthers(tabs: readonly TabEntry[], path: string): TabEntry[] {
  return tabs.filter(tab => tab.path === path)
}

export function closeRight(tabs: readonly TabEntry[], path: string): TabEntry[] {
  const index = tabs.findIndex(tab => tab.path === path)
  return index < 0 ? [...tabs] : tabs.slice(0, index + 1)
}

/** 关闭当前页签后该去哪：优先右边相邻的，没有就左边相邻的；关完没有页签了返回 null。 */
export function neighborAfterClose(tabs: readonly TabEntry[], path: string): TabEntry | null {
  const index = tabs.findIndex(tab => tab.path === path)
  if (index < 0) return tabs[0] ?? null
  return tabs[index + 1] ?? tabs[index - 1] ?? null
}

export function setScroll(tabs: readonly TabEntry[], path: string, scrollY: number): TabEntry[] {
  return tabs.map(tab => (tab.path === path && tab.scrollY !== scrollY ? { ...tab, scrollY } : tab))
}

// ---- 本机存储 ----

/** 按企业和成员区分；换账号、换企业互不看见。 */
export const tabsStorageKey = (tenantId: string, userId: string) => `nova.erp.tabs.v1:${tenantId}:${userId}`

const MAX_TITLE = 80
const MAX_SEARCH = 1000

/**
 * 从本机存储还原：格式不对、被手工改过的内容都不信任——逐项校验，路径必须是清单里的页面，字符串封顶长度，重复路径只留第一个，最多 TABS_MAX 个。
 * isOpenable 由调用方给：页面已上线且当前成员有权限。
 */
export function parseStoredTabs(raw: string | null, isOpenable: (path: string) => boolean): TabEntry[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const seen = new Set<string>()
  const tabs: TabEntry[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const { path, search, title, usedAt, scrollY } = item as Record<string, unknown>
    if (typeof path !== 'string' || seen.has(path) || !isOpenable(path)) continue
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) continue
    if (typeof search !== 'string' || search.length > MAX_SEARCH || (search !== '' && !search.startsWith('?'))) continue
    seen.add(path)
    tabs.push({
      path,
      search,
      title,
      usedAt: typeof usedAt === 'number' && Number.isFinite(usedAt) ? usedAt : 0,
      scrollY: typeof scrollY === 'number' && Number.isFinite(scrollY) && scrollY >= 0 ? Math.min(scrollY, 1_000_000) : 0,
    })
    if (tabs.length >= TABS_MAX) break
  }
  return tabs
}

export const serializeTabs = (tabs: readonly TabEntry[]) => JSON.stringify(tabs)

// ---- 标题 ----

/** 页签标题：静态页面是路由标题；详情页是“路由标题 · 对象名”，页面没有给对象名时用编号末 6 位区分（井号加编号后 6 位）。 */
export function tabTitle(routeTitle: string, params: Record<string, string>, objectName?: string): string {
  const name = objectName?.trim()
  if (name) return `${routeTitle} · ${name.length > 24 ? `${name.slice(0, 24)}…` : name}`
  const first = Object.values(params)[0]
  return first ? `${routeTitle} · #${first.slice(-6)}` : routeTitle
}
