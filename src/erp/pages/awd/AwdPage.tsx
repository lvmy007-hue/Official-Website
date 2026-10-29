import { useCallback, useMemo, useState } from 'react'
import { Card, Input, Select, Space, Tabs, Typography } from 'antd'
import {
  AWD_ORDER_STATUS_LABEL,
  AWD_SHIPMENT_STATUS_LABEL,
  AWD_TABS,
  AWD_TAB_LABEL,
  type AwdInventoryResponse,
  type AwdInventoryRow,
  type AwdOrderListResponse,
  type AwdOrderRow,
  type AwdShipmentListResponse,
  type AwdShipmentRow,
  type AwdTab,
} from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { ActionGuard, FreshnessBar, PageHeader, PagedGrid, type PageFetcher } from '../../components'
import { buildPath, useApiQuery } from '../../query/api-query'
import { useScope } from '../../scope/context'
import type { ScopeOptions } from '../../shell/ScopeBar'
import { inventoryColumns, orderColumns, shipmentColumns } from './awd-tables'
import { awdFreshnessInfo, awdGuard, qty, StateNote } from './awd-ui'
import { AwdOrderDrawer } from './AwdOrderDrawer'

// 亚马逊仓储分销（P2a-08，06 章 6.3；P6-28 迁到 PagedGrid）：库存、入库订单、入库货件三个页签。
// 数据每 2 小时从亚马逊同步一次；没有开通上游仓储的店铺显示“未开通”，不显示数字。亚马逊没有提供“列出入库订单”的接口，
// 订单列表包含我们创建的订单，以及货件所属的订单；在亚马逊后台直接创建、且还没有货件的订单不会出现在这里。
// 创建订单默认只存本地草稿，提交亚马逊要通过写入开关（页面上按钮禁用时会写明卡在哪一步）。

type ListMeta<R extends { items: unknown[] }> = Omit<R, 'items' | 'total' | 'page' | 'pageSize'>

/** 三个列表共用的取数：带搜索词与状态，把非行的部分（新鲜度、状态说明、合计等）留给页面显示。 */
function useAwdFetcher<R extends { items: T[]; total: number }, T>(path: string, q: string, status: string | undefined, onMeta: (meta: ListMeta<R>) => void): PageFetcher<T> {
  const { apiParams } = useScope()
  return useCallback<PageFetcher<T>>(
    async ({ page, pageSize, signal }) => {
      const data = await apiFetch<R>(buildPath(path, { ...apiParams, q: q || undefined, status, page, pageSize }), { signal })
      onMeta(data)
      return { items: data.items, total: data.total }
    },
    [apiParams, path, q, status, onMeta],
  )
}

/** 全局范围变化要让表格从头重取：并进各表格的 resetKey。 */
const useScopeKey = () => JSON.stringify(useScope().apiParams)

function Filters({
  onSearch,
  options,
  status,
  onStatus,
}: {
  onSearch: (value: string) => void
  status?: string
  options?: Array<{ value: string; label: string }>
  onStatus?: (value: string | undefined) => void
}) {
  const [text, setText] = useState('')
  return (
    <Space wrap style={{ marginBottom: 8 }}>
      <Input.Search
        allowClear
        style={{ width: 280 }}
        placeholder="搜索订单号、货件编号、运单号、SKU"
        aria-label="搜索"
        value={text}
        onChange={event => setText(event.target.value)}
        onSearch={value => onSearch(value.trim())}
      />
      {options && onStatus ? <Select allowClear style={{ width: 200 }} placeholder="全部状态" aria-label="状态筛选" value={status} options={options} onChange={onStatus} /> : null}
    </Space>
  )
}

function InventoryPane() {
  const scopeKey = useScopeKey()
  const [q, setQ] = useState('')
  const [meta, setMeta] = useState<ListMeta<AwdInventoryResponse> | null>(null)
  const columns = useMemo(() => inventoryColumns(), [])
  const fetchPage = useAwdFetcher<AwdInventoryResponse, AwdInventoryRow>('/awd/inventory', q, undefined, setMeta)
  const totals = meta?.totals
  return (
    <>
      <FreshnessBar freshness={meta ? awdFreshnessInfo(meta.freshness) : undefined} />
      {meta ? <StateNote state={meta.state} note={meta.note} /> : null}
      {totals && meta?.state === 'OK' ? (
        <Space wrap size={24} style={{ margin: '4px 0 8px' }} data-testid="awd-totals">
          <span>可用合计 {qty(totals.availableQty)}</span>
          <span>在库合计 {qty(totals.onhandQty)}</span>
          <span>入库中 {qty(totals.inboundToAwdQty)}</span>
          <span>发往亚马逊物流在途 {qty(totals.outboundToFbaInTransit)}</span>
          <Typography.Text type="secondary">快照日期 {meta.snapshotDate ?? '尚无记录'}（每个店铺取最近一次）</Typography.Text>
        </Space>
      ) : null}
      <Filters onSearch={setQ} />
      <PagedGrid<AwdInventoryRow>
        gridId="awd.inventory"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => `${row.sellerAccountId}|${row.sku}`}
        resetKey={JSON.stringify([scopeKey, q])}
        appliedFilterCount={q ? 1 : 0}
        onClearFilters={() => setQ('')}
        emptyState={{ kind: 'empty', domain: '上游仓储库存', prerequisite: '店铺授权并开通亚马逊仓储分销后，同步完成才有库存快照；没有开通的店铺不会显示数字。' }}
        height={520}
      />
    </>
  )
}

