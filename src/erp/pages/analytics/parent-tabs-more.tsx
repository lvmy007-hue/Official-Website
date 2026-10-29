import { useCallback, useState } from 'react'
import { Alert, Space, Tag } from 'antd'
import {
  COVERAGE_LABEL,
  type CoverageState,
  type ParentAdsResponse,
  type ParentAdsRow,
  type ParentChange,
  type ParentChangesResponse,
  type ParentInventoryResponse,
  type ParentInventoryRow,
  type ParentReviewsResponse,
} from '@nova/api-contracts'
import { LocalGrid, MassiveGrid, MetricStrip, renderColumn, RIGHT_ALIGNED, type CursorFetcher, type ErpColDef } from '../../components'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '../../format'
import { apiFetch } from '../../../api'
import { buildPath } from '../../query/api-query'
import { useScope } from '../../scope/context'
import { LiveLink, Muted } from '../inventory/inventory-ui'
import { AsinFigure, RiskBadge, StateNote } from './asin-analytics-ui'
import { Frame, StatCard } from './business-reports-ui'
import { useParentQuery } from './parent-tabs-core'

// 父体详情的后四个页签（P4-03）：库存与补货、广告覆盖、评论主题、变体结构变更历史。
// 没有记录写“尚无记录”，没接入写“尚未接入”，没权限写“无权查看”，永远不显示 0；广告覆盖没有数据来源时不把“没数据”当成“没投广告”。

const count = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>)
const ratio = (value: number | null) => (value === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>)
const link = (row: { productId?: string | null; asin: string; title: string | null }) =>
  row.productId ? (
    <LiveLink component="Asin360Page" id={row.productId}>
      {row.title ?? row.asin}
    </LiveLink>
  ) : (
    <span>{row.title ?? row.asin}</span>
  )

