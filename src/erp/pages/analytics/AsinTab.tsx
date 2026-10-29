import { useCallback, useMemo, useState } from 'react'
import { Button, Input, Space } from 'antd'
import { BR_ASIN_SORTS, type BrAsinResponse, type BrAsinRow, type BrCommon, type BrAsinSort, type BrLevel } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { MassiveGrid, renderColumn, RIGHT_ALIGNED, type CursorFetcher, type ErpColDef } from '../../components'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { AsinTrendDrawer } from './AsinTrendDrawer'
import { Figure, GridFrame } from './business-reports-ui'

// 按 ASIN 的销售与流量（04 章 4.5 第 3、4、5 个页签；P6-28 迁到 MassiveGrid）：SKU、子体（ASIN）、父体三个层级。
// 搜索、排序、翻页都在服务端（游标无限滚动，排序点列头）；官方没给的值写“尚无记录”，不当 0；
// 同一个 ASIN 两个来源都有时只用数据中心；点“趋势”看这个 ASIN 的逐日走势，点标题跳到 ASIN 360。

const DEFAULT_SORT = { field: 'orderedSales', direction: 'desc' } as const
export const ASIN_SORTABLE: Readonly<Record<string, string>> = Object.fromEntries(BR_ASIN_SORTS.map(key => [key, key]))

const metric = (title: string, key: BrAsinSort, width: number) => renderColumn<BrAsinRow>(title, key, row => <Figure metric={key} value={row[key]} />, { width, ...RIGHT_ALIGNED })

function columnsOf(level: BrLevel, open: (row: BrAsinRow) => void): ErpColDef<BrAsinRow>[] {
  return [
    renderColumn<BrAsinRow>(
      level === 'PARENT' ? '父体 ASIN' : level === 'SKU' ? 'SKU / ASIN' : 'ASIN / 商品',
      'product',
      row => {
        const heading = row.title ?? (level === 'PARENT' ? '父体' : '商品目录里没有这个 ASIN')
        return (
          <span className="erp-cell-stack">
            {row.productId ? (
              <LiveLink component="Asin360Page" id={row.productId}>
                {row.title ?? row.asin}
              </LiveLink>
            ) : (
              <span>{row.title ?? <Muted>{heading}</Muted>}</span>
            )}
            <span className="erp-cell-sub erp-num">
              {row.asin}
              {row.sku ? ` · ${row.sku}` : ''}
              {row.parentAsin && row.parentAsin !== row.asin ? ` · 父体 ${row.parentAsin}` : ''}
            </span>
          </span>
        )
      },
      { width: 280, pin: 'left' },
    ),
    renderColumn<BrAsinRow>('店铺', 'storeName', row => row.storeName ?? <Muted>尚无记录</Muted>, { width: 110 }),
    metric('订购商品销售额', 'orderedSales', 140),
    metric('订购件数', 'unitsOrdered', 100),
    metric('会话数', 'sessions', 100),
    metric('页面浏览量', 'pageViews', 110),
    metric('单位会话转化率', 'unitSessionPct', 140),
    metric('平均售价', 'avgPrice', 100),
    metric('购物车获得率', 'buyBoxPct', 120),
    renderColumn<BrAsinRow>(
      '趋势',
      'trend',
      row =>
        level === 'PARENT' ? (
          <Muted>不支持</Muted>
        ) : (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => open(row)} aria-label={`查看 ${row.asin} 的趋势`}>
            趋势
          </Button>
        ),
      { width: 80, pin: 'right', sortable: false },
    ),
  ]
}

export function AsinTab({ level }: { level: BrLevel }) {
  const { apiParams } = useScope()
  const [q, setQ] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [trendAsin, setTrendAsin] = useState<BrAsinRow | null>(null)
  const [meta, setMeta] = useState<BrCommon | null>(null)
  const columns = useMemo(() => columnsOf(level, setTrendAsin), [level])
  const fetchPage = useCallback<CursorFetcher<BrAsinRow>>(
    async ({ cursor, limit, sort, signal }) => {
      const params = { ...apiParams, level, q, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined }
      const data = await apiFetch<BrAsinResponse>(buildPath('/analytics/sales-traffic/by-asin', params), { signal })
      if (cursor === null) setMeta(data)
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    [apiParams, level, q],
  )
  return (
    <div>
      <Space wrap style={{ margin: '8px 0' }}>
        <Input.Search
          allowClear
          style={{ width: 260 }}
          placeholder={level === 'SKU' ? '搜索 SKU 或 ASIN' : '搜索 ASIN'}
          aria-label="搜索"
          value={text}
          onChange={event => setText(event.target.value)}
          onSearch={value => setQ(value.trim() || undefined)}
        />
      </Space>
      <GridFrame meta={meta} testId={`br-asin-${level.toLowerCase()}`}>
        <MassiveGrid<BrAsinRow>
          gridId={`analytics.business-reports.asin.${level.toLowerCase()}`}
          columns={columns}
          fetchPage={fetchPage}
          getRowId={row => row.key}
          sortableFields={ASIN_SORTABLE}
          defaultSort={DEFAULT_SORT}
          resetKey={JSON.stringify([apiParams, level, q])}
          appliedFilterCount={q ? 1 : 0}
          onClearFilters={() => {
            setQ(undefined)
            setText('')
          }}
          emptyState={{ kind: 'empty', domain: '销售与流量', prerequisite: q ? '没有符合搜索条件的记录。' : (meta?.note ?? '所选范围内尚无销售与流量数据。') }}
          height={520}
        />
      </GridFrame>
      {trendAsin ? <AsinTrendDrawer asin={trendAsin.asin} title={trendAsin.title} onClose={() => setTrendAsin(null)} /> : null}
    </div>
  )
}
