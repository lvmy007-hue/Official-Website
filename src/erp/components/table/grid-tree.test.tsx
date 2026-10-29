import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithApp } from '../../test/render'
import { numberColumn, textColumn } from './columns'
import { TREE_CHILD_LIMIT, TREE_MAX_DEPTH, flattenTree, type ChildState, type TreeOptions } from './grid-tree'
import { PagedGrid } from './PagedGrid'
import type { PageFetcher } from './grid-types'

// 行内展开（P6-02）：AG Grid 社区版没有树形数据，改为把父子行摊平；懒加载、失败重试、深度与子行上限、重复行忽略。

type Node = { id: string; name: string; kids?: Node[]; units: number }
const node = (id: string, kids?: Node[]): Node => ({ id, name: `行${id}`, units: 1, kids })
const options: TreeOptions<Node> = { hasChildren: row => row.kids !== undefined, getChildren: row => row.kids }
const empty: ReadonlySet<string> = new Set()
const none: ReadonlyMap<string, ChildState<Node>> = new Map()

describe('flattenTree', () => {
  it('收起时只有根行；展开后子行紧跟在父行后面，带深度与父行编号', () => {
    const roots = [node('a', [node('a1'), node('a2', [node('a21')])]), node('b')]
    expect(flattenTree(roots, row => row.id, options, empty, none).rows.map(row => row.id)).toEqual(['a', 'b'])
    const open = flattenTree(roots, row => row.id, options, new Set(['a', 'a2']), none)
    expect(open.rows.map(row => [row.id, row.__depth, row.__parent])).toEqual([
      ['a', 0, null],
      ['a1', 1, 'a'],
      ['a2', 1, 'a'],
      ['a21', 2, 'a2'],
      ['b', 0, null],
    ])
    expect(open.rows[0]).toMatchObject({ __hasChildren: true, __treeState: 'expanded' })
    expect(open.rows[1]).toMatchObject({ __hasChildren: false, __treeState: 'collapsed' })
  })

  it('同一个行编号只出现一次（重复的子行被忽略），避免表格行编号冲突', () => {
    const roots = [node('a', [node('x'), node('x')]), node('x')]
    const flat = flattenTree(roots, row => row.id, options, new Set(['a']), none)
    expect(flat.rows.map(row => row.id)).toEqual(['a', 'x'])
  })

  it(`最多 ${TREE_MAX_DEPTH} 层：更深的行不再能展开`, () => {
    let deepest = node('d' + TREE_MAX_DEPTH, [node('too-deep')])
    for (let level = TREE_MAX_DEPTH - 1; level >= 0; level -= 1) deepest = node('d' + level, [deepest])
    const all = new Set(Array.from({ length: TREE_MAX_DEPTH + 2 }, (_, i) => 'd' + i))
    const flat = flattenTree([deepest], row => row.id, options, all, none)
    expect(flat.rows).toHaveLength(TREE_MAX_DEPTH + 1)
    expect(flat.rows[flat.rows.length - 1]).toMatchObject({ id: 'd' + TREE_MAX_DEPTH, __hasChildren: false })
  })

  it(`每个父行最多 ${TREE_CHILD_LIMIT} 个子行，超出的计入“被截断的父行数”而不是悄悄丢掉`, () => {
    const kids = Array.from({ length: TREE_CHILD_LIMIT + 5 }, (_, i) => node(`k${i}`))
    const flat = flattenTree([node('p', kids)], row => row.id, options, new Set(['p']), none)
    expect(flat.rows).toHaveLength(TREE_CHILD_LIMIT + 1)
    expect(flat.truncatedParents).toBe(1)
  })

  it('展开了但子行还没取回：显示加载中；取失败：显示失败；取回：显示子行', () => {
    const lazy: TreeOptions<Node> = { hasChildren: () => true }
    const roots = [node('p')]
    const open = new Set(['p'])
    expect(flattenTree(roots, row => row.id, lazy, open, none).rows[0]!.__treeState).toBe('loading')
    expect(flattenTree(roots, row => row.id, lazy, open, new Map([['p', { status: 'loading' }]])).rows[0]!.__treeState).toBe('loading')
    expect(flattenTree(roots, row => row.id, lazy, open, new Map([['p', { status: 'error' }]])).rows[0]!.__treeState).toBe('error')
    const ready = flattenTree(roots, row => row.id, lazy, open, new Map([['p', { status: 'ready', rows: [node('c')], truncated: false }]]))
    expect(ready.rows.map(row => row.id)).toEqual(['p', 'c'])
    expect(ready.rows[0]!.__treeState).toBe('expanded')
  })
})

