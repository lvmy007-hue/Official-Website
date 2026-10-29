import { useState, type ReactNode } from 'react'
import { Alert, Input, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  SNS_ASIN_SORTS,
  SNS_ELIGIBILITIES,
  SNS_OFFER_SORTS,
  SNS_SORT_LABEL,
  snsEligibilityLabel,
  type SnsAsinListResponse,
  type SnsAsinRow,
  type SnsAsinSort,
  type SnsListResponse,
  type SnsOfferListResponse,
  type SnsOfferRow,
  type SnsOfferSort,
} from '@nova/api-contracts'
import { SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { PAGE_SIZES, Pager, Pick } from '../reimbursements/reimbursements-ui'
import { GateTag, countOr, moneyOr } from './subscribe-save-ui'

// 订阅省的两个明细页签（P4-06）：ASIN 明细（同店铺同 ASIN 的 SKU 合并）与报价参与列表（每个店铺 SKU 一行）。
// 数据来自每个店铺最近一次报价快照：快照超过 7 天的店铺仍显示，但“补货”一列写原因。

const sortOptions = (fields: readonly (SnsAsinSort | SnsOfferSort)[]) =>
  fields.flatMap(field => [
    { value: `${field}:desc`, label: `${SNS_SORT_LABEL[field]}（从大到小）` },
    { value: `${field}:asc`, label: `${SNS_SORT_LABEL[field]}（从小到大）` },
  ])

function Notices({ data }: { data: SnsListResponse<unknown> }) {
  return (
    <>
      {data.truncated ? (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="报价数超过读取上限，列表只含已读到的部分" description="请选择店铺后再看。" data-testid="sns-list-truncated" />
      ) : null}
      {data.staleStores.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`${data.staleStores.join('、')} 的报价快照已超过 7 天`}
          description="这些店铺的行仍显示，但不计入预计订阅出货，也不会用于补货建议；同步恢复后会更新。"
          data-testid="sns-list-stale"
        />
      ) : null}
      {data.snapshotDate ? <Muted>最近一次报价快照：{data.snapshotDate}</Muted> : null}
    </>
  )
}

const emptyOf = (data: SnsListResponse<unknown> | undefined, text: string) => ({
  kind: 'empty' as const,
  domain: text,
  prerequisite: (data?.state === 'ROLE_PENDING' ? '未授权：申请方式见上方说明' : data?.note) ?? '尚无记录',
})

function useListState() {
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string>()
  const [sort, setSort] = useState<string>()
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])
  const [stack, setStack] = useState<Array<string | undefined>>([undefined])
  return { keyword, setKeyword, q, setQ, sort, setSort, pageSize, setPageSize, stack, setStack, reset: () => setStack([undefined]) }
}

type ListState = ReturnType<typeof useListState>

function Controls({ state, label, sorts, extra }: { state: ListState; label: string; sorts: readonly (SnsAsinSort | SnsOfferSort)[]; extra?: ReactNode }) {
  return (
    <Space wrap style={{ margin: '8px 0', display: 'flex' }}>
      <Input.Search
        allowClear
        aria-label={`搜索${label}`}
        placeholder={label === 'ASIN' ? '搜索 ASIN 或 SKU' : '搜索 SKU 或 ASIN'}
        style={{ width: 240 }}
        value={state.keyword}
        onChange={event => state.setKeyword(event.target.value)}
        onSearch={value => {
          state.setQ(value.trim() || undefined)
          state.reset()
        }}
      />
      {extra}
      <Pick
        label="排序"
        width={210}
        value={state.sort}
        options={sortOptions(sorts)}
        onChange={value => {
          state.setSort(value)
          state.reset()
        }}
      />
      <Pick
        label="每页条数"
        value={String(state.pageSize)}
        options={PAGE_SIZES.map(size => ({ value: String(size), label: `${size} 条/页` }))}
        onChange={value => {
          state.setPageSize(Number(value ?? PAGE_SIZES[0]))
          state.reset()
        }}
      />
    </Space>
  )
}

