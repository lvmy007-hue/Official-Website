import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithApp } from '../../test/render'
import { DetailDrawer } from './DetailDrawer'
import { DetailLayout, type IdentityMetric } from './DetailLayout'
import { DrillModal, useDrill, type DrillLevel } from './DrillModal'
import { buildDetailFilter, useDetailFilter } from './detail-filter'
import { useSectionVisible } from './detail-sections'

// 详情形态（P6-05）：整页详情的锚点高亮、板块按需加载与暂停、共享筛选触发各板块重新取数、头部信息卡收缩；抽屉；下钻弹窗。
// jsdom 没有 IntersectionObserver：用替身记录观察对象，由测试决定“进入 / 离开视口”。

type Entry = { target: Element; isIntersecting: boolean; boundingClientRect: { top: number } }
class FakeObserver {
  static all = new Set<FakeObserver>()
  private readonly targets = new Set<Element>()
  constructor(
    private readonly callback: (entries: Entry[]) => void,
    readonly options?: { rootMargin?: string },
  ) {
    FakeObserver.all.add(this)
  }
  observe(element: Element) {
    this.targets.add(element)
  }
  unobserve(element: Element) {
    this.targets.delete(element)
  }
  disconnect() {
    this.targets.clear()
    FakeObserver.all.delete(this)
  }
  takeRecords() {
    return []
  }
  /** 让所有正在观察该元素的观察者收到一次变化。 */
  static fire(element: Element, isIntersecting: boolean, top = 0) {
    act(() => {
      for (const observer of FakeObserver.all) if (observer.targets.has(element)) observer.callback([{ target: element, isIntersecting, boundingClientRect: { top } }])
    })
  }
}

beforeEach(() => {
  FakeObserver.all.clear()
  vi.stubGlobal('IntersectionObserver', FakeObserver)
})
afterEach(() => vi.unstubAllGlobals())

const metrics: IdentityMetric[] = [1, 2, 3, 4, 5].map(index => ({ label: `指标${index}`, value: `值${index}` }))
const section = (key: string) => document.getElementById(`erp-section-${key}`) as HTMLElement

/** 一个板块：每次共享筛选变化就记一次“取数”；记下是否在视口附近。 */
function Board({ name, onFetch, onVisible }: { name: string; onFetch: (name: string, signature: string) => void; onVisible?: (visible: boolean) => void }) {
  const filter = useDetailFilter()
  const visible = useSectionVisible()
  useEffect(() => {
    onFetch(name, filter.signature)
  }, [name, filter.signature, onFetch])
  useEffect(() => {
    onVisible?.(visible)
  }, [visible, onVisible])
  return <div>{`板块内容 ${name}`}</div>
}

