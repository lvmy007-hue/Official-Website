import { useMemo } from 'react'
import { Typography } from 'antd'
import type { ReturnDispositionMatrixResponse } from '@nova/api-contracts'
import { useApiQuery } from '../../query/api-query'
import { matrixColumns, matrixRows } from './analysis-columns'
import { AnalysisHead, BasisNote, UnknownNotice, unitsText, type AnalysisParams } from './analysis-shared'
import { LocalGrid } from './returns-local-grid'

// 退货分析·库存属性 × 处置结果（P6-13）：行是退货件的库存属性（可售、损坏、承运人损坏等处置分组），列是退货报告里的处理状态原文
// （例如 Unit returned to inventory），格子是退货件数。用来看“可售的件有多少真的回到了可售库存”“损坏的件主要卡在哪个状态”。

export function AnalysisMatrix({ params }: { params: AnalysisParams }) {
  const query = useApiQuery<ReturnDispositionMatrixResponse>({ domain: 'analytics', path: '/returns/analysis/disposition-matrix', params: { timeBasis: params.timeBasis } })
  const data = query.data
  const columns = useMemo(() => matrixColumns('库存属性 \\ 处置结果', data?.columns.map(column => column.label) ?? [], { group: '处置结果（报告处理状态）' }), [data?.columns])
  const rows = useMemo(() => (data ? matrixRows(data.rows, data.cells) : undefined), [data])

  return (
    <div>
      <AnalysisHead data={data} />
      {data ? <Typography.Paragraph style={{ margin: '8px 0 0' }}>合计退货件数：{unitsText(data.totals.units)}</Typography.Paragraph> : null}
      <UnknownNotice data={data} what="缺下单时间、不能按下单时间统计的退货" />
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        库存属性 × 处置结果（件）
      </Typography.Title>
      <LocalGrid
        gridId="returns.analysis.disposition-matrix"
        columns={columns}
        rows={rows}
        getRowId={row => row.key}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyState={{ kind: 'empty', domain: '库存属性与处置结果', prerequisite: data?.note ?? '所选日期范围内尚无退货记录。' }}
        height={380}
      />
      <BasisNote text={data?.basis} />
    </div>
  )
}
