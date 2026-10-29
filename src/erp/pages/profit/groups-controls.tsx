import { useState } from 'react'
import { Button, Input, Segmented, Select, Space } from 'antd'
import { PROFIT_DIMENSIONS, PROFIT_DIMENSION_LABEL, PROFIT_SORTS, PROFIT_SORT_LABEL, type CursorPageInfo, type ProfitDimension, type ProfitSort } from '@nova/api-contracts'

// ASIN 利润与广告后利润两个页签共用的筛选与分页：维度（SKU、ASIN、父体）、搜索、排序（均由服务端做）、游标分页（上一页、下一页）。

const PAGE_SIZE = 20

export type GroupFilters = { by: ProfitDimension; q?: string; sort: ProfitSort }

export function useGroupPaging(initial: Partial<GroupFilters> = {}) {
  const [filters, setFilters] = useState<GroupFilters>({ by: 'SKU', sort: 'revenue', ...initial })
  // 游标栈：栈顶是当前页的游标，undefined 表示第一页
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  const set = (patch: Partial<GroupFilters>) => {
    setFilters(current => ({ ...current, ...patch }))
    setStack([undefined])
  }
  const params = { by: filters.by, q: filters.q, sort: `${filters.sort}:desc`, pageSize: PAGE_SIZE, cursor: stack[stack.length - 1] }
  return { filters, set, stack, setStack, params }
}

export function GroupsToolbar({ filters, set }: { filters: GroupFilters; set: (patch: Partial<GroupFilters>) => void }) {
  const [text, setText] = useState('')
  return (
    <Space wrap style={{ margin: '8px 0' }}>
      <Segmented
        aria-label="汇总维度"
        value={filters.by}
        options={PROFIT_DIMENSIONS.map(value => ({ value, label: PROFIT_DIMENSION_LABEL[value] }))}
        onChange={value => set({ by: value as ProfitDimension })}
      />
      <Input.Search
        allowClear
        style={{ width: 240 }}
        placeholder="搜索 SKU、ASIN 或商品名"
        aria-label="搜索商品"
        value={text}
        onChange={event => setText(event.target.value)}
        onSearch={value => set({ q: value.trim() || undefined })}
      />
      <Select
        style={{ width: 150 }}
        aria-label="排序"
        value={filters.sort}
        options={PROFIT_SORTS.map(value => ({ value, label: `按${PROFIT_SORT_LABEL[value]}从高到低` }))}
        onChange={value => set({ sort: value })}
      />
    </Space>
  )
}

export function Pager({
  stack,
  setStack,
  pageInfo,
  fetching,
}: {
  stack: Array<string | undefined>
  setStack: (next: (current: Array<string | undefined>) => Array<string | undefined>) => void
  pageInfo?: CursorPageInfo
  fetching: boolean
}) {
  const next = pageInfo?.hasMore ? pageInfo.nextCursor : null
  return (
    <Space style={{ marginTop: 8 }}>
      <Button disabled={stack.length <= 1 || fetching} onClick={() => setStack(current => current.slice(0, -1))}>
        上一页
      </Button>
      <Button disabled={!next || fetching} onClick={() => next && setStack(current => [...current, next])}>
        下一页
      </Button>
      <span style={{ color: 'rgba(0,0,0,0.45)' }}>
        第 {stack.length} 页{pageInfo?.approxTotal === null || pageInfo?.approxTotal === undefined ? '' : `，共约 ${pageInfo.approxTotal} 条`}
      </span>
    </Space>
  )
}