describe('整页详情：锚点模式', () => {
  const noop = () => undefined
  const sections = (onFetch: (name: string, signature: string) => void = noop, onVisible?: (visible: boolean) => void) =>
    ['overview', 'trend', 'ads'].map(key => ({ key, label: `板块 ${key}`, children: <Board name={key} onFetch={onFetch} onVisible={onVisible} /> }))

  it('导航与板块一一对应；点导航滚到对应板块并立刻高亮', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sections={sections()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['板块 overview', '板块 trend', '板块 ads'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(screen.getByRole('tab', { name: '板块 ads' }))
    expect(screen.getByRole('tab', { name: '板块 ads' })).toHaveAttribute('aria-selected', 'true')
    expect(scroll).toHaveBeenCalled()
    Element.prototype.scrollIntoView = () => undefined
  })

  it('滚动时按第一个进入观察区的板块高亮，离开后回到上一个可见的', () => {
    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sections={sections()} />)
    FakeObserver.fire(section('trend'), true)
    expect(screen.getByRole('tab', { name: '板块 trend' })).toHaveAttribute('aria-selected', 'true')
    FakeObserver.fire(section('ads'), true)
    // 两个都可见时取排在前面的
    expect(screen.getByRole('tab', { name: '板块 trend' })).toHaveAttribute('aria-selected', 'true')
    FakeObserver.fire(section('trend'), false)
    expect(screen.getByRole('tab', { name: '板块 ads' })).toHaveAttribute('aria-selected', 'true')
  })

  it('板块按需加载：进入视口前才挂载内容，挂载后不销毁；离开后暂停（visible 为 false），回来恢复', () => {
    const fetched: string[] = []
    const seen: boolean[] = []
    renderWithApp(
      <DetailLayout
        title="商品 A"
        metrics={metrics}
        sections={sections(
          name => fetched.push(name),
          visible => seen.push(visible),
        )}
      />,
    )
    expect(fetched).toEqual([])
    expect(screen.getByTestId('section-placeholder-trend')).toBeInTheDocument()
    expect(screen.queryByText('板块内容 trend')).not.toBeInTheDocument()

    FakeObserver.fire(section('trend'), true)
    expect(fetched).toEqual(['trend'])
    expect(screen.getByText('板块内容 trend')).toBeInTheDocument()
    expect(seen).toEqual([true])

    FakeObserver.fire(section('trend'), false)
    expect(screen.getByText('板块内容 trend')).toBeInTheDocument()
    expect(seen).toEqual([true, false])
    FakeObserver.fire(section('trend'), true)
    expect(seen).toEqual([true, false, true])
    // 其他板块一直没进入视口，从没取过数
    expect(fetched).toEqual(['trend'])
  })

  it('预加载距离是 200px', () => {
    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sections={sections()} />)
    const margins = Array.from(FakeObserver.all).map(observer => observer.options?.rootMargin)
    expect(margins).toContain('200px 0px')
  })

  it('没有 IntersectionObserver 的环境：板块直接加载', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('IntersectionObserver', undefined)
    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sections={sections()} />)
    expect(screen.getByText('板块内容 ads')).toBeInTheDocument()
  })

  it('板块卡片头右侧可放局部切换', () => {
    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sections={[{ key: 'trend', label: '趋势', extra: <button>按周</button>, children: <div>图</div> }]} />)
    expect(within(screen.getByTestId('section-trend')).getByRole('button', { name: '按周' })).toBeInTheDocument()
  })
})

describe('整页详情：共享筛选', () => {
  it('共享筛选值由纯函数算出：近 30 天、环比与同比区间、自定义取手选值', () => {
    const range = { from: '2026-10-01', to: '2026-10-07' }
    expect(buildDetailFilter(null, 'previous', null).params).toEqual({})
    expect(buildDetailFilter(range, 'none', null).params).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(buildDetailFilter(range, 'previous', null).params).toEqual({ from: '2026-10-01', to: '2026-10-07', compare: 'previous', compareFrom: '2026-09-24', compareTo: '2026-09-30' })
    expect(buildDetailFilter(range, 'yoy', null).params).toMatchObject({ compare: 'yoy', compareFrom: '2025-10-01', compareTo: '2025-10-07' })
    expect(buildDetailFilter(range, 'custom', { from: '2026-08-01', to: '2026-08-07' }).params).toMatchObject({ compare: 'custom', compareFrom: '2026-08-01', compareTo: '2026-08-07' })
    expect(buildDetailFilter(range, 'custom', null).params).toEqual({ from: '2026-10-01', to: '2026-10-07' })
  })

  it('默认不带共享筛选；开启后在吸顶导航同一行出现，各板块拿到同一份值，变化后各板块都重新取数', async () => {
    const fetched: Array<[string, string]> = []
    const onFetch = (name: string, signature: string) => fetched.push([name, signature])
    const boards = ['a', 'b'].map(key => ({ key, label: `板块 ${key}`, children: <Board name={key} onFetch={onFetch} /> }))
    const { unmount } = renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sections={boards} />)
    expect(screen.queryByRole('group', { name: '共享筛选' })).not.toBeInTheDocument()
    unmount()

    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} sharedFilter sections={boards} />)
    const filter = screen.getByRole('group', { name: '共享筛选' })
    expect(filter.closest('.erp-detail-sticky')).not.toBeNull()
    FakeObserver.fire(section('a'), true)
    FakeObserver.fire(section('b'), true)
    const first = fetched.filter(([name]) => name === 'a')
    expect(first).toHaveLength(1)
    expect(JSON.parse(first[0]![1])).toHaveProperty('from')
    expect(fetched.filter(([name]) => name === 'b')[0]![1]).toBe(first[0]![1])

    await userEvent.click(within(filter).getByRole('combobox', { name: '对比期' }))
    await userEvent.click(await screen.findByText('上一期'))
    const next = fetched.filter(([name]) => name === 'a')
    expect(next).toHaveLength(2)
    expect(JSON.parse(next[1]![1])).toMatchObject({ compare: 'previous' })
    const nextB = fetched.filter(([name]) => name === 'b')
    expect(nextB).toHaveLength(2)
    expect(nextB[1]![1]).toBe(next[1]![1])
  })

  it('页签模式也可以带共享筛选，筛选放在页签条右侧', () => {
    renderWithApp(<DetailLayout title="订单" metrics={metrics} sharedFilter tabs={[{ key: 'a', label: '概览', children: <div>概览内容</div> }]} />)
    expect(screen.getByRole('group', { name: '共享筛选' })).toBeInTheDocument()
    expect(screen.getByText('概览内容')).toBeInTheDocument()
  })
})

