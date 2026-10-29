import { useMemo, useRef, useState } from 'react'
import { Segmented, Select, Space, Typography } from 'antd'
import { REVIEWS_TOPICS_BASIS, REVIEW_SENTIMENT_LABEL, REVIEW_SENTIMENTS, type ReviewSentiment, type TopicRow, type TopicsTabResponse } from '@nova/api-contracts'
import { ChartPanel, DataState, FreshnessBar, SimpleGrid } from '../../components'
import { formatDate } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { topicColumns } from './reviews-columns'
import { buildTopicTrendOption, topicTrendCount } from './reviews-options'
import { pairValue, splitPair, type SelectionProps } from './reviews-state'
import { Basis, Muted, SectionNote } from './reviews-ui'

// 评论主题（P4-13，05 章 5.7）：一个商品最近一次同步的前 10 正面与前 10 负面主题，提及量用接口给的区间原样显示；
// 与所在类目（浏览节点）全部商品、前 25% 商品最近一个月的占比对比，并画类目近 6 个月的主题趋势。
// 来源没接上（NOT_CONNECTED）或不适用写明原因；没有数据写“尚无记录”，不补 0。

function TopicTable({ title, rows, empty }: { title: string; rows: TopicRow[]; empty: string }) {
  return (
    <div style={{ flex: '1 1 520px', minWidth: 0 }} data-testid={`topics-${title}`}>
      <Typography.Title level={5}>{title}主题（前 10）</Typography.Title>
      <SimpleGrid<TopicRow>
        gridId="reviews.topics-panel"
        columns={topicColumns}
        rows={rows}
        rowKey={row => `${row.sentiment}|${row.rank}|${row.topic}`}
        emptyState={{ kind: 'empty', domain: `${title}主题`, prerequisite: empty }}
      />
    </div>
  )
}

export function TopicsPanel({ storeId, asin, onSelect }: SelectionProps) {
  const [sentiment, setSentiment] = useState<ReviewSentiment>('NEGATIVE')
  const query = useApiQuery<TopicsTabResponse>({ domain: 'list', path: '/reviews', params: { tab: 'topics', storeId, asin } })
  const data = query.data
  // 换商品重新读取期间，选择框与口径沿用上一次的结果，避免整块闪烁
  const last = useRef<TopicsTabResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const selected = data?.selected ?? null
  const options = shell?.options ?? []
  const value = selected ? pairValue(selected.storeId, selected.asin) : storeId && asin ? pairValue(storeId, asin) : undefined
  const chart = useMemo(() => (selected ? buildTopicTrendOption(selected.trend, selected.trendMonths, sentiment) : null), [selected, sentiment])
  const lines = selected ? topicTrendCount(selected.trend, sentiment) : 0

  return (
    <div data-testid="topics-panel">
      <FreshnessBar freshness={shell?.freshness ?? null} />
      <SectionNote state={shell?.state ?? 'OK'} note={shell?.note ?? null} />
      <Space wrap style={{ marginBottom: 8 }}>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: 460 }}
          placeholder="选择商品"
          aria-label="评论商品"
          value={value}
          virtual={false}
          options={options.map(item => ({ value: pairValue(item.storeId, item.asin), label: `${item.asin} · ${item.title ?? '标题尚无记录'} · ${item.storeName}` }))}
          onChange={next => {
            const pair = splitPair(next)
            if (pair) onSelect({ storeId: pair[0], asin: pair[1] })
          }}
        />
        {selected ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>
            主题快照日期 {formatDate(selected.snapshotDate)}；所在类目：{selected.browseNodeName ?? selected.browseNodeId ?? '尚无记录'}
          </span>
        ) : null}
      </Space>
      {selected ? (
        <>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <TopicTable title="正面" rows={selected.positive} empty="这个商品最近一次同步没有正面评论主题。" />
            <TopicTable title="负面" rows={selected.negative} empty="这个商品最近一次同步没有负面评论主题。" />
          </div>
          <Space wrap style={{ margin: '16px 0 8px' }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              类目近 6 个月主题趋势
            </Typography.Title>
            <Segmented
              aria-label="趋势情感"
              value={sentiment}
              options={REVIEW_SENTIMENTS.map(item => ({ value: item, label: REVIEW_SENTIMENT_LABEL[item] }))}
              onChange={next => setSentiment(next as ReviewSentiment)}
            />
          </Space>
          {selected.categoryNote ? <Muted>{selected.categoryNote}</Muted> : null}
          {lines === 0 ? (
            <p data-testid="topic-trend-empty">
              <Muted>尚无记录：没有同步到这个类目的{REVIEW_SENTIMENT_LABEL[sentiment]}主题趋势（只画这个商品出现过的主题）。</Muted>
            </p>
          ) : null}
          {chart && lines > 0 ? (
            <ChartPanel title={`类目${REVIEW_SENTIMENT_LABEL[sentiment]}主题趋势（占比；实线为全部商品，虚线为前 25% 商品）`} ariaLabel="类目评论主题趋势" option={chart} height={280} />
          ) : null}
        </>
      ) : null}
      {!data && query.isFetching ? <DataState kind="skeleton" rows={4} /> : null}
      {data && !selected && data.state === 'OK' ? (
        <p>
          <Muted>尚无记录：还没有同步到评论主题。</Muted>
        </p>
      ) : null}
      {query.isError ? <Typography.Text type="danger">读取评论主题失败，请稍后重试</Typography.Text> : null}
      <Basis>{shell?.basis ?? REVIEWS_TOPICS_BASIS}</Basis>
    </div>
  )
}
