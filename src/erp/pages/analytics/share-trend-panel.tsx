import { useCallback, useMemo } from 'react'
import { Card, Typography } from 'antd'
import { SHARE_TREND_DISCLAIMER, type ShareTrendPoint, type ShareTrendResponse } from '@nova/api-contracts'
import { PagedGrid, numberColumn, percentColumn, textColumn, type PageFetcher } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { describeError } from '../../query/errors'
import { useSession } from '../../session/session'
import { Muted } from '../inventory/inventory-ui'

// 关键词份额趋势（P6-29）：品牌分析搜索查询表现的展示份额与点击份额，固定注明这不是前台排名。

export function ShareTrendPanel({ asin }: { asin: string | undefined }) {
  const { canPermission } = useSession()
  const allowed = canPermission('analytics.read')
  const query = useApiQuery<ShareTrendResponse>({ domain: 'list', path: '/analytics/brand/share-trend', params: { asin }, enabled: allowed && Boolean(asin), scoped: true })
  const points = useMemo(() => query.data?.points ?? [], [query.data])
  const fetchPage = useCallback<PageFetcher<ShareTrendPoint>>(
    async ({ page, pageSize }) => {
      const start = (page - 1) * pageSize
      return { items: points.slice(start, start + pageSize), total: points.length }
    },
    [points],
  )
  const note = !allowed ? '需要分析读取权限才能查看份额趋势。' : query.isLoading ? '正在读取份额趋势…' : query.isError ? describeError(query.error).message : (query.data?.message ?? null)
  return (
    <Card size="small" title="搜索查询表现的份额趋势" style={{ marginTop: 8 }} data-testid="share-trend">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {SHARE_TREND_DISCLAIMER}
      </Typography.Paragraph>
      {note ? <Muted>{note}</Muted> : null}
      {allowed ? (
        <PagedGrid<ShareTrendPoint>
          gridId="analytics.share-trend"
          columns={[
            textColumn('周期开始', 'periodStart'),
            percentColumn('展示份额', 'impressionShare', { digits: 1 }),
            percentColumn('点击份额', 'clickShare', { digits: 1 }),
            numberColumn('搜索量', 'searchVolume'),
          ]}
          fetchPage={fetchPage}
          getRowId={row => row.periodStart}
          resetKey={`${asin ?? ''}:${points.map(point => point.periodStart).join(',')}`}
          emptyState={{ kind: 'empty', domain: '份额趋势', prerequisite: note ?? '尚无记录' }}
          height={260}
        />
      ) : null}
    </Card>
  )
}