const INVENTORY_COLUMNS: ErpColDef<ParentInventoryRow>[] = [
  renderColumn<ParentInventoryRow>(
    '子体',
    'asin',
    row => (
      <span className="erp-cell-stack">
        {link(row)}
        <span className="erp-cell-sub erp-num">
          {row.asin}
          {row.skuCount > 1 ? ` · ${row.skuCount} 个 SKU` : ''}
        </span>
      </span>
    ),
    { width: 240, pin: 'left' },
  ),
  renderColumn<ParentInventoryRow>('可售数量', 'sellable', row => count(row.sellable), { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<ParentInventoryRow>('在途（计入）', 'inbound', row => count(row.inboundCounted), { width: 120, ...RIGHT_ALIGNED }),
  renderColumn<ParentInventoryRow>(
    '可售天数',
    'cover',
    row => (row.daysOfCover === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(row.daysOfCover, { digits: 1 })} 天</span>),
    {
      width: 100,
      ...RIGHT_ALIGNED,
    },
  ),
  renderColumn<ParentInventoryRow>('预计断货日', 'stockout', row => (row.stockoutDate ? <span className="erp-num">{formatDate(row.stockoutDate)}</span> : <Muted>尚无记录</Muted>), { width: 120 }),
  renderColumn<ParentInventoryRow>('库存风险', 'risk', row => <RiskBadge risk={row.risk} />, { width: 160 }),
  renderColumn<ParentInventoryRow>('补货建议数量', 'qty', row => count(row.recommendedQty), { width: 120, ...RIGHT_ALIGNED }),
  renderColumn<ParentInventoryRow>('建议到期日', 'due', row => (row.recommendedDue ? <span className="erp-num">{formatDate(row.recommendedDue)}</span> : <Muted>尚无记录</Muted>), { width: 120 }),
  renderColumn<ParentInventoryRow>('建议渠道', 'channel', row => row.recommendedChannel ?? <Muted>尚无记录</Muted>, { width: 100 }),
]

export function InventoryTab({ parentAsin }: { parentAsin: string }) {
  const query = useParentQuery<ParentInventoryResponse>(parentAsin, 'inventory')
  return (
    <Frame query={query} testId="parent-inventory">
      {data => (
        <>
          <StateNote state={data.policyState} note={data.policyNote} testId="parent-policy-note" />
          <StateNote state={data.replenishmentState} note={data.replenishmentNote} testId="parent-replenishment-note" />
          <LocalGrid<ParentInventoryRow>
            gridId="analytics.parent.inventory"
            columns={INVENTORY_COLUMNS}
            rows={data.rows}
            getRowId={row => row.asin}
            emptyState={{ kind: 'empty', domain: '子体库存', prerequisite: '这个父体名下还没有子体。' }}
            initialPageSize={50}
            height={360}
          />
        </>
      )}
    </Frame>
  )
}

const COVERAGE_COLOR: Record<CoverageState, string> = { COVERED: 'success', NO_SPEND: 'warning', NO_ADS: 'error' }

const ADS_COLUMNS: ErpColDef<ParentAdsRow>[] = [
  renderColumn<ParentAdsRow>(
    '子体',
    'asin',
    row => (
      <span className="erp-cell-stack">
        {link({ ...row, productId: null })}
        <span className="erp-cell-sub erp-num">{row.asin}</span>
      </span>
    ),
    { width: 240, pin: 'left' },
  ),
  renderColumn<ParentAdsRow>(
    '广告覆盖',
    'coverage',
    row => (
      <Space size={4}>
        <Tag color={COVERAGE_COLOR[row.coverage]} bordered={false} style={{ marginInlineEnd: 0 }}>
          {COVERAGE_LABEL[row.coverage]}
        </Tag>
        {row.gap ? (
          <Tag color="volcano" bordered={false} style={{ marginInlineEnd: 0 }}>
            有销售无广告
          </Tag>
        ) : null}
      </Space>
    ),
    { width: 220 },
  ),
  renderColumn<ParentAdsRow>('广告花费', 'spend', row => <AsinFigure metric="adsSales" value={row.spend} />, { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<ParentAdsRow>('广告销售', 'adsSales', row => <AsinFigure metric="adsSales" value={row.adsSales} />, { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<ParentAdsRow>('订单', 'orders', row => count(row.orders), { width: 80, ...RIGHT_ALIGNED }),
  renderColumn<ParentAdsRow>('ACOS', 'acos', row => ratio(row.acos), { width: 80, ...RIGHT_ALIGNED }),
  renderColumn<ParentAdsRow>('总销售额', 'total', row => <AsinFigure metric="sales" value={row.totalSales} />, { width: 100, ...RIGHT_ALIGNED }),
  renderColumn<ParentAdsRow>('广告占比', 'share', row => ratio(row.adsShare), { width: 90, ...RIGHT_ALIGNED }),
  renderColumn<ParentAdsRow>('在投 / 全部广告', 'ads', row => (row.totalAds === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{`${row.enabledAds ?? 0} / ${row.totalAds}`}</span>), {
    width: 140,
    ...RIGHT_ALIGNED,
  }),
]

export function AdsTab({ parentAsin }: { parentAsin: string }) {
  const query = useParentQuery<ParentAdsResponse>(parentAsin, 'ads')
  return (
    <Frame query={query} testId="parent-ads">
      {data =>
        data.adsState !== 'OK' ? (
          <StateNote state={data.adsState} note={data.adsNote} testId="parent-ads-note" />
        ) : (
          <>
            <MetricStrip>
              <StatCard title="已覆盖子体" testId="parent-ads-covered">
                {count(data.coveredCount)}
              </StatCard>
              <StatCard title="覆盖缺口（有销售无广告）" testId="parent-ads-gap">
                {count(data.gapCount)}
              </StatCard>
              <StatCard title="广告花费">
                <AsinFigure metric="adsSales" value={data.totalSpend} />
              </StatCard>
              <StatCard title="广告销售">
                <AsinFigure metric="adsSales" value={data.totalAdsSales} />
              </StatCard>
            </MetricStrip>
            <StateNote state="OK" note={data.adsNote} testId="parent-ads-basis" />
            <LocalGrid<ParentAdsRow>
              gridId="analytics.parent.ads"
              columns={ADS_COLUMNS}
              rows={data.rows}
              getRowId={row => row.asin}
              emptyState={{ kind: 'empty', domain: '广告覆盖', prerequisite: '这个父体名下还没有子体。' }}
              initialPageSize={50}
              height={360}
            />
          </>
        )
      }
    </Frame>
  )
}

export function ReviewsTab({ parentAsin }: { parentAsin: string }) {
  const query = useParentQuery<ParentReviewsResponse>(parentAsin, 'reviews')
  return (
    <Frame query={query} testId="parent-reviews">
      {data => (
        <div data-testid="parent-reviews-body">
          <StateNote state={data.reviewsState} note={data.reviewsNote} testId="parent-reviews-note" />
          {data.positive.length + data.negative.length === 0 ? <Muted>暂无评论主题</Muted> : null}
        </div>
      )}
    </Frame>
  )
}

const CHANGE_COLUMNS: ErpColDef<ParentChange>[] = [
  renderColumn<ParentChange>('时间', 'time', row => <span className="erp-num">{formatDateTime(row.occurredAt)}</span>, { width: 170, pin: 'left' }),
  renderColumn<ParentChange>(
    '类型',
    'kind',
    row => (
      <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
        {row.kindLabel}
      </Tag>
    ),
    { width: 120 },
  ),
  renderColumn<ParentChange>('变更', 'title', row => row.title, { width: 320 }),
  renderColumn<ParentChange>(
    '前 → 后',
    'diff',
    row => (row.before === null && row.after === null ? <Muted>—</Muted> : <span className="erp-num">{`${row.before ?? '无'} → ${row.after ?? '无'}`}</span>),
    {
      width: 240,
    },
  ),
  renderColumn<ParentChange>('来源', 'actor', row => row.actor, { width: 100 }),
]

export function ChangesTab({ parentAsin }: { parentAsin: string }) {
  const { apiParams } = useScope()
  const [meta, setMeta] = useState<Pick<ParentChangesResponse, 'truncated' | 'note'> | null>(null)
  const fetchPage = useCallback<CursorFetcher<ParentChange>>(
    async ({ cursor, limit, signal }) => {
      const params = { ...apiParams, pageSize: String(limit), cursor: cursor ?? undefined }
      const data = await apiFetch<ParentChangesResponse>(buildPath(`/analytics/parents/${encodeURIComponent(parentAsin)}/changes`, params), { signal })
      if (cursor === null) setMeta({ truncated: data.truncated, note: data.note })
      return { items: data.items, nextCursor: data.pageInfo.hasMore ? data.pageInfo.nextCursor : null, approxTotal: data.pageInfo.approxTotal }
    },
    [apiParams, parentAsin],
  )
  return (
    <div data-testid="parent-changes">
      {meta?.truncated ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="变更记录超过读取上限，只显示最近的部分" /> : null}
      <MassiveGrid<ParentChange>
        gridId="analytics.parent.changes"
        columns={CHANGE_COLUMNS}
        fetchPage={fetchPage}
        getRowId={row => row.id}
        resetKey={JSON.stringify([apiParams, parentAsin])}
        emptyState={{ kind: 'empty', domain: '变体结构变更', prerequisite: meta?.note ?? '没有变更记录' }}
        height={420}
      />
    </div>
  )
}
