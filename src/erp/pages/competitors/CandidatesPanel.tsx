import { Alert, Space, Tag, Typography } from 'antd'
import { COMPETITORS_WRITE, type CompetitorAddResult, type CompetitorCandidate, type CompetitorCandidatesResponse } from '@nova/api-contracts'
import { ActionGuard, SimpleGrid } from '../../components'
import { formatPercent } from '../../format'
import { useApiMutation, useApiQuery } from '../../query/api-query'
import { percentCell } from '../advertising/ads-campaigns-ui'
import { Muted } from '../inventory/inventory-ui'

// 搜索词推荐（P4-12，05 章 5.6）：最近一个同时有“热门搜索词”和“搜索查询表现”的周里，我方核心搜索词中点击份额前三的非我方商品。
// 点击份额是下限（热门搜索词只给前三，没进前三的词按 0 计）。加入关注只改本系统里的清单。

export function CandidatesPanel({ onAdded }: { onAdded: (result: CompetitorAddResult) => void }) {
  const query = useApiQuery<CompetitorCandidatesResponse>({ domain: 'list', path: '/competitors/candidates' })
  const add = useApiMutation<CompetitorCandidate, CompetitorAddResult>({
    method: 'POST',
    path: '/competitors',
    body: item => ({ storeId: item.storeId, asin: item.asin, ownAsin: item.ownAsin, reason: 'SEARCH_TERM', note: item.terms[0]?.term }),
    invalidate: ['list'],
    silent: true,
    onSuccess: onAdded,
  })
  const data = query.data

  return (
    <div data-testid="competitor-candidates">
      {data && data.state !== 'OK' && data.note ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message={data.note} /> : null}
      {data?.period ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          数据周期：{data.period.start} 起的一周（周报）。已经在关注列表里的、以及我方自己的商品不会出现在这里。
        </Typography.Paragraph>
      ) : null}
      {data?.truncated ? <Alert type="info" showIcon style={{ marginBottom: 8 }} message="候选很多，只显示了在核心词中点击份额最高的前 50 条（或前 20 个店铺）" /> : null}
      <SimpleGrid<CompetitorCandidate>
        gridId="competitors.candidates-panel"
        rows={data?.items}
        rowKey={row => `${row.storeId}|${row.asin}|${row.ownAsin}`}
        loading={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '搜索词推荐', prerequisite: data?.note ?? '还没有可以推荐的竞品；需要品牌分析角色并同步“热门搜索词”和“搜索查询表现”两份周报。' }}
        columns={[
          {
            title: '竞品',
            key: 'asin',
            width: 280,
            render: (_v, row) => (
              <div>
                <div>{row.title ?? row.asin}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.asin} · {row.storeName}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: '对应我方商品',
            key: 'own',
            width: 220,
            render: (_v, row) => (
              <div>
                <div style={{ fontSize: 12 }}>{row.ownTitle ?? '商品目录里没有标题'}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.ownAsin}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: '在核心词中的点击份额',
            key: 'share',
            width: 170,
            render: (_v, row) =>
              row.clickShare === null ? (
                <Muted>尚无记录</Muted>
              ) : (
                <Space size={4}>
                  {percentCell(row.clickShare)}
                  <Tag bordered={false}>下限</Tag>
                </Space>
              ),
          },
          {
            title: '进入点击前三的核心词',
            key: 'terms',
            render: (_v, row) => (
              <span style={{ fontSize: 12 }}>
                {row.terms.map(term => `${term.term}（第 ${term.slot} 位${term.clickShare === null ? '' : `，点击份额 ${formatPercent(term.clickShare, { digits: 1 })}`}）`).join('；')}
                {row.termCount > row.terms.length ? ` 等共 ${row.termCount} 个词` : ''}
              </span>
            ),
          },
          {
            title: '操作',
            key: 'actions',
            width: 110,
            render: (_v, row) => <ActionGuard label="加入关注" guard={{ permission: COMPETITORS_WRITE }} onExecute={() => add.mutateAsync(row)} buttonProps={{ type: 'link', size: 'small' }} />,
          },
        ]}
      />
      {data ? <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{data.basis}</p> : null}
    </div>
  )
}
