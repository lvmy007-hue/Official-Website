import type { ReactNode } from 'react'
import { Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  SOLICITATION_STATUS_LABEL,
  type EligibleOrderRow,
  type ImprovementRow,
  type RatingGrowthRow,
  type RatingRow,
  type ReturnTopicRow,
  type SolicitCoverage,
  type SolicitationStatus,
  type TopicRow,
} from '@nova/api-contracts'
import { formatDate, formatDateTime, formatNumber, formatPercent } from '../../format'
import { ratingTrendText } from './reviews-options'
import { ratingSourceText, signedNumber } from './reviews-state'
import { Muted, NONE, ProductCell, countOrNone, numberOrNone } from './reviews-ui'

// 评价与反馈各表格的列：没有记录写“尚无记录”，不补 0；评分来源每行都标注（文件导入 · 文件名 · 导入人）。

const percent = (value: number | null): ReactNode => (value === null ? NONE : <span className="erp-num">{formatPercent(value, { digits: 1 })}</span>)

function deltaCell(row: RatingRow): ReactNode {
  if (row.previousDate === null) return <Muted>只有一次采集</Muted>
  if (row.ratingDelta === null && row.countDelta === null) return NONE
  return (
    <div>
      <div>星级 {row.ratingDelta === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{signedNumber(row.ratingDelta, 2)}</span>}</div>
      <div>评分数 {row.countDelta === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{signedNumber(row.countDelta, 0)}</span>}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        对比 {formatDate(row.previousDate)}
      </Typography.Text>
    </div>
  )
}

export const ratingColumns: ColumnsType<RatingRow> = [
  { title: '店铺', key: 'store', width: 130, dataIndex: 'storeName' },
  { title: 'ASIN', key: 'asin', width: 280, render: (_v, row) => <ProductCell asin={row.asin} title={row.title} /> },
  { title: '平均星级', key: 'avg', width: 100, render: (_v, row) => numberOrNone(row.avgRating, 2) },
  { title: '评分数', key: 'count', width: 100, render: (_v, row) => numberOrNone(row.ratingCount) },
  { title: '较上次变化', key: 'delta', width: 140, render: (_v, row) => deltaCell(row) },
  { title: '采集日期', key: 'date', width: 110, render: (_v, row) => formatDate(row.captureDate) },
  { title: '来源', key: 'source', width: 280, render: (_v, row) => <span style={{ fontSize: 12 }}>{ratingSourceText(row)}</span> },
  {
    title: '最近趋势',
    key: 'trend',
    width: 200,
    render: (_v, row) => {
      const text = ratingTrendText(row.trend)
      return text ? (
        <span className="erp-num" title={`最近 ${row.trend.length} 次采集的平均星级，旧到新`}>
          {text}
        </span>
      ) : (
        NONE
      )
    },
  },
]

export const topicColumns: ColumnsType<TopicRow> = [
  { title: '名次', key: 'rank', width: 70, render: (_v, row) => <span className="erp-num">{row.rank}</span> },
  { title: '主题', key: 'topic', dataIndex: 'topic' },
  {
    title: '提及量（区间）',
    key: 'mention',
    width: 170,
    render: (_v, row) =>
      row.mentionRange === null && row.reviewCountBucket === null ? (
        NONE
      ) : (
        <div>
          <div>{row.mentionRange ?? NONE}</div>
          {row.reviewCountBucket ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              评论数 {row.reviewCountBucket}
            </Typography.Text>
          ) : null}
        </div>
      ),
  },
  { title: '类目全部商品占比', key: 'all', width: 150, render: (_v, row) => percent(row.categoryAll) },
  { title: '类目前 25% 占比', key: 'top', width: 150, render: (_v, row) => percent(row.categoryTop) },
]

export const returnTopicColumns: ColumnsType<ReturnTopicRow> = [
  { title: '退货主题', key: 'topic', dataIndex: 'topic' },
  { title: '最近一月', key: 'month', width: 110, render: (_v, row) => row.latestMonth.slice(0, 7) },
  { title: '全部商品占比', key: 'all', width: 140, render: (_v, row) => percent(row.rateAll) },
  { title: '前 25% 商品占比', key: 'top', width: 150, render: (_v, row) => percent(row.rateTop) },
]

/** 改进清单的列；“指派跟进”按钮由页面传入（含弹窗）。 */
export function improvementColumns(renderAssign: (row: ImprovementRow) => ReactNode, days: number): ColumnsType<ImprovementRow> {
  return [
    { title: '店铺', key: 'store', width: 120, dataIndex: 'storeName' },
    { title: 'ASIN', key: 'asin', width: 240, render: (_v, row) => <ProductCell asin={row.asin} title={row.title} /> },
    {
      title: '负面评论主题',
      key: 'topics',
      width: 220,
      render: (_v, row) =>
        row.negativeTopics.length === 0 ? (
          NONE
        ) : (
          <div style={{ fontSize: 12 }}>
            {row.negativeTopics.map(item => (
              <div key={item.topic}>
                {item.topic}
                {item.mentionRange ? `（${item.mentionRange}）` : ''}
              </div>
            ))}
          </div>
        ),
    },
    {
      title: `近 ${days} 天退货`,
      key: 'returns',
      width: 240,
      render: (_v, row) =>
        row.returnUnits > 0 ? (
          <div style={{ fontSize: 12 }}>
            <div>
              <span className="erp-num">{formatNumber(row.returnUnits, { digits: 0 })}</span> 件
            </div>
            {row.returnReasons.map(item => (
              <div key={item.code}>
                {item.label} {formatNumber(item.units, { digits: 0 })} 件（{formatPercent(item.share, { digits: 0 })}）
              </div>
            ))}
          </div>
        ) : (
          NONE
        ),
    },
    {
      title: '可能相关',
      key: 'related',
      width: 100,
      render: (_v, row) =>
        row.possiblyRelated ? (
          <Tag color="warning" bordered={false} title="主题与退货原因文字有重合，只做文字比对，不代表因果">
            可能相关
          </Tag>
        ) : (
          <Muted>文字无重合</Muted>
        ),
    },
    { title: '建议', key: 'suggestion', width: 320, render: (_v, row) => <span style={{ fontSize: 12 }}>{row.suggestion}</span> },
    { title: '操作', key: 'actions', width: 110, fixed: 'right', render: (_v, row) => renderAssign(row) },
  ]
}

