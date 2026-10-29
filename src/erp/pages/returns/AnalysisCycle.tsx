import { useMemo } from 'react'
import { Descriptions, Segmented, Select, Space, Typography } from 'antd'
import { RETURN_CYCLE_ANCHORS, RETURN_CYCLE_ANCHOR_LABEL, RETURN_CYCLE_DIMENSIONS, RETURN_CYCLE_DIMENSION_LABEL, RETURN_SLICE_ROWS, type ReturnCycleResponse } from '@nova/api-contracts'
import { ChartPanel } from '../../components'
import { formatNumber } from '../../format'
import { useApiQuery } from '../../query/api-query'
import { Muted } from '../inventory/inventory-ui'
import { cycleBucketColumns, cycleSliceColumns } from './analysis-columns'
import { AnalysisHead, BasisNote, TruncatedNote, UnknownNotice, unitsText, type AnalysisParams } from './analysis-shared'
import { CycleBoundsEditor } from './CycleBoundsEditor'
import { LocalGrid } from './returns-local-grid'
import { buildCycleOption } from './returns-options'

// 退货分析·退货周期（P6-13，M-700 至 M-704）：退货日期 − 起点日期（下单日期或发货日期）的整天数，按天数段分桶，给出中位数，
// 可按 ASIN、原因、处置结果切片。缺起点日期的退货不参与，写明“无法计算周期 N 条”，不当作 0 天。

const SLICE_HEADER: Record<string, string> = { asin: 'ASIN', reason: '退货原因', disposition: '处置结果' }

export function AnalysisCycle({ params }: { params: AnalysisParams }) {
  const query = useApiQuery<ReturnCycleResponse>({
    domain: 'analytics',
    path: '/returns/analysis/cycle',
    params: { timeBasis: params.timeBasis, anchor: params.anchor, dimension: params.dimension, bounds: params.bounds },
  })
  const data = query.data
  const option = useMemo(() => buildCycleOption(data?.buckets ?? []), [data?.buckets])
  const sliceColumns = useMemo(() => cycleSliceColumns(SLICE_HEADER[params.dimension] ?? '切片', data?.buckets ?? []), [params.dimension, data?.buckets])
  const emptyText = data?.note ?? '所选日期范围内没有能算出周期的退货。'

  return (
    <div>
      <AnalysisHead data={data} />
      <Space size={16} wrap style={{ margin: '8px 0' }}>
        <Space size={8}>
          <Typography.Text>周期起点</Typography.Text>
          <Segmented
            aria-label="周期起点"
            value={params.anchor}
            onChange={value => params.setAnchor(value as (typeof RETURN_CYCLE_ANCHORS)[number])}
            options={RETURN_CYCLE_ANCHORS.map(value => ({ value, label: RETURN_CYCLE_ANCHOR_LABEL[value] }))}
          />
        </Space>
        <Space size={8}>
          <Typography.Text>切片</Typography.Text>
          <Select
            aria-label="切片维度"
            style={{ width: 140 }}
            value={params.dimension}
            onChange={value => params.setDimension(value)}
            options={RETURN_CYCLE_DIMENSIONS.map(value => ({ value, label: RETURN_CYCLE_DIMENSION_LABEL[value] }))}
          />
        </Space>
        <CycleBoundsEditor current={params.bounds} onApply={params.setBounds} />
      </Space>
      {data ? (
        <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered style={{ margin: '8px 0' }} data-testid="cycle-totals">
          <Descriptions.Item label="参与计算的退货件数">{unitsText(data.totals.units)}</Descriptions.Item>
          <Descriptions.Item label="周期中位数">
            {data.totals.median === null ? <Muted>尚无记录</Muted> : <span className="erp-num">{formatNumber(data.totals.median, { digits: 1 })} 天</span>}
          </Descriptions.Item>
          <Descriptions.Item label="周期起点">{RETURN_CYCLE_ANCHOR_LABEL[data.anchor]}</Descriptions.Item>
        </Descriptions>
      ) : null}
      <UnknownNotice data={data} what="无法计算周期" />
      <TruncatedNote show={data?.truncated} />
      <ChartPanel
        title="退货周期分布"
        ariaLabel="退货周期分布图"
        option={option}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={data && data.totals.units === 0 ? { kind: 'empty', domain: '退货周期', prerequisite: emptyText } : undefined}
      />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        天数段
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.cycle-buckets"
        columns={cycleBucketColumns}
        rows={data?.buckets}
        getRowId={row => row.key}
        emptyState={{ kind: 'empty', domain: '退货周期', prerequisite: emptyText }}
        height={300}
      />
      {params.dimension !== 'none' ? (
        <>
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            按{RETURN_CYCLE_DIMENSION_LABEL[params.dimension].replace('按 ', '')}切片（最多 {RETURN_SLICE_ROWS} 行，其余并入“其他”）
          </Typography.Title>
          <LocalGrid
            gridId={`returns.analysis.cycle-slices.${params.dimension}`}
            columns={sliceColumns}
            rows={data?.slices}
            getRowId={row => row.key}
            emptyState={{ kind: 'empty', domain: '退货周期', prerequisite: emptyText }}
            height={420}
          />
        </>
      ) : null}
      <BasisNote text={data?.basis} />
    </div>
  )
}
