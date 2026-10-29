import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithApp } from '../../test/render'
import { FilterBar } from './FilterBar'
import { appliedCount, appliedTags, nextFilterSearch, replacePatch, sanitizeFilterValues, searchPatch, type FilterField, type FilterPatch, type FilterValues, type SearchMode } from './filter-model'

// 筛选栏（P6-04）：批量粘贴去空行去重、已生效条件标签可逐个删除、一键重置、更多筛选里的条件数；纯函数部分单独验证地址栏取值的清洗。

const FIELDS: FilterField[] = [
  {
    key: 'status',
    label: '状态',
    kind: 'select',
    options: [
      { value: 'ENABLED', label: '启用中' },
      { value: 'PAUSED', label: '已暂停' },
    ],
  },
  { key: 'tab', label: '页签', kind: 'select', hidden: true, options: [{ value: 'risk', label: '风险' }] },
  { key: 'sku', label: '商品 SKU', kind: 'text', placement: 'more' },
  { key: 'tag', label: '标签', kind: 'select', placement: 'more', strict: false, options: [] },
]
const MODES: SearchMode[] = [
  { id: 'contains', label: '名称包含', key: 'q', batchKey: 'qs', batchLabel: '编号' },
  { id: 'excludes', label: '名称不包含', key: 'q', with: { qMode: 'excludes' } },
]

describe('filter-model', () => {
  it('地址栏取值清洗：下拉里没有的选项、不合规的批量词丢掉并计数；范围参数不算筛选条件', () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => `T${index}`).join(',')
    const { values, ignored } = sanitizeFilterValues(FIELDS, MODES, { status: 'WRONG', tag: '任意标签', q: '春季', qs: tooMany, from: '2026-10-01', page: '3' })
    expect(values).toEqual({ tag: '任意标签', q: '春季' })
    expect(ignored).toBe(2)
  })

  it('qMode 没有搜索词时无意义，读取时去掉', () => {
    expect(sanitizeFilterValues(FIELDS, MODES, { qMode: 'excludes' }).values).toEqual({})
    expect(sanitizeFilterValues(FIELDS, MODES, { q: 'a', qMode: 'excludes' }).values).toEqual({ q: 'a', qMode: 'excludes' })
  })

  it('套用保存方案时，方案里认不出的条件计入忽略数', () => {
    expect(sanitizeFilterValues(FIELDS, MODES, { status: 'ENABLED', retired: 'x' }, { countUnknown: true })).toEqual({ values: { status: 'ENABLED' }, ignored: 1 })
  })

  it('标签：下拉与文本各一个，搜索词一个（带方式名），批量词一个（只显示个数）；页签不出标签但计入条件数', () => {
    const values: FilterValues = { status: 'PAUSED', sku: 'A-1', q: '春', qMode: 'excludes', qs: 'a,b,c', tab: 'risk' }
    const tags = appliedTags(FIELDS, MODES, values)
    expect(tags.map(tag => `${tag.label}：${tag.text}`)).toEqual(['状态：已暂停', '商品 SKU：A-1', '名称不包含：春', '编号（批量精确）：3 项'])
    expect(appliedCount(FIELDS, MODES, values)).toBe(5)
  })

  it('改搜索方式时清掉另一种方式留下的附加键；筛选变化回到第一页（去掉页码与游标），空值删除键', () => {
    expect(searchPatch(MODES, MODES[0]!, '春')).toEqual({ qMode: undefined, q: '春' })
    expect(searchPatch(MODES, MODES[1]!, ' 秋 ')).toEqual({ qMode: 'excludes', q: '秋' })
    expect(nextFilterSearch({ page: 4, cursor: 'c', status: 'ENABLED', from: '2026-10-01' }, { status: undefined, sku: 'A' })).toEqual({ from: '2026-10-01', sku: 'A' })
    expect(replacePatch(['a', 'b'], { a: '1' })).toEqual({ a: '1', b: undefined })
  })
})

