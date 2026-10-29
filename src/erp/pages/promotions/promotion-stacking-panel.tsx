import { useCallback, useMemo, useState } from 'react'
import { Alert, Card, Input, Space, Statistic, Tag, Typography } from 'antd'
import type { StackingFlag, StackingResponse, StackingRowView } from '@nova/api-contracts'
import { apiFetch } from '../../../api'
import { MassiveGrid, renderColumn, RIGHT_ALIGNED, type CursorFetcher, type ErpColDef } from '../../components'
import type { SortSpec } from '../../components/table/cursor-datasource'
import { formatDateTime } from '../../format'
import { buildPath } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'

// 促销叠加（P6-17，16 章第 3.2 节）：同一商品（店铺 × ASIN）在同一时段叠加了几个促销、叠加后的折扣深度。
// 顶部三张快捷筛选卡：叠加个数达到下限、折扣深度达到下限、两者之一；点一下就筛选下面的列表，再点取消。
// 数据来自已同步的促销清单（只读）；整个目录范围的促销没有商品清单，不计入；折扣深度按最近一次价格折算，算不出的写“算不出”，不写 0。

const SORTABLE = { peakCount: 'peakCount', depth: 'depth' } as const
const DEFAULT_SORT: SortSpec = { field: 'peakCount', direction: 'desc' }

const pctText = (value: number | null) => (value === null ? <Muted>算不出</Muted> : <span className="erp-num">{`${Math.round(value * 1000) / 10}%`}</span>)
const rangeText = (row: StackingRowView) => `${formatDateTime(row.peakFrom)} 至 ${row.peakTo ? formatDateTime(row.peakTo) : '长期有效'}`

const columns: ErpColDef<StackingRowView>[] = [
  renderColumn<StackingRowView>(
    '商品',
    'asin',
    row => (
      <div>
        <Typography.Text strong>{row.asin}</Typography.Text>
        {row.title ? (
          <div>
            <Muted>{row.title}</Muted>
          </div>
        ) : null}
      </div>
    ),
    { group: '商品', pin: 'left', width: 260 },
  ),
  renderColumn<StackingRowView>('店铺', 'storeName', row => row.storeName, { group: '商品', width: 130 }),
  renderColumn<StackingRowView>('同期叠加促销数', 'peakCount', row => <span className="erp-num">{row.peakCount}</span>, { group: '叠加', width: 140, ...RIGHT_ALIGNED }),
  renderColumn<StackingRowView>('叠加折扣深度', 'depth', row => pctText(row.depth), { group: '叠加', width: 130, ...RIGHT_ALIGNED }),
  renderColumn<StackingRowView>(
    '提示',
    'flags',
    row => (
      <Space size={4}>
        {row.stacked ? (
          <Tag color="warning" bordered={false}>
            叠加
          </Tag>
        ) : null}
        {row.deep ? (
          <Tag color="error" bordered={false}>
            折扣过深
          </Tag>
        ) : null}
        {row.unknownDepth > 0 ? <Muted>{`${row.unknownDepth} 个促销算不出深度`}</Muted> : null}
      </Space>
    ),
    { group: '叠加', width: 220, sortable: false },
  ),
  renderColumn<StackingRowView>('叠加时段', 'peakFrom', row => <span className="erp-num">{rangeText(row)}</span>, { group: '叠加', width: 330, sortable: false }),
  renderColumn<StackingRowView>('涉及促销总数', 'promotionCount', row => <span className="erp-num">{row.promotionCount}</span>, { group: '促销', width: 120, ...RIGHT_ALIGNED }),
  renderColumn<StackingRowView>(
    '促销',
    'promotions',
    row => row.promotions.map(item => `${item.title || item.promotionId}${item.depth === null ? '' : `（${Math.round(item.depth * 1000) / 10}%）`}`).join('；'),
    {
      group: '促销',
      width: 420,
      sortable: false,
    },
  ),
]

type Meta = Pick<StackingResponse, 'summary' | 'note' | 'truncated' | 'basis' | 'catalogNote'>