const asinColumns: ColumnsType<SnsAsinRow> = [
  {
    title: 'ASIN',
    dataIndex: 'asin',
    width: 150,
    fixed: 'left',
    render: (value: string, row) =>
      row.productId ? (
        <LiveLink component="Asin360Page" id={row.productId}>
          {value}
        </LiveLink>
      ) : (
        value
      ),
  },
  { title: 'SKU', key: 'skus', width: 180, render: (_value, row) => row.skus.join('、') },
  { title: '店铺', dataIndex: 'storeName', width: 120, render: (value: string | null) => value ?? <Muted>未知</Muted> },
  { title: '订阅数', dataIndex: 'subscriptions', width: 90, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '上月订阅出货', dataIndex: 'shippedUnitsPrevMonth', width: 120, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '未来 30 天', dataIndex: 'forecastNext30', width: 100, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '未来 60 天', dataIndex: 'forecastNext60', width: 100, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '未来 90 天', dataIndex: 'forecastNext90', width: 100, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '补货建议', key: 'gate', width: 280, render: (_value, row) => <GateTag gate={row.replenishment} /> },
]

export function AsinTab() {
  const state = useListState()
  const list = useApiQuery<SnsAsinListResponse>({
    domain: 'list',
    path: '/subscribe-save/asins',
    params: { q: state.q, sort: state.sort, pageSize: state.pageSize, cursor: state.stack[state.stack.length - 1] },
  })
  const data = list.data
  return (
    <div data-testid="sns-asins">
      <Controls state={state} label="ASIN" sorts={SNS_ASIN_SORTS} />
      {data ? <Notices data={data} /> : null}
      <SimpleGrid<SnsAsinRow>
        gridId="subscribe-save.subscribe-save-tabs"
        columns={asinColumns}
        rows={data?.items}
        rowKey={row => row.key}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={emptyOf(data, '订阅省 ASIN')}
      />
      <Pager stack={state.stack} next={data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null} busy={list.isFetching} onStack={state.setStack} />
    </div>
  )
}

const offerColumns: ColumnsType<SnsOfferRow> = [
  { title: 'SKU', dataIndex: 'sku', width: 170, fixed: 'left' },
  { title: 'ASIN', dataIndex: 'asin', width: 130 },
  { title: '店铺', dataIndex: 'storeName', width: 120, render: (value: string | null) => value ?? <Muted>未知</Muted> },
  { title: '可订阅状态', dataIndex: 'eligibility', width: 110, render: (_value, row) => row.eligibilityLabel },
  {
    title: '卖家承担折扣',
    dataIndex: 'discountPct',
    width: 120,
    align: 'right',
    render: (value: number | null) => (value === null ? <Muted>未提供</Muted> : <span className="erp-num">{value}%</span>),
  },
  { title: '价格', dataIndex: 'price', width: 110, align: 'right', render: (value: number | null, row) => moneyOr(value, row.currency) },
  { title: '库存', dataIndex: 'inventory', width: 90, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '订阅数', dataIndex: 'subscriptions', width: 90, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '未来 30 天预计', dataIndex: 'forecastNext30', width: 120, align: 'right', render: (value: number | null) => countOr(value) },
  { title: '快照日期', dataIndex: 'snapshotDate', width: 110 },
  { title: '补货建议', key: 'gate', width: 280, render: (_value, row) => <GateTag gate={row.replenishment} /> },
]

export function OfferTab() {
  const state = useListState()
  const [eligibility, setEligibility] = useState<string>()
  const list = useApiQuery<SnsOfferListResponse>({
    domain: 'list',
    path: '/subscribe-save/offers',
    params: { q: state.q, eligibility, sort: state.sort, pageSize: state.pageSize, cursor: state.stack[state.stack.length - 1] },
  })
  const data = list.data
  return (
    <div data-testid="sns-offers">
      <Controls
        state={state}
        label="报价"
        sorts={SNS_OFFER_SORTS}
        extra={
          <Pick
            label="可订阅状态"
            value={eligibility}
            options={SNS_ELIGIBILITIES.map(value => ({ value, label: snsEligibilityLabel(value) }))}
            onChange={value => {
              setEligibility(value)
              state.reset()
            }}
          />
        }
      />
      {data ? <Notices data={data} /> : null}
      <SimpleGrid<SnsOfferRow>
        gridId="subscribe-save.subscribe-save-tabs-2"
        columns={offerColumns}
        rows={data?.items}
        rowKey={row => row.key}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyState={emptyOf(data, '订阅省报价')}
      />
      <Pager stack={state.stack} next={data?.pageInfo.hasMore ? data.pageInfo.nextCursor : null} busy={list.isFetching} onStack={state.setStack} />
    </div>
  )
}