function OrdersPane({ stores }: { stores: Array<{ id: string; name: string }> }) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [creating, setCreating] = useState(false)
  const scopeKey = useScopeKey()
  const [nonce, setNonce] = useState(0)
  const [meta, setMeta] = useState<ListMeta<AwdOrderListResponse> | null>(null)
  const columns = useMemo(() => orderColumns(), [])
  const fetchPage = useAwdFetcher<AwdOrderListResponse, AwdOrderRow>('/awd/orders', q, status, setMeta)
  return (
    <>
      <FreshnessBar freshness={meta ? awdFreshnessInfo(meta.freshness) : undefined} />
      {meta ? <StateNote state={meta.state} note={meta.note} /> : null}
      <Space style={{ marginBottom: 8 }}>
        <ActionGuard label="新建入库订单" guard={awdGuard(meta?.write, { amazon: false })} onExecute={async () => setCreating(true)} buttonProps={{ type: 'primary' }} />
      </Space>
      <Filters status={status} options={Object.entries(AWD_ORDER_STATUS_LABEL).map(([value, label]) => ({ value, label }))} onStatus={setStatus} onSearch={setQ} />
      <PagedGrid<AwdOrderRow>
        gridId="awd.orders"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={JSON.stringify([scopeKey, q, status, nonce])}
        appliedFilterCount={(q ? 1 : 0) + (status ? 1 : 0)}
        onClearFilters={() => {
          setQ('')
          setStatus(undefined)
        }}
        emptyState={{ kind: 'empty', domain: '上游仓储入库订单', prerequisite: '还没有入库订单。可以新建，或在补货建议里“生成上游仓储入库订单草稿”；亚马逊不提供订单列表接口，只会同步有货件的订单。' }}
        height={520}
      />
      <AwdOrderDrawer
        open={creating}
        onClose={() => {
          setCreating(false)
          setNonce(value => value + 1)
        }}
        stores={stores}
        write={meta?.write}
      />
    </>
  )
}

function ShipmentsPane() {
  const scopeKey = useScopeKey()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [meta, setMeta] = useState<ListMeta<AwdShipmentListResponse> | null>(null)
  const columns = useMemo(() => shipmentColumns(), [])
  const fetchPage = useAwdFetcher<AwdShipmentListResponse, AwdShipmentRow>('/awd/shipments', q, status, setMeta)
  return (
    <>
      <FreshnessBar freshness={meta ? awdFreshnessInfo(meta.freshness) : undefined} />
      {meta ? <StateNote state={meta.state} note={meta.note} /> : null}
      <Filters status={status} options={Object.entries(AWD_SHIPMENT_STATUS_LABEL).map(([value, label]) => ({ value, label }))} onStatus={setStatus} onSearch={setQ} />
      <PagedGrid<AwdShipmentRow>
        gridId="awd.shipments"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={JSON.stringify([scopeKey, q, status])}
        appliedFilterCount={(q ? 1 : 0) + (status ? 1 : 0)}
        onClearFilters={() => {
          setQ('')
          setStatus(undefined)
        }}
        emptyState={{ kind: 'empty', domain: '上游仓储入库货件', prerequisite: '亚马逊确认订单并生成货件后，同步完成才会显示。' }}
        height={520}
      />
    </>
  )
}

export default function AwdPage() {
  const [tab, setTab] = useState<AwdTab>('inventory')
  const options = useApiQuery<ScopeOptions>({ domain: 'reference', path: '/scope/options', scoped: false })
  const stores = (options.data?.stores ?? []).map(store => ({ id: store.id, name: store.name }))
  return (
    <div>
      <PageHeader title="亚马逊仓储分销" description="上游仓储（AWD）的库存、入库订单与入库货件；数据每 2 小时同步一次。创建订单默认只保存本地草稿，提交亚马逊要通过写入开关。" />
      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={key => setTab(key as AwdTab)}
          items={AWD_TABS.map(key => ({
            key,
            label: AWD_TAB_LABEL[key],
            children: key === 'inventory' ? <InventoryPane /> : key === 'orders' ? <OrdersPane stores={stores} /> : <ShipmentsPane />,
          }))}
        />
      </Card>
    </div>
  )
}