const CARDS: Array<{ flag: StackingFlag; title: (meta: Meta) => string; count: (meta: Meta) => number }> = [
  { flag: 'stacked', title: meta => `同期叠加 ${meta.summary.minStack} 个以上促销`, count: meta => meta.summary.stacked },
  { flag: 'deep', title: meta => `叠加折扣深度达到 ${Math.round(meta.summary.minDepthPct * 100)}%`, count: meta => meta.summary.deep },
  { flag: 'any', title: () => '叠加或折扣过深（两者之一）', count: meta => meta.summary.any },
]

export function PromotionStackingPanel() {
  const [flag, setFlag] = useState<StackingFlag | undefined>()
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState<string | undefined>()
  const [meta, setMeta] = useState<Meta | null>(null)

  const fetchPage = useCallback<CursorFetcher<StackingRowView>>(
    async ({ cursor, limit, sort, signal }) => {
      const path = buildPath('/promotions/stacking', { flag, q, sort: sort ? `${sort.field}:${sort.direction}` : undefined, pageSize: limit, cursor: cursor ?? undefined })
      const response = await apiFetch<StackingResponse>(path, { signal })
      // 汇总与说明以第一块为准（后续块的游标只管翻页）
      if (cursor === null) setMeta({ summary: response.summary, note: response.note, truncated: response.truncated, basis: response.basis, catalogNote: response.catalogNote })
      return { items: response.items, nextCursor: response.pageInfo.hasMore ? response.pageInfo.nextCursor : null, approxTotal: response.pageInfo.approxTotal }
    },
    [flag, q],
  )
  const resetKey = useMemo(() => JSON.stringify([flag, q]), [flag, q])

  return (
    <div data-testid="promotion-stacking">
      <Space size={12} wrap style={{ display: 'flex', marginBottom: 12 }}>
        {CARDS.map(card => {
          const active = flag === card.flag
          return (
            <Card
              key={card.flag}
              size="small"
              hoverable
              role="button"
              tabIndex={0}
              aria-pressed={active}
              aria-label={meta ? `${card.title(meta)}：${card.count(meta)} 个商品` : card.flag}
              data-testid={`stacking-card-${card.flag}`}
              onClick={() => setFlag(active ? undefined : card.flag)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') setFlag(active ? undefined : card.flag)
              }}
              style={{ width: 260, borderColor: active ? 'var(--ant-color-primary)' : undefined }}
            >
              <Statistic title={meta ? card.title(meta) : '读取中'} value={meta ? card.count(meta) : '—'} suffix={meta ? '个商品' : undefined} />
            </Card>
          )
        })}
      </Space>
      {meta ? <Muted>{meta.basis}</Muted> : null}
      {meta?.truncated ? <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="促销或商品行数读到了上限，叠加情况可能不完整。" /> : null}
      <Space wrap style={{ margin: '8px 0', display: 'flex' }}>
        <Input.Search
          allowClear
          aria-label="搜索叠加商品"
          placeholder="搜索 ASIN 或标题"
          style={{ width: 240 }}
          value={keyword}
          onChange={event => setKeyword(event.target.value)}
          onSearch={value => setQ(value.trim() || undefined)}
        />
        {meta ? <Muted>{meta.catalogNote}</Muted> : null}
      </Space>
      <MassiveGrid<StackingRowView>
        gridId="promotions.stacking"
        columns={columns}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        sortableFields={SORTABLE}
        defaultSort={DEFAULT_SORT}
        resetKey={resetKey}
        appliedFilterCount={(flag ? 1 : 0) + (q ? 1 : 0)}
        onClearFilters={() => {
          setFlag(undefined)
          setQ(undefined)
          setKeyword('')
        }}
        emptyState={{ kind: 'empty', domain: '促销叠加', prerequisite: meta?.note ?? '没有进行中或即将开始的商品清单类促销；促销同步后才会显示叠加情况。' }}
        height={520}
      />
    </div>
  )
}
