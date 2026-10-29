import { useMemo, useRef, useState } from 'react'
import { Segmented, Select, Space, Typography } from 'antd'
import { REVIEWS_RETURNS_BASIS, REVIEW_TREND_SCOPES, REVIEW_TREND_SCOPE_LABEL, type ReturnTopicRow, type ReturnsTabResponse, type ReviewTrendScope } from '@nova/api-contracts'
import { ChartPanel, DataState, FreshnessBar, SimpleGrid } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { ImprovementTable } from './ImprovementTable'
import { returnTopicColumns } from './reviews-columns'
import { buildReturnTrendOption } from './reviews-options'
import { pairValue, splitPair, type SelectionProps } from './reviews-state'
import { Basis, Muted, SectionNote } from './reviews-ui'

// 退货主题（P4-13，05 章 5.7）：退货主题只到类目级（接口没有商品级退货主题）——所选类目（浏览节点）近 6 个月的退货主题占比，分“全部商品”“前 25% 商品”两档；
// 下面是产品改进清单：把商品最新的负面评论主题与近 90 天的退货原因放在一起，可以一键生成待办指派跟进。没有数据写“尚无记录”，不补 0。

export function ReturnsPanel({ storeId, nodeId, onSelect }: SelectionProps) {
  const [scope, setScope] = useState<ReviewTrendScope>('ALL')
  const query = useApiQuery<ReturnsTabResponse>({ domain: 'list', path: '/reviews', params: { tab: 'returns', storeId, nodeId } })
  const data = query.data
  // 换类目重新读取期间，选择框与改进清单沿用上一次的结果（改进清单与类目无关）
  const last = useRef<ReturnsTabResponse>()
  if (data) last.current = data
  const shell = data ?? last.current
  const node = data?.selectedNode ?? null
  const value = node ? pairValue(node.storeId, node.browseNodeId) : storeId && nodeId ? pairValue(storeId, nodeId) : undefined
  const chart = useMemo(() => (node ? buildReturnTrendOption(node.topics, node.months, scope) : null), [node, scope])
  const hasSeries = Boolean(node && node.months.length > 0 && node.topics.some(topic => topic.series.length > 0))

  return (
    <div data-testid="returns-panel">
      <FreshnessBar freshness={shell?.freshness ?? null} />
      <SectionNote state={shell?.state ?? 'OK'} note={shell?.note ?? null} />
      <Space wrap style={{ marginBottom: 8 }}>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: 460 }}
          placeholder="选择类目"
          aria-label="退货类目"
          value={value}
          virtual={false}
          options={(shell?.nodes ?? []).map(item => ({
            value: pairValue(item.storeId, item.browseNodeId),
            label: `${item.browseNodeName ?? item.browseNodeId} · ${item.storeName} · ${item.asinCount} 个商品`,
          }))}
          onChange={next => {
            const pair = splitPair(next)
            if (pair) onSelect({ storeId: pair[0], nodeId: pair[1] })
          }}
        />
        {node ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>
            类目：{node.browseNodeName ?? node.browseNodeId}（{node.storeName}）
          </span>
        ) : null}
      </Space>
      {!data && query.isFetching ? <DataState kind="skeleton" rows={4} /> : null}
      {node ? (
        <>
          <Typography.Title level={5}>类目退货主题（最近一个月占比）</Typography.Title>
          <SimpleGrid<ReturnTopicRow>
            gridId="reviews.returns-panel"
            columns={returnTopicColumns}
            rows={node.topics}
            rowKey={row => row.topic}
            emptyState={{ kind: 'empty', domain: '类目退货主题', prerequisite: '这个类目最近一次同步没有退货主题。' }}
          />
          <Space wrap style={{ margin: '16px 0 8px' }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              类目近 6 个月退货主题趋势
            </Typography.Title>
            <Segmented
              aria-label="趋势档位"
              value={scope}
              options={REVIEW_TREND_SCOPES.map(item => ({ value: item, label: REVIEW_TREND_SCOPE_LABEL[item] }))}
              onChange={next => setScope(next as ReviewTrendScope)}
            />
          </Space>
          {chart && hasSeries ? (
            <ChartPanel title={`${REVIEW_TREND_SCOPE_LABEL[scope]}：退货主题占比`} ariaLabel="类目退货主题趋势" option={chart} height={280} />
          ) : (
            <p data-testid="return-trend-empty">
              <Muted>尚无记录：还没有同步到这个类目的退货主题趋势。</Muted>
            </p>
          )}
        </>
      ) : null}
      {data && !node && data.state === 'OK' ? (
        <p>
          <Muted>尚无记录：还没有同步到类目退货主题。</Muted>
        </p>
      ) : null}
      {query.isError ? <Typography.Text type="danger">读取退货主题失败，请稍后重试</Typography.Text> : null}
      <Typography.Title level={5} style={{ marginTop: 24 }}>
        产品改进清单
      </Typography.Title>
      {shell ? <ImprovementTable improvements={shell.improvements} /> : null}
      <Basis>{shell?.basis ?? REVIEWS_RETURNS_BASIS}</Basis>
    </div>
  )
}
