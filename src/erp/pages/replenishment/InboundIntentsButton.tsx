import { useCallback, useMemo, useState } from 'react'
import { Button, Drawer, Space, Typography } from 'antd'
import type { InboundIntentListResponse, InboundIntentRow } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { dateTimeColumn, numberColumn, PagedGrid, renderColumn, type ErpColDef, type PageFetcher } from '../../components'
import { useScope } from '../../scope/context'
import { buildPath, useApiQuery } from '../../query/api-query'
import { LiveLink } from '../inventory/inventory-ui'
import { InboundDraftsAction } from './InboundDraftsAction'

// 补建历史意向（P6-08，16 章第 5.2 节）：以前“生成入仓计划草稿”只能登记意向、没有生成单据；这里列出这些记录，勾选同一批次的几条一键补建成真实草稿。
// 补建成功后，那条记录自动从清单里消失（同一条建议有了已完成的草稿动作就算已解决）。没有待补建的记录时不显示入口。

const INTENT_COLUMNS: ErpColDef<InboundIntentRow>[] = [
  renderColumn<InboundIntentRow>(
    '批次',
    'batchNo',
    row => (
      <LiveLink component="ReplenishmentBatchDetailPage" id={row.batchId}>
        {row.batchNo}
      </LiveLink>
    ),
    { width: 170, sortable: false },
  ),
  { headerName: '店铺', colId: 'storeName', width: 140, sortable: false, valueGetter: ({ data }) => data?.storeName ?? '' },
  { headerName: 'SKU', colId: 'sku', width: 170, sortable: false, valueGetter: ({ data }) => data?.sku ?? '' },
  { headerName: '商品', colId: 'title', width: 220, sortable: false, valueGetter: ({ data }) => data?.title ?? data?.asin ?? '' },
  numberColumn<InboundIntentRow>('登记的数量', 'qty', { digits: 0, sortable: false, width: 120 }),
  dateTimeColumn<InboundIntentRow>('登记时间', 'registeredAt', { width: 170 }),
]

const SORTABLE = { registeredAt: 'registeredAt' } as const

export function InboundIntentsButton() {
  const { apiParams } = useScope()
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const head = useApiQuery<InboundIntentListResponse>({ domain: 'list', path: '/replenishment/intents', params: { pageSize: 20 } })

  const fetchPage = useCallback<PageFetcher<InboundIntentRow>>(
    async ({ page, pageSize, sort, signal }) => {
      const response = await apiFetch<InboundIntentListResponse>(buildPath('/replenishment/intents', { ...apiParams, sort: sort ? `${sort.field}:${sort.direction}` : undefined, page, pageSize }), {
        signal,
      })
      return { items: response.items, total: response.total }
    },
    [apiParams],
  )
  const bulk = useCallback(
    (rows: InboundIntentRow[]) => {
      // 表格在没勾选时也会调用一次（动作条此时不显示），这里直接返回空
      if (rows.length === 0) return null
      const batches = new Set(rows.map(row => row.batchId))
      if (batches.size > 1) return <Typography.Text type="warning">一次补建只能选同一个批次的记录（已选 {batches.size} 个批次）</Typography.Text>
      return (
        <InboundDraftsAction
          label="补建入仓计划草稿"
          batchId={rows[0]!.batchId}
          targets={rows.map(row => ({ recommendationId: row.recommendationId, qty: row.qty }))}
          onDone={() => {
            setVersion(current => current + 1)
            void head.refetch()
          }}
        />
      )
    },
    [head],
  )
  const columns = useMemo(() => INTENT_COLUMNS, [])

  const total = head.data?.total ?? 0
  if (total === 0 && !open) return null
  return (
    <>
      <Button onClick={() => setOpen(true)}>补建入仓草稿（{total}）</Button>
      <Drawer open={open} onClose={() => setOpen(false)} width={900} destroyOnClose title="补建入仓计划草稿">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            这些建议以前点过“生成入仓计划草稿”，当时没有发货地址，只登记了意向、没有生成单据。现在可以按店铺的发货地址一键补建；补建后会从这里消失。
          </Typography.Paragraph>
          <PagedGrid<InboundIntentRow>
            gridId="replenishment.intents"
            columns={columns}
            fetchPage={fetchPage}
            getRowId={row => row.actionId}
            sortableFields={SORTABLE}
            defaultSort={{ field: 'registeredAt', direction: 'desc' }}
            resetKey={JSON.stringify([apiParams, version])}
            renderBulkActions={bulk}
            emptyState={{ kind: 'empty', domain: '待补建的意向', prerequisite: '没有只登记了意向、还没生成草稿的记录。' }}
            height={480}
          />
        </Space>
      </Drawer>
    </>
  )
}