const emptyState = { kind: 'empty' as const, domain: '本页展示商品', prerequisite: '先同步商品' }
const columns = [textColumn<Node>('名称', 'name'), numberColumn<Node>('件数', 'units')]
const base = (fetchPage: PageFetcher<Node>, tree: TreeOptions<Node>, resetKey = 'k1') => ({ gridId: 'tree-test', columns, fetchPage, getRowId: (row: Node) => row.id, resetKey, emptyState, tree })

describe('行内展开在页码分页表格里', () => {
  it('子行已随父行带来：点展开立刻显示，不发请求；再点收起', async () => {
    const loadChildren = vi.fn()
    const roots = [node('p', [node('c1'), node('c2')])]
    renderWithApp(<PagedGrid {...base(async () => ({ items: roots, total: 1 }), { ...options, loadChildren })} />)
    await screen.findByText('行p')
    expect(screen.queryByText('行c1')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    expect(await screen.findByText('行c1')).toBeInTheDocument()
    expect(screen.getByText('行c2')).toBeInTheDocument()
    expect(loadChildren).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '收起子行' }))
    await waitFor(() => expect(screen.queryByText('行c1')).toBeNull())
  })

  it('子行懒加载：第一次展开请求一次，收起再展开不重复请求', async () => {
    const loadChildren = vi.fn(async () => [node('c1'), node('c2')])
    const lazy: TreeOptions<Node> = { hasChildren: row => row.id === 'p', loadChildren }
    renderWithApp(<PagedGrid {...base(async () => ({ items: [node('p')], total: 1 }), lazy)} />)
    await screen.findByText('行p')
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    expect(await screen.findByText('行c2')).toBeInTheDocument()
    expect(loadChildren).toHaveBeenCalledTimes(1)
    expect((loadChildren.mock.calls as unknown as [[{ id: string }]])[0][0]).toMatchObject({ id: 'p' })
    await userEvent.click(screen.getByRole('button', { name: '收起子行' }))
    await waitFor(() => expect(screen.queryByText('行c1')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    expect(await screen.findByText('行c1')).toBeInTheDocument()
    expect(loadChildren).toHaveBeenCalledTimes(1)
  })

  it('子行加载失败：显示失败说明，再点一次重试', async () => {
    let fail = true
    const loadChildren = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return [node('c1')]
    })
    renderWithApp(<PagedGrid {...base(async () => ({ items: [node('p')], total: 1 }), { hasChildren: () => true, loadChildren })} />)
    await screen.findByText('行p')
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    const retry = await screen.findByRole('button', { name: '子行加载失败，点击重试' })
    fail = false
    await userEvent.click(retry)
    expect(await screen.findByText('行c1')).toBeInTheDocument()
    expect(loadChildren).toHaveBeenCalledTimes(2)
  })

  it('没有子行的行没有展开按钮；换页后展开状态清空', async () => {
    const fetchPage: PageFetcher<Node> = async ({ page }) => ({ items: [node(`p${page}`, [node(`c${page}`)]), node(`leaf${page}`)], total: 80 })
    renderWithApp(<PagedGrid {...base(fetchPage, options)} />)
    await screen.findByText('行leaf1')
    expect(screen.getAllByRole('button', { name: '展开子行' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    await screen.findByText('行c1')
    await userEvent.click(screen.getByTitle('2'))
    await screen.findByText('行leaf2')
    expect(screen.queryByText('行c2')).toBeNull()
    await userEvent.click(screen.getByTitle('1'))
    await screen.findByText('行leaf1')
    expect(screen.queryByText('行c1')).toBeNull()
  })

  it('子行被截断时在工具栏写明，不悄悄丢', async () => {
    const kids = Array.from({ length: TREE_CHILD_LIMIT + 3 }, (_, i) => node(`k${i}`))
    renderWithApp(<PagedGrid {...base(async () => ({ items: [node('p', kids)], total: 1 }), options)} />)
    await screen.findByText('行p')
    await userEvent.click(screen.getByRole('button', { name: '展开子行' }))
    expect(await screen.findByText(new RegExp(`子行超过 ${TREE_CHILD_LIMIT} 个`))).toBeInTheDocument()
  })
})