export const coverageColumns: ColumnsType<SolicitCoverage> = [
  { title: '店铺', key: 'store', dataIndex: 'storeName' },
  { title: '近 90 天已送达订单', key: 'delivered', width: 160, render: (_v, row) => numberOrNone(row.deliveredOrders > 0 ? row.deliveredOrders : null) },
  { title: '已请求订单', key: 'requested', width: 120, render: (_v, row) => countOrNone(row.requestedOrders) },
  { title: '请求覆盖率', key: 'coverage', width: 150, render: (_v, row) => (row.coverage === null ? <Muted>尚无已送达订单</Muted> : percent(row.coverage)) },
  { title: '当前可请求', key: 'eligible', width: 110, render: (_v, row) => countOrNone(row.eligibleNow) },
]

const count = (value: number | null, date: string | null): ReactNode =>
  value === null ? (
    NONE
  ) : (
    <span>
      <span className="erp-num">{formatNumber(value, { digits: 0 })}</span>
      {date ? <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>（{formatDate(date)}）</span> : null}
    </span>
  )

export const growthColumns: ColumnsType<RatingGrowthRow> = [
  { title: 'ASIN', key: 'asin', width: 260, render: (_v, row) => <ProductCell asin={row.asin} title={row.title} storeName={row.storeName} /> },
  { title: '请求订单数', key: 'orders', width: 100, render: (_v, row) => numberOrNone(row.requestedOrders) },
  { title: '请求前评分数', key: 'before', width: 160, render: (_v, row) => count(row.beforeCount, row.beforeDate) },
  { title: '请求后评分数', key: 'after', width: 160, render: (_v, row) => count(row.afterCount, row.afterDate) },
  {
    title: '增长',
    key: 'delta',
    render: (_v, row) => (row.delta === null ? <Muted>{row.note ?? '尚无记录'}</Muted> : <span className="erp-num">{signedNumber(row.delta, 0)}</span>),
  },
]

export const eligibleColumns: ColumnsType<EligibleOrderRow> = [
  { title: '店铺', key: 'store', width: 130, dataIndex: 'storeName' },
  { title: '订单号', key: 'order', width: 190, render: (_v, row) => <span className="erp-num">{row.amazonOrderId}</span> },
  { title: '下单日期', key: 'purchase', width: 110, render: (_v, row) => formatDate(row.purchaseDate) },
  { title: '送达日期', key: 'delivered', width: 110, render: (_v, row) => formatDate(row.deliveredAt) },
  {
    title: '送达后进度',
    key: 'days',
    width: 190,
    render: (_v, row) => (
      <Space size={4} wrap>
        <span>送达后第 {row.dayAfterDelivery} 天</span>
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>{row.daysLeft === 0 ? '今天是最后一天' : `剩余 ${row.daysLeft} 天`}</span>
      </Space>
    ),
  },
  { title: 'ASIN', key: 'asins', render: (_v, row) => (row.asins.length === 0 ? NONE : <span style={{ fontSize: 12 }}>{row.asins.join('、')}</span>) },
  {
    title: '上次状态',
    key: 'last',
    width: 190,
    render: (_v, row) =>
      row.lastStatus === 'FAILED' ? (
        <Tag color="error" bordered={false}>
          发送失败，可再次请求
        </Tag>
      ) : row.lastStatus ? (
        <span>{SOLICITATION_STATUS_LABEL[row.lastStatus]}</span>
      ) : (
        <Muted>尚未请求</Muted>
      ),
  },
]

const STATUS_COLOR: Record<SolicitationStatus, string> = { QUEUED: 'processing', REQUESTED: 'success', UNAVAILABLE: 'default', WINDOW_CLOSED: 'default', FAILED: 'error' }

export type RecentRequest = { amazonOrderId: string; storeName: string; status: SolicitationStatus; requestedAt: string; failureCode: string | null }

export const recentColumns: ColumnsType<RecentRequest> = [
  { title: '订单号', key: 'order', width: 190, render: (_v, row) => <span className="erp-num">{row.amazonOrderId}</span> },
  { title: '店铺', key: 'store', width: 130, dataIndex: 'storeName' },
  {
    title: '状态',
    key: 'status',
    width: 170,
    render: (_v, row) => (
      <Tag color={STATUS_COLOR[row.status]} bordered={false}>
        {SOLICITATION_STATUS_LABEL[row.status]}
      </Tag>
    ),
  },
  { title: '请求时间', key: 'at', width: 190, render: (_v, row) => formatDateTime(row.requestedAt) },
  { title: '失败代码', key: 'code', render: (_v, row) => (row.failureCode ? <span className="erp-num">{row.failureCode}</span> : <Muted>无</Muted>) },
]
