import { useMemo } from 'react'
import { Alert, Descriptions, Typography } from 'antd'
import { RETURN_RANK_MIN_UNITS, RETURN_ANALYSIS_BASIS, type ReturnSummaryResponse } from '@nova/api-contracts'
import { ChartPanel } from '../../components'
import { useApiQuery } from '../../query/api-query'
import { asinColumns, rankColumns } from './analysis-columns'
import { AnalysisHead, BasisNote, TruncatedNote, UnknownNotice, unitsText, type AnalysisParams } from './analysis-shared'
import { buildTrendOption } from './returns-options'
import { LocalGrid } from './returns-local-grid'
import { rateText } from './returns-ui'

// 退货分析·概览（07 章 7.2 分析视图；P6-13）：退货件数与退货率趋势、按 ASIN 的退货排行、异常榜与改善榜。
// 退货率 = 退货件数 ÷ 销售件数（M-310）；销售件数没有汇总时写“尚无记录”，不写 0%。可切换“按退货时间 / 按下单时间”。

export function useSummary(params: Pick<AnalysisParams, 'timeBasis'>) {
  return useApiQuery<ReturnSummaryResponse>({ domain: 'analytics', path: '/returns/analysis/summary', params: { timeBasis: params.timeBasis } })
}

export function AnalysisOverview({ params }: { params: AnalysisParams }) {
  const query = useSummary(params)
  const data = query.data
  const option = useMemo(() => buildTrendOption(data?.trend ?? [], data?.bucket ?? 'WEEK'), [data?.trend, data?.bucket])
  const empty = data?.state === 'NO_DATA' ? { kind: 'empty' as const, domain: '退货', prerequisite: data.note ?? '所选日期范围内尚无退货记录。' } : undefined
  const emptyText = data?.note ?? '所选日期范围内尚无退货记录。'
  const periods = data?.ranks.periods ?? []

  return (
    <div>
      <AnalysisHead data={data} />
      {query.error ? <Alert type="error" showIcon style={{ margin: '8px 0' }} message="退货分析加载失败" action={<a onClick={() => void query.refetch()}>重试</a>} /> : null}
      {data ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ margin: '8px 0' }} data-testid="return-totals">
          <Descriptions.Item label="退货件数">{unitsText(data.totals.returnedUnits)}</Descriptions.Item>
          <Descriptions.Item label="销售件数">{unitsText(data.totals.soldUnits)}</Descriptions.Item>
          <Descriptions.Item label="退货率">{rateText(data.totals.rate)}</Descriptions.Item>
        </Descriptions>
      ) : null}
      <UnknownNotice data={data} what="缺下单时间、不能按下单时间统计的退货" />
      <TruncatedNote show={data?.truncated} />
      <ChartPanel title="退货件数与退货率趋势" ariaLabel="退货件数与退货率趋势图" option={option} loading={query.isPending} emptyState={empty} />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        按 ASIN（退货件数前 20）
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.asin"
        columns={asinColumns}
        rows={data?.byAsin}
        getRowId={row => row.asin}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '退货', prerequisite: emptyText }}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        异常榜与改善榜
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {periods.length === 3 ? `三期等长：${periods.map(item => `${item.label} ${item.from} 至 ${item.to}`).join('；')}。` : ''}
        本期退货 {RETURN_RANK_MIN_UNITS} 件以上才入榜，太少的波动没有意义；退货率没有销售件数时写“尚无记录”。
      </Typography.Paragraph>
      <Typography.Text strong>异常榜（本期比上期增加最多）</Typography.Text>
      <LocalGrid
        gridId="returns.analysis.anomalies"
        columns={rankColumns}
        rows={data?.ranks.anomalies}
        getRowId={row => row.asin}
        emptyState={{ kind: 'empty', domain: '异常榜', prerequisite: '本期没有退货件数明显增加的 ASIN。' }}
        height={360}
      />
      <Typography.Text strong>改善榜（本期比上期减少最多）</Typography.Text>
      <LocalGrid
        gridId="returns.analysis.improvements"
        columns={rankColumns}
        rows={data?.ranks.improvements}
        getRowId={row => row.asin}
        emptyState={{ kind: 'empty', domain: '改善榜', prerequisite: '本期没有退货件数明显减少的 ASIN。' }}
        height={360}
      />
      {data?.ranks.truncated ? <Alert type="warning" showIcon style={{ margin: '8px 0' }} message="榜单可能不完整" description="某一期的 ASIN 数量超过读取上限，请缩小日期范围。" /> : null}
      <BasisNote text={data?.basis ?? RETURN_ANALYSIS_BASIS.summary} />
    </div>
  )
}