function Harness({ initial = {} }: { initial?: FilterValues }) {
  const [values, setValues] = useState<FilterValues>(initial)
  const apply = (patch: FilterPatch) =>
    setValues(prev => {
      const next = { ...prev }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      return next
    })
  return (
    <>
      <FilterBar fields={FIELDS} modes={MODES} values={values} onChange={apply} onReset={() => setValues({})} />
      <output data-testid="values">{JSON.stringify(values)}</output>
    </>
  )
}
const current = () => JSON.parse(screen.getByTestId('values').textContent ?? '{}') as FilterValues

describe('FilterBar', () => {
  it('在搜索框里粘贴多行：打开批量搜索，去空行与重复后一次写入精确匹配的批量词（逗号连接）', async () => {
    renderWithApp(<Harness />)
    const box = screen.getByRole('searchbox', { name: '搜索名称包含' })
    fireEvent.paste(box, { clipboardData: { getData: () => 'A1\n\nb2\na1\n  \nC3' } })
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByLabelText('批量搜索内容')).toHaveValue('A1\n\nb2\na1\n  \nC3')
    expect(dialog.getByText(/共 3 个词，已去掉 1 个重复/)).toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /^搜\s?索$/ }))
    await waitFor(() => expect(current()).toEqual({ qs: 'A1,b2,C3' }))
    expect(screen.getByRole('list', { name: '已生效的条件' })).toHaveTextContent('编号（批量精确）：3 项')
    // 搜索框本身没有被塞进换行
    expect(box).toHaveValue('')
  })

  it('批量词超过 500 个：给出原因，不能提交', async () => {
    renderWithApp(<Harness />)
    fireEvent.paste(screen.getByRole('searchbox', { name: '搜索名称包含' }), { clipboardData: { getData: () => Array.from({ length: 501 }, (_, index) => `T${index}`).join('\n') } })
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('alert')).toHaveTextContent('最多 500 个词，当前去重后有 501 个')
    expect(dialog.getByRole('button', { name: /^搜\s?索$/ })).toBeDisabled()
  })

  it('单行粘贴不打开批量搜索；切换搜索方式后搜索词带着新方式', async () => {
    renderWithApp(<Harness />)
    fireEvent.paste(screen.getByRole('searchbox', { name: '搜索名称包含' }), { clipboardData: { getData: () => 'one line' } })
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索名称包含' }), '春季{Enter}')
    await waitFor(() => expect(current()).toEqual({ q: '春季' }))
    await userEvent.click(screen.getByRole('combobox', { name: '搜索方式' }))
    await userEvent.click(await screen.findByText('名称不包含'))
    await waitFor(() => expect(current()).toEqual({ q: '春季', qMode: 'excludes' }))
    expect(screen.getByRole('list', { name: '已生效的条件' })).toHaveTextContent('名称不包含：春季')
  })

  it('已生效条件标签可逐个移除；重置一键清空；没有条件时重置不可点', async () => {
    renderWithApp(<Harness initial={{ status: 'ENABLED', q: '春季' }} />)
    const tags = within(screen.getByRole('list', { name: '已生效的条件' }))
    expect(tags.getAllByRole('listitem')).toHaveLength(2)
    await userEvent.click(tags.getByRole('button', { name: '移除条件：状态' }))
    await waitFor(() => expect(current()).toEqual({ q: '春季' }))
    await userEvent.click(screen.getByRole('button', { name: /^重\s?置$/ }))
    await waitFor(() => expect(current()).toEqual({}))
    expect(screen.queryByRole('list', { name: '已生效的条件' })).toBeNull()
    expect(screen.getByRole('button', { name: /^重\s?置$/ })).toBeDisabled()
  })

  it('“更多筛选”按钮上显示已生效的条件数；更多筛选里的条件也出标签', () => {
    renderWithApp(<Harness initial={{ status: 'ENABLED', sku: 'A-1', q: '春' }} />)
    expect(screen.getByRole('button', { name: /更多筛选/ })).toHaveTextContent('3')
    expect(within(screen.getByRole('list', { name: '已生效的条件' })).getByText(/商品 SKU：A-1/)).toBeInTheDocument()
  })
})
