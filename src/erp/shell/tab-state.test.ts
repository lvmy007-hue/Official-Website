import { describe, expect, it } from 'vitest'
import { TABS_MAX, closeOthers, closeRight, closeTab, neighborAfterClose, openTab, parseStoredTabs, serializeTabs, setScroll, tabTitle, tabsStorageKey, type TabEntry } from './tab-state'

// 多页签规则（P6-01）：上限与最久未用淘汰、关闭系列、本机存储的还原与防篡改、标题。

const tab = (path: string, usedAt = 0, patch: Partial<TabEntry> = {}): TabEntry => ({ path, search: '', title: path.slice(5), usedAt, scrollY: 0, ...patch })
const paths = (tabs: readonly TabEntry[]) => tabs.map(item => item.path)

describe('打开页签', () => {
  it('新路径追加到末尾；已有路径只更新查询串、标题与时间，保留滚动位置，不重复', () => {
    const first = openTab([], { path: '/app/orders', search: '', title: '订单', now: 1 })
    const scrolled = setScroll(first, '/app/orders', 300)
    const again = openTab(scrolled, { path: '/app/orders', search: '?status=SHIPPED', title: '订单', now: 5 })
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ search: '?status=SHIPPED', usedAt: 5, scrollY: 300 })
  })

  it('超过 15 个：关闭最久没用的，正在打开的那个绝不被关', () => {
    let tabs: TabEntry[] = []
    for (let index = 0; index < TABS_MAX; index += 1) tabs = openTab(tabs, { path: `/app/p${index}`, search: '', title: `页${index}`, now: 100 + index })
    // 把 p0 重新用一遍，最久没用的变成 p1
    tabs = openTab(tabs, { path: '/app/p0', search: '', title: '页0', now: 500 })
    tabs = openTab(tabs, { path: '/app/new', search: '', title: '新页', now: 600 })
    expect(tabs).toHaveLength(TABS_MAX)
    expect(paths(tabs)).toContain('/app/new')
    expect(paths(tabs)).toContain('/app/p0')
    expect(paths(tabs)).not.toContain('/app/p1')
  })

  it('时间相同也只关一个，新开的不被淘汰', () => {
    let tabs: TabEntry[] = Array.from({ length: TABS_MAX }, (_, index) => tab(`/app/p${index}`, 1))
    tabs = openTab(tabs, { path: '/app/new', search: '', title: '新页', now: 1 })
    expect(tabs).toHaveLength(TABS_MAX)
    expect(paths(tabs)).toContain('/app/new')
  })
})

describe('关闭系列', () => {
  const tabs = [tab('/app/a'), tab('/app/b'), tab('/app/c'), tab('/app/d')]
  it('关闭、关闭其他、关闭右侧', () => {
    expect(paths(closeTab(tabs, '/app/b'))).toEqual(['/app/a', '/app/c', '/app/d'])
    expect(paths(closeOthers(tabs, '/app/c'))).toEqual(['/app/c'])
    expect(paths(closeRight(tabs, '/app/b'))).toEqual(['/app/a', '/app/b'])
    expect(paths(closeRight(tabs, '/app/d'))).toEqual(paths(tabs))
  })
  it('不存在的路径：关闭其他得到空，关闭右侧保持原样，不抛错', () => {
    expect(closeOthers(tabs, '/app/zzz')).toEqual([])
    expect(paths(closeRight(tabs, '/app/zzz'))).toEqual(paths(tabs))
  })
  it('关闭当前后去右边相邻的，没有就去左边；只剩自己返回 null', () => {
    expect(neighborAfterClose(tabs, '/app/b')?.path).toBe('/app/c')
    expect(neighborAfterClose(tabs, '/app/d')?.path).toBe('/app/c')
    expect(neighborAfterClose([tab('/app/a')], '/app/a')).toBeNull()
  })
})

describe('本机存储', () => {
  const all = () => true
  it('按企业和成员分开存', () => {
    expect(tabsStorageKey('t1', 'u1')).not.toBe(tabsStorageKey('t1', 'u2'))
    expect(tabsStorageKey('t1', 'u1')).not.toBe(tabsStorageKey('t2', 'u1'))
  })
  it('存进去再读出来一致', () => {
    const tabs = [tab('/app/a', 3, { search: '?x=1', scrollY: 40 }), tab('/app/b', 4)]
    expect(parseStoredTabs(serializeTabs(tabs), all)).toEqual(tabs)
  })
  it('没有、不是 JSON、不是数组：得到空，不抛错', () => {
    expect(parseStoredTabs(null, all)).toEqual([])
    expect(parseStoredTabs('{坏的', all)).toEqual([])
    expect(parseStoredTabs('{"path":"/app/a"}', all)).toEqual([])
  })
  it('被手工改过的项逐项丢弃：不在清单或无权限的页面、重复、标题或查询串不合规、超长', () => {
    const raw = JSON.stringify([
      { path: '/app/ok', search: '?a=1', title: '正常', usedAt: 1, scrollY: 0 },
      { path: '/app/ok', search: '', title: '重复', usedAt: 1, scrollY: 0 },
      { path: '/app/forbidden', search: '', title: '无权限', usedAt: 1, scrollY: 0 },
      { path: '/app/ok2', search: 'a=1', title: '查询串缺问号', usedAt: 1, scrollY: 0 },
      { path: '/app/ok3', search: '', title: '', usedAt: 1, scrollY: 0 },
      { path: '/app/ok4', search: '', title: 'x'.repeat(81), usedAt: 1, scrollY: 0 },
      { path: '/app/ok5', search: `?${'q'.repeat(1001)}`, title: '查询串过长', usedAt: 1, scrollY: 0 },
      { path: 5, search: '', title: '路径不是字符串', usedAt: 1, scrollY: 0 },
      null,
      'text',
      { path: '/app/ok6', search: '', title: '数字非法', usedAt: 'x', scrollY: -9 },
    ])
    const result = parseStoredTabs(raw, path => path !== '/app/forbidden')
    expect(paths(result)).toEqual(['/app/ok', '/app/ok6'])
    expect(result[1]).toMatchObject({ usedAt: 0, scrollY: 0 })
  })
  it('超过 15 个只取前 15 个', () => {
    const many = Array.from({ length: 40 }, (_, index) => tab(`/app/p${index}`))
    expect(parseStoredTabs(serializeTabs(many), all)).toHaveLength(TABS_MAX)
  })
})

describe('标题', () => {
  it('静态页面用路由标题；详情页优先用对象名（超长截断），没有对象名用编号末 6 位', () => {
    expect(tabTitle('订单', {})).toBe('订单')
    expect(tabTitle('库存详情', { id: 'abcdef123456' }, '  某某商品  ')).toBe('库存详情 · 某某商品')
    expect(tabTitle('库存详情', { id: 'abcdef123456' }, 'n'.repeat(40))).toBe(`库存详情 · ${'n'.repeat(24)}…`)
    expect(tabTitle('库存详情', { id: 'abcdef123456' })).toBe('库存详情 · #123456')
    expect(tabTitle('库存详情', { id: 'abcdef123456' }, '   ')).toBe('库存详情 · #123456')
  })
})