describe('整页详情：头部信息卡', () => {
  it('编码字段组一行排开；关键指标最多 6 项', () => {
    renderWithApp(
      <DetailLayout
        title="商品 A"
        codes={[
          { label: 'SKU', value: 'SKU-1' },
          { label: 'ASIN', value: 'B0001' },
        ]}
        metrics={[...metrics, { label: '指标6', value: '值6' }, { label: '指标7', value: '值7' }]}
        tabs={[]}
      />,
    )
    const codes = screen.getByLabelText('编码')
    expect(within(codes).getByText('SKU')).toBeInTheDocument()
    expect(within(codes).getByText('B0001')).toBeInTheDocument()
    expect(screen.queryByText('指标7')).not.toBeInTheDocument()
    expect(screen.getByText('指标6')).toBeInTheDocument()
  })

  it('滚出视口后收缩成一行吸顶（标题、状态、前三项指标、主操作），滚回后恢复', () => {
    renderWithApp(<DetailLayout title="商品 A" statuses={[{ text: '在售' }]} metrics={metrics} primaryActions={<button>去处理</button>} tabs={[{ key: 'a', label: '概览', children: <div>x</div> }]} />)
    expect(screen.queryByTestId('identity-compact')).not.toBeInTheDocument()
    const sentinel = screen.getByTestId('identity-sentinel')
    FakeObserver.fire(sentinel, false, -30)
    const bar = screen.getByTestId('identity-compact')
    expect(within(bar).getByText('商品 A')).toBeInTheDocument()
    expect(within(bar).getByText('在售')).toBeInTheDocument()
    expect(within(bar).getByText('指标3')).toBeInTheDocument()
    expect(within(bar).queryByText('指标4')).not.toBeInTheDocument()
    expect(within(bar).getByRole('button', { name: '去处理' })).toBeInTheDocument()
    expect(screen.getByTestId('detail-layout')).toHaveAttribute('data-collapsed', 'true')
    FakeObserver.fire(sentinel, true, 20)
    expect(screen.queryByTestId('identity-compact')).not.toBeInTheDocument()
  })

  it('哨兵在视口下方（还没滚到）不算收缩', () => {
    renderWithApp(<DetailLayout title="商品 A" metrics={metrics} tabs={[]} />)
    const sentinel = screen.getByTestId('identity-sentinel')
    FakeObserver.fire(sentinel, false, 900)
    expect(screen.queryByTestId('identity-compact')).not.toBeInTheDocument()
  })
})

describe('抽屉详情', () => {
  const tabs = [
    { key: 'one', label: '概览', children: <div>概览内容</div> },
    { key: 'two', label: '流水', children: <div>流水内容</div> },
  ]

  it('默认 720 宽，可选 960；顶部是对象标识、状态和主操作；有“在新页签打开完整详情”', () => {
    const { unmount } = renderWithApp(
      <DetailDrawer
        open
        onClose={() => undefined}
        title="SKU-1"
        subtitle="B0001"
        statuses={[{ text: '低库存', color: 'warning' }]}
        actions={<button>补货</button>}
        fullPath="/app/inventory/i1"
        tabs={tabs}
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('SKU-1')).toBeInTheDocument()
    expect(within(dialog).getByText('低库存')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '补货' })).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: '在新页签打开完整详情' })).toHaveAttribute('href', '/app/inventory/i1')
    expect(document.querySelector('.ant-drawer-content-wrapper')).toHaveStyle({ width: '720px' })
    unmount()
    renderWithApp(<DetailDrawer open onClose={() => undefined} width={960} title="SKU-1" tabs={tabs} />)
    expect(document.querySelector('.ant-drawer-content-wrapper')).toHaveStyle({ width: '960px' })
  })

  it('页签内容只在打开后才挂载；点“打开完整详情”会关闭抽屉；没有完整详情路径时不显示该入口', async () => {
    const onClose = vi.fn()
    const { rerender } = renderWithApp(<DetailDrawer open onClose={onClose} title="SKU-1" fullPath="/app/inventory/i1" tabs={tabs} />)
    expect(screen.getByText('概览内容')).toBeInTheDocument()
    expect(screen.queryByText('流水内容')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '流水' }))
    expect(await screen.findByText('流水内容')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: '在新页签打开完整详情' }))
    expect(onClose).toHaveBeenCalled()
    rerender(<DetailDrawer open onClose={onClose} title="SKU-1" tabs={tabs} />)
    expect(screen.queryByRole('link', { name: '在新页签打开完整详情' })).not.toBeInTheDocument()
  })

  it('取数中或失败时，状态顶替页签区；摘要显示在页签上方', () => {
    renderWithApp(<DetailDrawer open onClose={() => undefined} title="SKU-1" summary={<div>摘要指标</div>} status={<div>读取中</div>} tabs={tabs} />)
    expect(screen.getByText('读取中')).toBeInTheDocument()
    expect(screen.getByText('摘要指标')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })
})

