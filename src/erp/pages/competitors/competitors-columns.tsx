import type { ReactNode } from 'react'
import { Space, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { COMPETITOR_FEATURED_LABEL, COMPETITOR_REASON_LABEL, type CompetitorRow } from '@nova/api-contracts'
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '../../format'
import { AppLink } from '../../nav/AppLink'
import { moneyCell, percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'
import { FEATURED_COLOR, detailPath, detailSearch } from './competitors-state'

// 竞品列表的列（05 章 5.6）：没有记录写“尚无记录”，不补 0。点击份额是下限（热门搜索词只给点击前三的份额），带“下限”标签。

const NONE = <Muted>尚无记录</Muted>

const signed = (value: number | null, currency: string): ReactNode => (value === null ? NONE : <span className="erp-num">{formatMoney(value, currency, { digits: 2, sign: true })}</span>)

const rankCell = (rank: number | null, name: string | null): ReactNode =>
  rank === null ? (
    NONE
  ) : (
    <Tooltip title={name ?? undefined}>
      <span className="erp-num">{formatNumber(rank, { digits: 0 })}</span>
    </Tooltip>
  )

export function competitorColumns(actions: { onRemove: (row: CompetitorRow) => ReactNode }): ColumnsType<CompetitorRow> {
  return [
    {
      title: '竞品',
      key: 'competitor',
      fixed: 'left',
      width: 300,
      render: (_v, row) => (
        <div>
          <AppLink to={detailPath(row.asin)} search={detailSearch(row.storeId, row.ownAsin)}>
            {row.title ?? row.asin}
          </AppLink>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.asin} · {row.brand ?? '品牌尚无记录'} · {row.storeName}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: '对应我方商品',
      key: 'own',
      width: 210,
      render: (_v, row) =>
        row.ownAsin ? (
          <div>
            <div style={{ fontSize: 12 }}>{row.ownTitle ?? '商品目录里没有标题'}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.ownAsin}
            </Typography.Text>
          </div>
        ) : (
          <Muted>未指定</Muted>
        ),
    },
    { title: '竞品价格', key: 'price', width: 110, render: (_v, row) => moneyCell(row.price, row.currency) },
    { title: '我方价格', key: 'ownPrice', width: 110, render: (_v, row) => (row.ownAsin ? moneyCell(row.ownPrice, row.currency) : <Muted>未指定</Muted>) },
    { title: '价格差', key: 'priceGap', width: 110, render: (_v, row) => signed(row.priceGap, row.currency) },
    {
      title: '价格差占比',
      key: 'priceGapPct',
      width: 100,
      render: (_v, row) => (row.priceGapPct === null ? NONE : <span className="erp-num">{formatPercent(row.priceGapPct, { digits: 1, sign: true })}</span>),
    },
    {
      title: '推荐报价',
      key: 'featured',
      width: 120,
      render: (_v, row) =>
        row.featured ? (
          <Tag color={FEATURED_COLOR[row.featured]} bordered={false}>
            {COMPETITOR_FEATURED_LABEL[row.featured]}
          </Tag>
        ) : (
          NONE
        ),
    },
    { title: '配送', key: 'fulfillment', width: 80, render: (_v, row) => row.fulfillment ?? NONE },
    {
      title: '会员资格',
      key: 'member',
      width: 100,
      render: (_v, row) => (row.memberEligible === null ? NONE : row.memberEligible ? '会员可享' : '会员不可享'),
    },
    { title: '销售排名', key: 'rank', width: 100, render: (_v, row) => rankCell(row.rank, row.rankName) },
    {
      title: '名次差',
      key: 'rankGap',
      width: 110,
      render: (_v, row) =>
        row.rankGap === null ? (
          <Tooltip title={row.rankNote ?? undefined}>
            <span>{NONE}</span>
          </Tooltip>
        ) : (
          <span className="erp-num">{formatNumber(row.rankGap, { digits: 0, sign: true })}</span>
        ),
    },
    {
      title: '核心词点击份额',
      key: 'clickShare',
      width: 150,
      render: (_v, row) =>
        row.clickShare === null ? (
          NONE
        ) : (
          <Tooltip title={row.clickShareTerms ? `在我方 ${row.clickShareTerms.total} 个核心词中的 ${row.clickShareTerms.hit} 个里进入点击前三` : undefined}>
            <Space size={4}>
              {percentCell(row.clickShare)}
              <Tag bordered={false}>下限</Tag>
            </Space>
          </Tooltip>
        ),
    },
    {
      title: '来源',
      key: 'reason',
      width: 150,
      render: (_v, row) => (
        <span style={{ fontSize: 12 }}>
          {COMPETITOR_REASON_LABEL[row.reason]}
          {row.reasonNote ? `：${row.reasonNote}` : ''}
        </span>
      ),
    },
    { title: '最近同步', key: 'observedAt', width: 150, render: (_v, row) => (row.observedAt ? formatDateTime(row.observedAt) : <Muted>等待首次同步</Muted>) },
    { title: '操作', key: 'actions', fixed: 'right', width: 90, render: (_v, row) => actions.onRemove(row) },
  ]
}