describe('弹窗下钻', () => {
  function Child({ next, label }: { next?: DrillLevel; label: string }) {
    const drill = useDrill()
    return (
      <div>
        <span>{`内容：${label}`}</span>
        {next ? <button onClick={() => drill?.push(next)}>{`下钻到${next.title}`}</button> : null}
        <span>{`深度 ${drill?.depth}`}</span>
      </div>
    )
  }
  const target: DrillLevel = { key: 'target', title: '投放 C', render: () => <Child label="投放 C" /> }
  const group: DrillLevel = { key: 'group', title: '广告组 B', render: () => <Child label="广告组 B" next={target} /> }
  const root: DrillLevel = { key: 'campaign', title: '广告活动 A', render: () => <Child label="广告活动 A" next={group} /> }

  it('90% 屏宽；连续下钻，面包屑显示整条链，可以回到任意一层，也能后退与前进', async () => {
    renderWithApp(<DrillModal open onClose={() => undefined} root={root} heading="广告" />)
    const dialog = screen.getByRole('dialog')
    expect(document.querySelector('.ant-modal')).toHaveStyle({ width: `${window.innerWidth * 0.9}px` })
    expect(within(dialog).getByText('内容：广告活动 A')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '后退一层' })).toBeDisabled()

    await userEvent.click(within(dialog).getByRole('button', { name: '下钻到广告组 B' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '下钻到投放 C' }))
    expect(within(dialog).getByText('内容：投放 C')).toBeInTheDocument()
    expect(within(dialog).getByText('深度 3')).toBeInTheDocument()
    const crumbs = within(dialog).getByRole('navigation')
    expect(within(crumbs).getByRole('button', { name: '广告活动 A' })).toBeInTheDocument()
    expect(within(crumbs).getByRole('button', { name: '广告组 B' })).toBeInTheDocument()
    expect(crumbs.querySelector('[aria-current="page"]')).toHaveTextContent('投放 C')

    await userEvent.click(within(dialog).getByRole('button', { name: '后退一层' }))
    expect(within(dialog).getByText('内容：广告组 B')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '前进一层' }))
    expect(within(dialog).getByText('内容：投放 C')).toBeInTheDocument()

    await userEvent.click(within(crumbs).getByRole('button', { name: '广告活动 A' }))
    expect(within(dialog).getByText('内容：广告活动 A')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '前进一层' })).toBeEnabled()
  })

  it('关闭时整条链一起关闭；再次打开从根层开始', async () => {
    const onClose = vi.fn()
    const { rerender } = renderWithApp(<DrillModal open onClose={onClose} root={root} />)
    await userEvent.click(screen.getByRole('button', { name: '下钻到广告组 B' }))
    expect(screen.getByText('内容：广告组 B')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /关\s?闭|close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
    rerender(<DrillModal open={false} onClose={onClose} root={root} />)
    rerender(<DrillModal open onClose={onClose} root={root} />)
    expect(await screen.findByText('内容：广告活动 A')).toBeInTheDocument()
    expect(screen.queryByText('内容：广告组 B')).not.toBeInTheDocument()
  })

  it('不在弹窗里使用时 useDrill 返回 null（内容可当整页渲染）', () => {
    renderWithApp(<Child label="单独" />)
    expect(screen.getByText('深度 undefined')).toBeInTheDocument()
  })
})
